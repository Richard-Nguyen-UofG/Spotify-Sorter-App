//! The weekly sort: the Liked Songs queue, per-song context and suggestions, staging, and
//! committing staged decisions to Spotify in as few requests as possible.

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{DateTime, Datelike, Local};
use rusqlite::{params, Connection, OptionalExtension};

use crate::db::{self, Db};
use crate::error::{AppError, AppResult};
use crate::model::{CommitSummary, DatedTarget, ExplorePick, QueueItem, Suggestion, SuggestionStats, TrackContext};
use crate::spotify::Spotify;

/// Playlist kinds that reflect a real judgment about the song (as opposed to the defaults).
const KEEPER_KINDS: &str = "'pool','vibe','exercise','idea'";

fn parse_date(s: &str) -> DateTime<Local> {
    DateTime::parse_from_rfc3339(s)
        .map(|d| d.with_timezone(&Local))
        .unwrap_or_else(|_| Local::now())
}

/// Winter = Jan–Apr, Summer = May–Aug, Fall = Sep–Dec.
pub fn semester_name(date: DateTime<Local>) -> String {
    let season = match date.month() {
        1..=4 => "Winter",
        5..=8 => "Summer",
        _ => "Fall",
    };
    format!("{season} {}", date.year())
}

fn liked_at(conn: &Connection, track_id: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT COALESCE(o.added_at, l.added_at) FROM liked l
             LEFT JOIN liked_override o ON o.track_id = l.track_id
             WHERE l.track_id = ?1",
            [track_id],
            |r| r.get(0),
        )
        .optional()?)
}

fn find_playlist(conn: &Connection, kind: &str, name: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT id FROM playlists WHERE present = 1 AND kind = ?1 AND lower(name) = lower(?2) LIMIT 1",
            params![kind, name],
            |r| r.get(0),
        )
        .optional()?)
}

pub fn queue(conn: &Connection) -> AppResult<Vec<QueueItem>> {
    let rows: Vec<(String, String, Option<String>, Option<bool>)> = {
        let mut stmt = conn.prepare(
            "SELECT l.track_id, COALESCE(o.added_at, l.added_at) AS liked_at, s.playlist_ids, s.unlike
             FROM liked l
             LEFT JOIN liked_override o ON o.track_id = l.track_id
             LEFT JOIN staged s ON s.track_id = l.track_id
             ORDER BY liked_at ASC",
        )?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<Result<_, _>>()?;
        rows
    };
    let mut items = Vec::with_capacity(rows.len());
    for (track_id, liked_at, staged, unlike) in rows {
        let Some(track) = db::load_track(conn, &track_id)? else { continue };
        items.push(QueueItem {
            track,
            liked_at,
            staged: staged.and_then(|s| serde_json::from_str(&s).ok()),
            unlike: unlike.unwrap_or(true),
        });
    }
    Ok(items)
}

pub fn track_context(conn: &Connection, track_id: &str) -> AppResult<TrackContext> {
    let liked = liked_at(conn, track_id)?
        .map(|s| parse_date(&s))
        .unwrap_or_else(Local::now);

    let semester_name = semester_name(liked);
    let gold_name = format!("{} Gold", liked.year());

    // Same recording under a different track ID (single vs album) shares an ISRC.
    // Any copy of the recording counts: other releases (same ISRC) and explicit/clean twins.
    let already_in: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT pt.playlist_id FROM playlist_tracks pt
             JOIN playlists p ON p.id = pt.playlist_id
             WHERE p.present = 1 AND pt.track_id = ?1",
        )?;
        let mut found = Vec::new();
        for id in db::same_song_ids(conn, track_id)? {
            for row in stmt.query_map([&id], |r| r.get::<_, String>(0))? {
                let pid = row?;
                if !found.contains(&pid) {
                    found.push(pid);
                }
            }
        }
        found
    };

    let (suggestions, audio_analysed) = blended_suggestions(conn, track_id)?;
    Ok(TrackContext {
        already_in,
        semester: DatedTarget {
            playlist_id: find_playlist(conn, "semester", &semester_name)?,
            name: semester_name,
        },
        gold: DatedTarget {
            playlist_id: find_playlist(conn, "gold", &gold_name)?,
            name: gold_name,
        },
        suggestions,
        audio_analysed,
    })
}

/// Weight of artist history relative to sound-alikes once both are scaled to their best playlist.
/// Sound-alikes dominate; artist history provides a gentle tie-breaker or fallback (originally 2.0).
const HISTORY_WEIGHT: f64 = 0.2; // Originally 2.0

/// Artist history blended with sound-alike scores from ml/sorter_ml.py (when it has scored the
/// song). Each source is scaled so its best playlist is 1, then history is weighted up: it's the
/// stronger signal for known artists, while sound-alikes cover artists with no history.
fn blended_suggestions(conn: &Connection, track_id: &str) -> AppResult<(Vec<Suggestion>, bool)> {
    let sound_alikes: Vec<(String, f64)> = {
        let mut stmt = conn.prepare(
            "SELECT s.target, s.score FROM ml_scores s
             JOIN playlists p ON p.id = s.target AND p.present = 1
             WHERE s.track_id = ?1",
        )?;
        let rows = stmt
            .query_map([track_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        rows
    };
    let history = artist_history(conn, track_id)?;
    if sound_alikes.is_empty() {
        return Ok((history, false));
    }

    let best = |scores: &mut dyn Iterator<Item = f64>| scores.fold(0.0_f64, f64::max).max(1e-9);
    let best_sound = best(&mut sound_alikes.iter().map(|(_, s)| *s));
    let best_history = best(&mut history.iter().map(|s| s.score));

    let mut merged: HashMap<String, (f64, Vec<String>)> = HashMap::new();
    for (playlist_id, share) in &sound_alikes {
        merged.insert(
            playlist_id.clone(),
            (
                share / best_sound,
                vec![format!("{:.0}% of sound-alikes are here", share * 100.0)],
            ),
        );
    }
    for s in history {
        let entry = merged.entry(s.playlist_id).or_default();
        entry.0 += HISTORY_WEIGHT * s.score / best_history;
        // Only sound-alike reasons ("X% of sound-alikes are here") are shown when audio analysis is available.
        // Artist history reasons ("X of Y songs by [Artist]") are commented out here so they only display on fallback
        // (when sound-alikes are empty / unanalyzed audio), prioritizing "sounds like" over artist match:
        //
        // let mut reasons = s.reasons;
        // reasons.append(&mut entry.1);
        // entry.1 = reasons;
    }
    let mut suggestions: Vec<Suggestion> = merged
        .into_iter()
        .map(|(playlist_id, (score, reasons))| Suggestion {
            playlist_id,
            score: (score * 100.0).round() / 100.0,
            reasons,
        })
        .collect();
    suggestions.sort_by(|a, b| b.score.total_cmp(&a.score));
    Ok((suggestions, true))
}

/// "Where did this artist's other songs go?" Each artist's share of songs in a playlist
/// counts toward that playlist; featured artists count a little less than the lead.
fn artist_history(conn: &Connection, track_id: &str) -> AppResult<Vec<Suggestion>> {
    let artists: Vec<(String, String, i64)> = {
        let mut stmt = conn.prepare(
            "SELECT artist_id, artist_name, position FROM track_artists
             WHERE track_id = ?1 AND artist_id IS NOT NULL ORDER BY position",
        )?;
        let rows = stmt
            .query_map([track_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<_, _>>()?;
        rows
    };

    let mut scores: HashMap<String, (f64, Vec<String>)> = HashMap::new();
    for (artist_id, artist_name, position) in artists {
        // Songs by this artist anywhere in the user's playlists (Internal holds everything heard).
        let known: i64 = conn.query_row(
            "SELECT COUNT(DISTINCT ta.track_id) FROM track_artists ta
             JOIN playlist_tracks pt ON pt.track_id = ta.track_id
             JOIN playlists p ON p.id = pt.playlist_id
             WHERE ta.artist_id = ?1 AND ta.track_id != ?2 AND p.present = 1 AND p.owned = 1",
            params![artist_id, track_id],
            |r| r.get(0),
        )?;
        if known == 0 {
            continue;
        }
        let mut stmt = conn.prepare(&format!(
            "SELECT pt.playlist_id, COUNT(DISTINCT ta.track_id) FROM track_artists ta
             JOIN playlist_tracks pt ON pt.track_id = ta.track_id
             JOIN playlists p ON p.id = pt.playlist_id
             WHERE ta.artist_id = ?1 AND ta.track_id != ?2 AND p.present = 1
               AND p.kind IN ({KEEPER_KINDS})
             GROUP BY pt.playlist_id"
        ))?;
        let weight = if position == 0 { 1.0 } else { 0.3 }; // Featured artist weight (originally 0.6)
        let per_playlist = stmt.query_map(params![artist_id, track_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        for row in per_playlist {
            let (playlist_id, count) = row?;
            // +1 so one song out of one isn't treated as certainty.
            let share = count as f64 / (known as f64 + 1.0);
            let entry = scores.entry(playlist_id).or_default();
            entry.0 += weight * share;
            entry
                .1
                .push(format!("{count} of {known} songs by {artist_name}"));
        }
    }

    let mut suggestions: Vec<Suggestion> = scores
        .into_iter()
        .map(|(playlist_id, (score, reasons))| Suggestion {
            playlist_id,
            score: (score * 100.0).round() / 100.0,
            reasons,
        })
        .collect();
    suggestions.sort_by(|a, b| b.score.total_cmp(&a.score));
    Ok(suggestions)
}

/// Stages a decision, and logs which vibe playlists were suggested (`shown`, best first) next to
/// what was picked, so real-use accuracy can be measured once the decision is committed.
pub fn stage(
    conn: &Connection,
    track_id: &str,
    playlist_ids: &[String],
    unlike: bool,
    shown: &[String],
    audio_analysed: bool,
) -> AppResult<()> {
    let now = Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO staged (track_id, playlist_ids, unlike, staged_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(track_id) DO UPDATE SET
            playlist_ids = excluded.playlist_ids, unlike = excluded.unlike, staged_at = excluded.staged_at",
        params![track_id, serde_json::to_string(playlist_ids)?, unlike, now],
    )?;
    conn.execute("DELETE FROM suggestion_log WHERE track_id = ?1 AND commit_id IS NULL", [track_id])?;
    let (ranking, settings) = ranking_snapshot(conn, track_id)?;
    conn.execute(
        "INSERT INTO suggestion_log (track_id, shown, picked, audio_analysed, staged_at, ranking, settings)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            track_id,
            serde_json::to_string(shown)?,
            serde_json::to_string(playlist_ids)?,
            audio_analysed,
            now,
            ranking.to_string(),
            settings.to_string()
        ],
    )?;
    Ok(())
}

/// Every playlist's blended score for the song, best first, with the raw sound-alike share and
/// artist-history score it came from (so other blends can be replayed later), plus the settings
/// that produced them.
fn ranking_snapshot(conn: &Connection, track_id: &str) -> AppResult<(serde_json::Value, serde_json::Value)> {
    let sound: HashMap<String, f64> = {
        let mut stmt = conn.prepare("SELECT target, score FROM ml_scores WHERE track_id = ?1")?;
        let rows = stmt.query_map([track_id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
        rows
    };
    let history: HashMap<String, f64> =
        artist_history(conn, track_id)?.into_iter().map(|s| (s.playlist_id, s.score)).collect();
    let (blended, _) = blended_suggestions(conn, track_id)?;
    let ranking: Vec<serde_json::Value> = blended
        .iter()
        .map(|s| {
            serde_json::json!({
                "id": s.playlist_id,
                "score": s.score,
                "sound": sound.get(&s.playlist_id),
                "history": history.get(&s.playlist_id),
            })
        })
        .collect();
    let scoring: Option<String> = conn
        .query_row("SELECT value FROM ml_meta WHERE key = 'scoring'", [], |r| r.get(0))
        .optional()?;
    let trained_at: Option<String> = conn
        .query_row("SELECT value FROM ml_meta WHERE key = 'trained_at'", [], |r| r.get(0))
        .optional()?;
    let settings = serde_json::json!({
        "history_weight": HISTORY_WEIGHT,
        "scoring": scoring.and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()),
        "trained_at": trained_at.and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()),
    });
    Ok((serde_json::Value::Array(ranking), settings))
}

/// Records songs added or removed through Explore, with where each sat in the results.
pub fn log_explore(conn: &Connection, action: &str, playlist_id: Option<&str>, picks: &[ExplorePick]) -> AppResult<()> {
    let now = Local::now().to_rfc3339();
    for p in picks {
        conn.execute(
            "INSERT INTO explore_log (at, action, mode, source, playlist_id, track_id, grp, rank, group_size)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![now, action, p.mode, p.source, playlist_id, p.track_id, p.group, p.rank, p.group_size],
        )?;
    }
    Ok(())
}

pub fn unstage(conn: &Connection, track_id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM staged WHERE track_id = ?1", [track_id])?;
    conn.execute("DELETE FROM suggestion_log WHERE track_id = ?1 AND commit_id IS NULL", [track_id])?;
    Ok(())
}

/// How the Suggested vibes row did on real, committed decisions (vibe picks only).
pub fn suggestion_stats(conn: &Connection) -> AppResult<SuggestionStats> {
    let vibes: HashSet<String> = {
        let mut stmt = conn.prepare("SELECT id FROM playlists WHERE kind = 'vibe'")?;
        let rows = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
        rows
    };
    let mut stats = SuggestionStats::default();
    let mut stmt = conn.prepare(
        "SELECT shown, picked FROM suggestion_log WHERE commit_id IS NOT NULL AND reverted = 0",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (shown, picked) = row?;
        let shown: Vec<String> = serde_json::from_str(&shown).unwrap_or_default();
        let picked: HashSet<String> = serde_json::from_str::<Vec<String>>(&picked)
            .unwrap_or_default()
            .into_iter()
            .filter(|p| vibes.contains(p))
            .collect();
        if picked.is_empty() {
            continue; // no vibe playlist picked: nothing the Suggested row could get right
        }
        stats.songs += 1;
        let hit = |n: usize| shown.iter().take(n).any(|p| picked.contains(p));
        stats.top1 += hit(1) as i64;
        stats.top3 += hit(3) as i64;
        stats.top9 += hit(9) as i64;
    }
    Ok(stats)
}

pub fn can_revert(conn: &Connection) -> AppResult<bool> {
    Ok(conn.query_row("SELECT EXISTS(SELECT 1 FROM filings WHERE reverted = 0)", [], |r| r.get(0))?)
}

/// Records a playlist change we made ourselves, so the next sync doesn't re-download it.
/// The stored snapshot only advances if we were in sync before the change.
fn record_snapshot(conn: &Connection, playlist_id: &str, snapshot: Option<&str>, delta: i64) -> AppResult<()> {
    if let Some(snapshot) = snapshot {
        conn.execute(
            "UPDATE playlists SET
                synced_snapshot_id = CASE WHEN synced_snapshot_id = snapshot_id THEN ?2 ELSE synced_snapshot_id END,
                snapshot_id = ?2,
                total = MAX(0, total + ?3)
             WHERE id = ?1",
            params![playlist_id, snapshot, delta],
        )?;
    }
    Ok(())
}

struct StagedRow {
    track_id: String,
    uri: String,
    playlists: Vec<String>,
    unlike: bool,
    liked_at: Option<String>,
}

/// Applies every staged decision: one add request per playlist (up to 100 songs each), then
/// unlikes in batches of 40. Anything that fails stays staged so it can be retried.
pub async fn commit(db: &Db, spotify: &Spotify) -> AppResult<CommitSummary> {
    let (rows, commit_id, pending) = {
        let conn = db::lock(db);
        let rows: Vec<StagedRow> = {
            let mut stmt = conn.prepare(
                "SELECT s.track_id, t.uri, s.playlist_ids, s.unlike, COALESCE(o.added_at, l.added_at)
                 FROM staged s
                 JOIN tracks t ON t.id = s.track_id
                 LEFT JOIN liked l ON l.track_id = s.track_id
                 LEFT JOIN liked_override o ON o.track_id = s.track_id
                 ORDER BY COALESCE(o.added_at, l.added_at)",
            )?;
            let rows = stmt
                .query_map([], |r| {
                    let ids: String = r.get(2)?;
                    Ok(StagedRow {
                        track_id: r.get(0)?,
                        uri: r.get(1)?,
                        playlists: serde_json::from_str(&ids).unwrap_or_default(),
                        unlike: r.get(3)?,
                        liked_at: r.get(4)?,
                    })
                })?
                .collect::<Result<_, _>>()?;
            rows
        };
        let commit_id: i64 =
            conn.query_row("SELECT COALESCE(MAX(commit_id), 0) + 1 FROM filings", [], |r| r.get(0))?;

        // Skip playlists that already hold any copy of the song so nothing gets duplicated.
        let mut pending: HashMap<String, HashSet<String>> = HashMap::new();
        for row in &rows {
            let copies = db::same_song_ids(&conn, &row.track_id)?;
            let mut needed = HashSet::new();
            for pid in &row.playlists {
                let mut present = false;
                for id in &copies {
                    present |= conn.query_row(
                        "SELECT EXISTS(SELECT 1 FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2)",
                        params![pid, id],
                        |r| r.get::<_, bool>(0),
                    )?;
                }
                if !present {
                    needed.insert(pid.clone());
                }
            }
            pending.insert(row.track_id.clone(), needed);
        }
        (rows, commit_id, pending)
    };

    if rows.is_empty() {
        return Ok(CommitSummary { songs: 0, additions: 0, unliked: 0 });
    }

    let mut by_playlist: BTreeMap<&str, Vec<&StagedRow>> = BTreeMap::new();
    for row in &rows {
        for pid in &pending[&row.track_id] {
            by_playlist.entry(pid.as_str()).or_default().push(row);
        }
    }

    let mut added: HashMap<String, Vec<String>> = HashMap::new();
    let mut unliked: HashSet<String> = HashSet::new();
    let mut additions = 0usize;

    let mut outcome: AppResult<()> = Ok(());
    'adds: for (pid, items) in &by_playlist {
        for chunk in items.chunks(100) {
            let uris: Vec<String> = chunk.iter().map(|r| r.uri.clone()).collect();
            match spotify.add_to_playlist(pid, &uris).await {
                Ok(snapshot) => {
                    let conn = db::lock(db);
                    let now = chrono::Utc::now().to_rfc3339();
                    for row in chunk {
                        conn.execute(
                            "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, added_at) VALUES (?1, ?2, ?3)",
                            params![pid, row.track_id, now],
                        )?;
                        added.entry(row.track_id.clone()).or_default().push(pid.to_string());
                    }
                    record_snapshot(&conn, pid, snapshot.as_deref(), chunk.len() as i64)?;
                    additions += chunk.len();
                }
                Err(e) => {
                    outcome = Err(e);
                    break 'adds;
                }
            }
        }
    }

    // Only unlike songs whose playlist additions all went through.
    let fully_added = |row: &StagedRow| {
        let done: HashSet<&String> = added.get(&row.track_id).map(|v| v.iter().collect()).unwrap_or_default();
        pending[&row.track_id].iter().all(|pid| done.contains(pid))
    };
    if outcome.is_ok() {
        let to_unlike: Vec<&StagedRow> = rows.iter().filter(|r| r.unlike && fully_added(r)).collect();
        for chunk in to_unlike.chunks(40) {
            let uris: Vec<String> = chunk.iter().map(|r| r.uri.clone()).collect();
            if let Err(e) = spotify.library_remove(&uris).await {
                outcome = Err(e);
                break;
            }
            let conn = db::lock(db);
            for row in chunk {
                conn.execute("DELETE FROM liked WHERE track_id = ?1", [&row.track_id])?;
                conn.execute("DELETE FROM liked_override WHERE track_id = ?1", [&row.track_id])?;
                unliked.insert(row.track_id.clone());
            }
        }
    }

    let mut songs = 0;
    {
        let conn = db::lock(db);
        let now = Local::now().to_rfc3339();
        for row in &rows {
            let row_added = added.get(&row.track_id).cloned().unwrap_or_default();
            let row_unliked = unliked.contains(&row.track_id);
            if !row_added.is_empty() || row_unliked {
                conn.execute(
                    "INSERT INTO filings (commit_id, track_id, playlist_ids, unliked, liked_at, filed_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        commit_id,
                        row.track_id,
                        serde_json::to_string(&row_added)?,
                        row_unliked,
                        row.liked_at,
                        now
                    ],
                )?;
            }
            if fully_added(row) && (!row.unlike || row_unliked) {
                conn.execute("DELETE FROM staged WHERE track_id = ?1", [&row.track_id])?;
                conn.execute(
                    "UPDATE suggestion_log SET commit_id = ?1 WHERE track_id = ?2 AND commit_id IS NULL",
                    params![commit_id, row.track_id],
                )?;
                songs += 1;
            }
        }
    }

    outcome.map(|_| CommitSummary {
        songs,
        additions,
        unliked: unliked.len(),
    })
}

/// Undoes the most recent commit that hasn't been reverted: removes the songs from the
/// playlists they were added to and likes them again with their original like date.
pub async fn revert_last_commit(db: &Db, spotify: &Spotify) -> AppResult<CommitSummary> {
    struct Filing {
        id: i64,
        track_id: String,
        uri: String,
        playlists: Vec<String>,
        unliked: bool,
        liked_at: Option<String>,
    }
    let filings: Vec<Filing> = {
        let conn = db::lock(db);
        let mut stmt = conn.prepare(
            "SELECT f.id, f.track_id, t.uri, f.playlist_ids, f.unliked, f.liked_at
             FROM filings f JOIN tracks t ON t.id = f.track_id
             WHERE f.reverted = 0
               AND f.commit_id = (SELECT MAX(commit_id) FROM filings WHERE reverted = 0)",
        )?;
        let rows = stmt
            .query_map([], |r| {
                let ids: String = r.get(3)?;
                Ok(Filing {
                    id: r.get(0)?,
                    track_id: r.get(1)?,
                    uri: r.get(2)?,
                    playlists: serde_json::from_str(&ids).unwrap_or_default(),
                    unliked: r.get(4)?,
                    liked_at: r.get(5)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        rows
    };
    if filings.is_empty() {
        return Err(AppError::msg("Nothing to revert."));
    }

    let mut by_playlist: BTreeMap<&str, Vec<&Filing>> = BTreeMap::new();
    for f in &filings {
        for pid in &f.playlists {
            by_playlist.entry(pid.as_str()).or_default().push(f);
        }
    }
    let mut removals = 0;
    for (pid, items) in &by_playlist {
        for chunk in items.chunks(100) {
            let uris: Vec<String> = chunk.iter().map(|f| f.uri.clone()).collect();
            let snapshot = spotify.remove_from_playlist(pid, &uris).await?;
            let conn = db::lock(db);
            for f in chunk {
                conn.execute(
                    "DELETE FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2",
                    params![pid, f.track_id],
                )?;
            }
            record_snapshot(&conn, pid, snapshot.as_deref(), -(chunk.len() as i64))?;
            removals += chunk.len();
        }
    }

    let relike: Vec<&Filing> = filings.iter().filter(|f| f.unliked).collect();
    for chunk in relike.chunks(40) {
        let uris: Vec<String> = chunk.iter().map(|f| f.uri.clone()).collect();
        spotify.library_save(&uris).await?;
        let conn = db::lock(db);
        for f in chunk {
            let liked_at = f.liked_at.clone().unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
            conn.execute(
                "INSERT OR REPLACE INTO liked (track_id, added_at) VALUES (?1, ?2)",
                params![f.track_id, liked_at],
            )?;
            // Spotify now reports today's date; keep the original so the semester stays right.
            conn.execute(
                "INSERT OR REPLACE INTO liked_override (track_id, added_at) VALUES (?1, ?2)",
                params![f.track_id, liked_at],
            )?;
        }
    }

    let conn = db::lock(db);
    for f in &filings {
        conn.execute("UPDATE filings SET reverted = 1 WHERE id = ?1", [f.id])?;
        conn.execute(
            "UPDATE suggestion_log SET reverted = 1
             WHERE track_id = ?1 AND commit_id = (SELECT commit_id FROM filings WHERE id = ?2)",
            params![f.track_id, f.id],
        )?;
    }
    Ok(CommitSummary {
        songs: filings.len(),
        additions: removals,
        unliked: relike.len(),
    })
}

fn uris_for(conn: &Connection, track_ids: &[String]) -> AppResult<Vec<(String, String)>> {
    let mut out = Vec::new();
    for id in track_ids {
        let uri: Option<String> = conn
            .query_row("SELECT uri FROM tracks WHERE id = ?1", [id], |r| r.get(0))
            .optional()?;
        if let Some(uri) = uri {
            out.push((id.clone(), uri));
        }
    }
    Ok(out)
}

/// Adds songs straight to a playlist (used by the Explore tools), skipping ones already in it.
pub async fn add_tracks(db: &Db, spotify: &Spotify, playlist_id: &str, track_ids: &[String]) -> AppResult<usize> {
    let items: Vec<(String, String)> = {
        let conn = db::lock(db);
        let mut items = Vec::new();
        for (id, uri) in uris_for(&conn, track_ids)? {
            let present: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2)",
                params![playlist_id, id],
                |r| r.get(0),
            )?;
            if !present {
                items.push((id, uri));
            }
        }
        items
    };
    for chunk in items.chunks(100) {
        let uris: Vec<String> = chunk.iter().map(|(_, u)| u.clone()).collect();
        let snapshot = spotify.add_to_playlist(playlist_id, &uris).await?;
        let conn = db::lock(db);
        let now = chrono::Utc::now().to_rfc3339();
        for (id, _) in chunk {
            conn.execute(
                "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, added_at) VALUES (?1, ?2, ?3)",
                params![playlist_id, id, now],
            )?;
        }
        record_snapshot(&conn, playlist_id, snapshot.as_deref(), chunk.len() as i64)?;
    }
    Ok(items.len())
}

/// Removes songs from a playlist (Explore → Misfits).
pub async fn remove_tracks(db: &Db, spotify: &Spotify, playlist_id: &str, track_ids: &[String]) -> AppResult<usize> {
    let items = uris_for(&db::lock(db), track_ids)?;
    for chunk in items.chunks(100) {
        let uris: Vec<String> = chunk.iter().map(|(_, u)| u.clone()).collect();
        let snapshot = spotify.remove_from_playlist(playlist_id, &uris).await?;
        let conn = db::lock(db);
        let detected = chrono::Utc::now().to_rfc3339();
        for (id, _) in chunk {
            // A deliberate "doesn't fit here", same as pruning in Spotify (sync logs those).
            conn.execute(
                "INSERT OR IGNORE INTO playlist_removals (playlist_id, track_id, added_at, detected_at)
                 SELECT playlist_id, track_id, added_at, ?3 FROM playlist_tracks
                 WHERE playlist_id = ?1 AND track_id = ?2",
                params![playlist_id, id, detected],
            )?;
            conn.execute(
                "DELETE FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2",
                params![playlist_id, id],
            )?;
        }
        record_snapshot(&conn, playlist_id, snapshot.as_deref(), -(chunk.len() as i64))?;
    }
    Ok(items.len())
}

/// Creates a private playlist with the given songs and files it under Random Ideas.
pub async fn create_playlist(db: &Db, spotify: &Spotify, name: &str, track_ids: &[String]) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::msg("Give the playlist a name."));
    }
    let created = spotify.create_playlist(name).await?;
    let id = created["id"]
        .as_str()
        .ok_or_else(|| AppError::msg("Spotify didn't return the new playlist's ID."))?
        .to_owned();
    {
        let conn = db::lock(db);
        // Mirror it locally so it shows up without a sync; the snapshot keeps the next sync cheap.
        conn.execute(
            "INSERT OR REPLACE INTO playlists
                (id, name, snapshot_id, synced_snapshot_id, owned, total, kind, list_position, present)
             VALUES (?1, ?2, ?3, ?3, 1, 0, 'idea', -1, 1)",
            params![id, name, created["snapshot_id"].as_str()],
        )?;
    }
    add_tracks(db, spotify, &id, track_ids).await?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::semester_name;

    #[test]
    fn suggestion_stats_count_committed_vibe_picks() {
        let dir = std::env::temp_dir().join(format!("sorter-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let conn = crate::db::open(&dir.join("t.db")).unwrap();
        conn.execute_batch(
            "INSERT INTO playlists (id, name, kind) VALUES ('v1','a','vibe'), ('v2','b','vibe'), ('v3','c','vibe'), ('p','pool','pool');",
        )
        .unwrap();
        let log = |track: &str, shown: &str, picked: &str, commit: Option<i64>, reverted: i64| {
            conn.execute(
                "INSERT INTO suggestion_log (track_id, shown, picked, audio_analysed, staged_at, commit_id, reverted)
                 VALUES (?1, ?2, ?3, 1, 'now', ?4, ?5)",
                rusqlite::params![track, shown, picked, commit, reverted],
            )
            .unwrap();
        };
        log("t1", r#"["v1","v2","v3"]"#, r#"["v1","p"]"#, Some(1), 0); // top pick
        log("t2", r#"["v1","v2","v3"]"#, r#"["v3"]"#, Some(1), 0); // 3rd
        log("t3", r#"["v1","v2"]"#, r#"["p"]"#, Some(1), 0); // no vibe picked: ignored
        log("t4", r#"["v1"]"#, r#"["v1"]"#, None, 0); // staged, not committed: ignored
        log("t5", r#"["v1"]"#, r#"["v1"]"#, Some(2), 1); // reverted: ignored
        let st = super::suggestion_stats(&conn).unwrap();
        assert_eq!((st.songs, st.top1, st.top3, st.top9), (2, 1, 2, 2));
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
    use chrono::{Local, TimeZone};

    #[test]
    fn semesters_follow_calendar_terms() {
        let at = |m, d| Local.with_ymd_and_hms(2026, m, d, 12, 0, 0).unwrap();
        assert_eq!(semester_name(at(1, 5)), "Winter 2026");
        assert_eq!(semester_name(at(4, 30)), "Winter 2026");
        assert_eq!(semester_name(at(5, 1)), "Summer 2026");
        assert_eq!(semester_name(at(8, 30)), "Summer 2026");
        assert_eq!(semester_name(at(9, 1)), "Fall 2026");
        assert_eq!(semester_name(at(12, 31)), "Fall 2026");
    }

    #[test]
    fn stage_logs_full_ranking_and_settings() {
        let dir = std::env::temp_dir().join(format!("sorter-rank-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let conn = crate::db::open(&dir.join("t.db")).unwrap();
        conn.execute_batch(
            "INSERT INTO playlists (id, name, kind, present) VALUES ('v1','a','vibe',1), ('v2','b','vibe',1);
             INSERT INTO ml_scores (track_id, target, score) VALUES ('t','v1',0.2), ('t','v2',0.6);
             INSERT INTO ml_meta (key, value) VALUES ('scoring', '{\"neighbours\":120}');",
        )
        .unwrap();
        super::stage(&conn, "t", &["v2".into()], true, &["v2".into(), "v1".into()], true).unwrap();
        let (ranking, settings): (String, String) = conn
            .query_row("SELECT ranking, settings FROM suggestion_log WHERE track_id = 't'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        let ranking: serde_json::Value = serde_json::from_str(&ranking).unwrap();
        let settings: serde_json::Value = serde_json::from_str(&settings).unwrap();
        assert_eq!(ranking[0]["id"], "v2");
        assert_eq!(ranking[1]["sound"], 0.2);
        assert_eq!(settings["history_weight"], 0.2);
        assert_eq!(settings["scoring"]["neighbours"], 120);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn blended_suggestions_reason_handling() {
        let dir = std::env::temp_dir().join(format!("sorter-blend-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let conn = crate::db::open(&dir.join("t.db")).unwrap();
        conn.execute_batch(
            "INSERT INTO playlists (id, name, kind, present, owned) VALUES ('v1','Vibe 1','vibe',1,1), ('v2','Vibe 2','vibe',1,1);
             INSERT INTO track_artists (track_id, position, artist_id, artist_name) VALUES ('curr', 0, 'art1', 'Lead Artist');
             INSERT INTO track_artists (track_id, position, artist_id, artist_name) VALUES ('other', 0, 'art1', 'Lead Artist');
             INSERT INTO playlist_tracks (playlist_id, track_id) VALUES ('v1', 'other');
             INSERT INTO ml_scores (track_id, target, score) VALUES ('curr', 'v2', 0.8);"
        ).unwrap();

        // When sound-alikes exist: only sound-alike reasons appear, not artist history reasons
        let (sugg, analysed) = super::blended_suggestions(&conn, "curr").unwrap();
        assert!(analysed);
        let v2 = sugg.iter().find(|s| s.playlist_id == "v2").unwrap();
        assert_eq!(v2.reasons, vec!["80% of sound-alikes are here".to_string()]);

        // Fallback case: when sound-alikes are empty, artist reasons are shown
        conn.execute("DELETE FROM ml_scores WHERE track_id = 'curr'", []).unwrap();
        let (fallback_sugg, fallback_analysed) = super::blended_suggestions(&conn, "curr").unwrap();
        assert!(!fallback_analysed);
        let v1 = fallback_sugg.iter().find(|s| s.playlist_id == "v1").unwrap();
        assert!(v1.reasons[0].contains("songs by Lead Artist"));

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn artist_history_featured_weight() {
        let dir = std::env::temp_dir().join(format!("sorter-feat-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let conn = crate::db::open(&dir.join("t.db")).unwrap();
        conn.execute_batch(
            "INSERT INTO playlists (id, name, kind, present, owned) VALUES ('p_lead','Lead List','vibe',1,1), ('p_feat','Feat List','vibe',1,1);
             -- target song has lead artist 'lead' and featured artist 'feat'
             INSERT INTO track_artists (track_id, position, artist_id, artist_name) VALUES ('t', 0, 'lead', 'Lead');
             INSERT INTO track_artists (track_id, position, artist_id, artist_name) VALUES ('t', 1, 'feat', 'Feat');
             -- previous tracks in library:
             INSERT INTO track_artists (track_id, position, artist_id, artist_name) VALUES ('t_lead', 0, 'lead', 'Lead');
             INSERT INTO playlist_tracks (playlist_id, track_id) VALUES ('p_lead', 't_lead');
             INSERT INTO track_artists (track_id, position, artist_id, artist_name) VALUES ('t_feat', 0, 'feat', 'Feat');
             INSERT INTO playlist_tracks (playlist_id, track_id) VALUES ('p_feat', 't_feat');"
        ).unwrap();

        let history = super::artist_history(&conn, "t").unwrap();
        let lead_score = history.iter().find(|s| s.playlist_id == "p_lead").unwrap().score;
        let feat_score = history.iter().find(|s| s.playlist_id == "p_feat").unwrap().score;
        // Lead weight is 1.0 (share 1/2 = 0.5), feat weight is 0.3 (share 1/2 * 0.3 = 0.15)
        assert_eq!(lead_score, 0.5);
        assert_eq!(feat_score, 0.15);

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
