//! Mirrors the user's playlists and Liked Songs into SQLite.
//!
//! Playlist contents are only re-downloaded when Spotify's snapshot_id differs from the one
//! we last synced, and commits made by this app update the stored snapshot themselves, so a
//! typical weekly sync costs a handful of requests.

use std::collections::{HashMap, HashSet};

use rusqlite::params;
use tauri::{AppHandle, Emitter};

use crate::db::{self, Db};
use crate::error::AppResult;
use crate::model::{parse_playlist_entry, parse_track, SyncProgress, SyncSummary};
use crate::spotify::Spotify;

fn emit(app: &AppHandle, message: impl Into<String>, done: usize, total: usize) {
    let _ = app.emit(
        "sync-progress",
        SyncProgress {
            message: message.into(),
            done,
            total,
        },
    );
}

/// First guess at a playlist's category from its name. The Playlists screen lets the user
/// fix anything this gets wrong, since Spotify's API doesn't expose folders.
pub fn guess_category(name: &str, owned: bool) -> (&'static str, Option<&'static str>) {
    if !owned {
        return ("ignore", None);
    }
    let n = name.trim().to_lowercase();
    let words: Vec<&str> = n.split_whitespace().collect();
    // "2019 Aug - Sept Memory", "2018 Jan Memories 1+2", "Assorted Pre \"2017 Memories\"": time capsules.
    if words
        .iter()
        .any(|w| matches!(w.trim_matches(|c: char| !c.is_alphanumeric()), "memory" | "memories"))
    {
        return ("memory", None);
    }
    let is_year = |w: &str| w.len() == 4 && w.chars().all(|c| c.is_ascii_digit());
    match words.as_slice() {
        [season, year] if ["winter", "summer", "fall"].contains(season) && is_year(year) => {
            ("semester", None)
        }
        [year, "gold"] if is_year(year) => ("gold", None),
        // e.g. "2018-Present Gold": every Gold song from every year.
        [span, "gold"] if span.ends_with("-present") => ("gold_all", None),
        ["internal"] => ("internal", None),
        ["skimmed", "internal"] => ("skimmed", None),
        ["positive", "pool"] => ("pool", Some("positive")),
        ["negative", "pool"] => ("pool", Some("negative")),
        ["song", "buffer"] => ("ignore", None),
        ["cardio"] => ("exercise", None),
        ["gym", ..] => ("exercise", None),
        _ => ("unsorted", None),
    }
}

pub async fn sync_library(app: &AppHandle, db: &Db, spotify: &Spotify, force: bool) -> AppResult<SyncSummary> {
    let calls_before = db::api_calls_today(&db::lock(db))?;

    // Who am I? Needed to tell owned playlists apart from followed ones.
    let cached_user = db::get_setting(&db::lock(db), "user_id")?;
    let user_id = match cached_user {
        Some(id) => id,
        None => {
            let me = spotify.me().await?;
            let id = me["id"].as_str().unwrap_or_default().to_owned();
            let conn = db::lock(db);
            db::set_setting(&conn, "user_id", &id)?;
            if let Some(name) = me["display_name"].as_str() {
                db::set_setting(&conn, "display_name", name)?;
            }
            id
        }
    };

    emit(app, "Checking your playlists…", 0, 1);
    let lists = spotify.get_all_pages("me/playlists?limit=50").await?;
    {
        let mut conn = db::lock(db);
        let tx = conn.transaction()?;
        tx.execute("UPDATE playlists SET present = 0", [])?;
        for (position, p) in lists.iter().enumerate() {
            let Some(id) = p["id"].as_str() else { continue };
            let name = p["name"].as_str().unwrap_or("Untitled");
            let owned = p["owner"]["id"].as_str() == Some(user_id.as_str())
                || p["collaborative"].as_bool().unwrap_or(false);
            let total = p["items"]["total"]
                .as_i64()
                .or_else(|| p["tracks"]["total"].as_i64())
                .unwrap_or(0);
            let image = p["images"]
                .as_array()
                .and_then(|imgs| imgs.last())
                .and_then(|img| img["url"].as_str());
            let (kind, mood) = guess_category(name, owned);
            // New playlists get a guessed category; existing ones keep what the user chose.
            tx.execute(
                "INSERT INTO playlists (id, name, snapshot_id, owned, total, image_url, kind, mood, list_position, present)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1)
                 ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name, snapshot_id = excluded.snapshot_id, owned = excluded.owned,
                    total = excluded.total, image_url = excluded.image_url,
                    list_position = excluded.list_position, present = 1",
                params![id, name, p["snapshot_id"].as_str(), owned, total, image, kind, mood, position as i64],
            )?;
        }
        tx.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id IN (SELECT id FROM playlists WHERE present = 0)",
            [],
        )?;
        tx.commit()?;
    }

    let to_download: Vec<(String, String, Option<String>)> = {
        let conn = db::lock(db);
        let mut stmt = conn.prepare(
            "SELECT id, name, snapshot_id FROM playlists
             WHERE present = 1 AND owned = 1 AND kind NOT IN ('ignore', 'archive', 'memory')
               AND (?1 OR synced_snapshot_id IS NULL OR synced_snapshot_id != snapshot_id)
             ORDER BY list_position",
        )?;
        let rows = stmt
            .query_map([force], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<_, _>>()?;
        rows
    };

    let total = to_download.len();
    for (i, (id, name, snapshot)) in to_download.iter().enumerate() {
        emit(app, format!("Downloading “{name}”"), i, total);
        let entries = spotify
            .get_all_pages(&format!("playlists/{id}/items?limit=50"))
            .await?;
        let mut conn = db::lock(db);
        let tx = conn.transaction()?;
        // Songs present before this sync, to spot the ones the user pruned.
        let before: HashMap<String, Option<String>> = {
            let mut stmt = tx.prepare("SELECT track_id, added_at FROM playlist_tracks WHERE playlist_id = ?1")?;
            let rows = stmt
                .query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<_, _>>()?;
            rows
        };
        tx.execute("DELETE FROM playlist_tracks WHERE playlist_id = ?1", [id])?;
        let mut now_in: HashSet<String> = HashSet::new();
        for entry in &entries {
            if let Some((track, added_at)) = parse_playlist_entry(entry) {
                db::upsert_track(&tx, &track)?;
                tx.execute(
                    "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, added_at) VALUES (?1, ?2, ?3)",
                    params![id, track.id, added_at],
                )?;
                now_in.insert(track.id);
            }
        }
        let detected = chrono::Utc::now().to_rfc3339();
        for (track_id, added_at) in &before {
            if !now_in.contains(track_id) {
                tx.execute(
                    "INSERT OR IGNORE INTO playlist_removals (playlist_id, track_id, added_at, detected_at)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![id, track_id, added_at, detected],
                )?;
            }
        }
        tx.execute(
            "UPDATE playlists SET synced_snapshot_id = ?2 WHERE id = ?1",
            params![id, snapshot],
        )?;
        tx.commit()?;
    }

    emit(app, "Loading Liked Songs…", total, total);
    let liked = spotify.get_all_pages("me/tracks?limit=50").await?;
    let liked_count = {
        let mut conn = db::lock(db);
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM liked", [])?;
        let mut count = 0;
        for entry in &liked {
            let Some(track) = parse_track(&entry["track"]) else { continue };
            let added_at = entry["added_at"].as_str().unwrap_or_default();
            db::upsert_track(&tx, &track)?;
            tx.execute(
                "INSERT OR REPLACE INTO liked (track_id, added_at) VALUES (?1, ?2)",
                params![track.id, added_at],
            )?;
            count += 1;
        }
        // Staged decisions for songs that were unliked elsewhere no longer apply.
        tx.execute("DELETE FROM staged WHERE track_id NOT IN (SELECT track_id FROM liked)", [])?;
        tx.execute(
            "DELETE FROM liked_override WHERE track_id NOT IN (SELECT track_id FROM liked)",
            [],
        )?;
        db::set_setting(&tx, "last_sync", &chrono::Local::now().to_rfc3339())?;
        tx.commit()?;
        count
    };

    emit(app, "Up to date", total, total);
    let calls_after = db::api_calls_today(&db::lock(db))?;
    Ok(SyncSummary {
        playlists: lists.len(),
        playlists_downloaded: total,
        liked: liked_count,
        api_calls: calls_after - calls_before,
    })
}

#[cfg(test)]
mod tests {
    use super::guess_category;

    #[test]
    fn guesses_categories_from_names() {
        assert_eq!(guess_category("Fall 2026", true).0, "semester");
        assert_eq!(guess_category("Winter 2022", true).0, "semester");
        assert_eq!(guess_category("2026 Gold", true).0, "gold");
        assert_eq!(guess_category("2018-Present Gold", true).0, "gold_all");
        assert_eq!(guess_category("Internal", true).0, "internal");
        assert_eq!(guess_category("Skimmed Internal", true).0, "skimmed");
        assert_eq!(guess_category("positive pool", true), ("pool", Some("positive")));
        assert_eq!(guess_category("Gym Phonk", true).0, "exercise");
        assert_eq!(guess_category("Song Buffer", true).0, "ignore");
        assert_eq!(guess_category("2019 Aug - Sept Memory", true).0, "memory");
        assert_eq!(guess_category("2018 Jan Memories 1+2", true).0, "memory");
        assert_eq!(guess_category("Assorted Pre \"2017 Memories\"", true).0, "memory");
        assert_eq!(guess_category("the moon", true).0, "unsorted");
        assert_eq!(guess_category("Fall 2026", false).0, "ignore");
    }
}
