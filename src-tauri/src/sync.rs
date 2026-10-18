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

/// Playlist downloads per sync are capped at roughly this many requests; bigger jobs (a first sync,
/// or several large playlists edited in Spotify) are spread over later syncs unless the user asks
/// to download them now. Spotify doesn't publish its quota, and a first sync of ~640 requests
/// tripped a 12-hour block on the playlist endpoint.
const SYNC_BUDGET: i64 = 150;
const PAGE: i64 = 50; // Spotify's maximum page size for playlist items

/// Download order: the playlists suggestions depend on first, the huge catch-all ones last.
fn kind_priority(kind: &str) -> i32 {
    match kind {
        "vibe" | "pool" => 0,
        "exercise" | "idea" | "gold" | "gold_all" => 1,
        "semester" => 2,
        "skimmed" => 3,
        "internal" => 4,
        _ => 5,
    }
}

struct Download {
    id: String,
    name: String,
    snapshot: Option<String>,
    total: i64,
    /// Items already stored and the track at the last stored position, when a top-up is possible.
    top_up_from: Option<(i64, String)>,
    cost: i64,
    priority: i32,
}

/// Picks what to download this sync: suggestion-relevant and cheap playlists first, staying
/// within `budget` requests unless `allow_large`. Returns (downloads, deferred count, their cost).
fn plan(mut changed: Vec<Download>, allow_large: bool, budget: i64) -> (Vec<Download>, usize, i64) {
    changed.sort_by_key(|d| (d.priority, d.cost));
    let mut to_download = Vec::new();
    let (mut planned, mut deferred, mut deferred_requests) = (0i64, 0usize, 0i64);
    for d in changed {
        if allow_large || planned + d.cost <= budget {
            planned += d.cost;
            to_download.push(d);
        } else {
            deferred += 1;
            deferred_requests += d.cost;
        }
    }
    (to_download, deferred, deferred_requests)
}

fn pages(items: i64) -> i64 {
    (items.max(1) + PAGE - 1) / PAGE
}

pub async fn sync_library(
    app: &AppHandle,
    db: &Db,
    spotify: &Spotify,
    force: bool,
    allow_large: bool,
) -> AppResult<SyncSummary> {
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

    let changed: Vec<Download> = {
        let conn = db::lock(db);
        let mut stmt = conn.prepare(
            "SELECT p.id, p.name, p.snapshot_id, p.total, p.kind, p.synced_total,
                    (SELECT pt.track_id FROM playlist_tracks pt
                     WHERE pt.playlist_id = p.id AND pt.position = p.synced_total - 1)
             FROM playlists p
             WHERE p.present = 1 AND p.owned = 1 AND p.kind NOT IN ('ignore', 'archive', 'memory')
               AND (?1 OR p.synced_snapshot_id IS NULL OR p.synced_snapshot_id != p.snapshot_id)",
        )?;
        let rows = stmt
            .query_map([force], |r| {
                let total: i64 = r.get(3)?;
                let kind: String = r.get(4)?;
                let synced_total: Option<i64> = r.get(5)?;
                let last: Option<String> = r.get(6)?;
                // Only grew at the end? Then fetching from the last known song onwards is enough.
                let top_up_from = match (force, synced_total, last) {
                    (false, Some(st), Some(last)) if st > 0 && total > st => Some((st, last)),
                    _ => None,
                };
                let cost = match &top_up_from {
                    Some((st, _)) => pages(total - st + 1),
                    None => pages(total),
                };
                Ok(Download {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    snapshot: r.get(2)?,
                    total,
                    top_up_from,
                    cost,
                    priority: kind_priority(&kind),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let (to_download, deferred, deferred_requests) = plan(changed, allow_large, SYNC_BUDGET);

    let total = to_download.len();
    let mut topped_up = 0;
    for (i, d) in to_download.iter().enumerate() {
        let (id, name, snapshot) = (&d.id, &d.name, &d.snapshot);
        if let Some((start, last_known)) = &d.top_up_from {
            emit(app, format!("Adding new songs from “{name}”"), i, total);
            let first_page = spotify
                .get(&format!("playlists/{id}/items?limit={PAGE}&offset={}", start - 1))
                .await?;
            let first = first_page["items"].as_array().and_then(|items| items.first());
            let still_there = first
                .and_then(parse_playlist_entry)
                .is_some_and(|(track, _)| &track.id == last_known);
            if still_there {
                // Everything after the last known song, with its position in the playlist.
                let mut entries: Vec<serde_json::Value> =
                    first_page["items"].as_array().cloned().unwrap_or_default().into_iter().skip(1).collect();
                if let Some(next) = first_page["next"].as_str() {
                    entries.extend(spotify.get_all_pages(next).await?);
                }
                let mut conn = db::lock(db);
                let tx = conn.transaction()?;
                for (k, entry) in entries.iter().enumerate() {
                    if let Some((track, added_at)) = parse_playlist_entry(entry) {
                        db::upsert_track(&tx, &track)?;
                        tx.execute(
                            "INSERT INTO playlist_tracks (playlist_id, track_id, added_at, position) VALUES (?1, ?2, ?3, ?4)
                             ON CONFLICT(playlist_id, track_id) DO UPDATE SET position = excluded.position",
                            params![id, track.id, added_at, start + k as i64],
                        )?;
                    }
                }
                tx.execute(
                    "UPDATE playlists SET synced_snapshot_id = ?2, synced_total = ?3 WHERE id = ?1",
                    params![id, snapshot, d.total],
                )?;
                tx.commit()?;
                topped_up += 1;
                continue;
            }
            // Something earlier changed (removed or reordered): fall back to a full download.
        }
        emit(app, format!("Downloading “{name}”"), i, total);
        let entries = spotify
            .get_all_pages(&format!("playlists/{id}/items?limit={PAGE}"))
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
        for (position, entry) in entries.iter().enumerate() {
            if let Some((track, added_at)) = parse_playlist_entry(entry) {
                db::upsert_track(&tx, &track)?;
                tx.execute(
                    "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, added_at, position) VALUES (?1, ?2, ?3, ?4)",
                    params![id, track.id, added_at, position as i64],
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
            "UPDATE playlists SET synced_snapshot_id = ?2, synced_total = ?3, full_synced_at = ?4 WHERE id = ?1",
            params![id, snapshot, entries.len() as i64, chrono::Utc::now().to_rfc3339()],
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
        playlists_topped_up: topped_up,
        playlists_deferred: deferred,
        deferred_requests,
        liked: liked_count,
        api_calls: calls_after - calls_before,
    })
}

#[cfg(test)]
mod tests {
    use super::guess_category;

    fn dl(name: &str, priority: i32, cost: i64) -> super::Download {
        super::Download {
            id: name.into(), name: name.into(), snapshot: None, total: cost * 50,
            top_up_from: None, cost, priority,
        }
    }

    #[test]
    fn sync_plan_stays_within_budget_and_puts_big_catch_alls_last() {
        let changed = vec![dl("internal", 4, 103), dl("the moon", 0, 1), dl("Fall 2026", 2, 2), dl("skimmed", 3, 32)];
        // 1 + 2 + 32 fit in 100; Internal (103) waits for a later sync.
        let (go, deferred, cost) = super::plan(changed, false, 100);
        let names: Vec<&str> = go.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, ["the moon", "Fall 2026", "skimmed"]);
        assert_eq!((deferred, cost), (1, 103));
        let changed = vec![dl("internal", 4, 103), dl("skimmed", 3, 32), dl("x", 0, 40)];
        let (go, deferred, _) = super::plan(changed, true, 150);
        assert_eq!((go.len(), deferred), (3, 0));
    }

    #[test]
    fn page_counts() {
        assert_eq!((super::pages(0), super::pages(50), super::pages(51), super::pages(5132)), (1, 1, 2, 103));
    }

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
