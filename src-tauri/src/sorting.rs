//! The weekly sort: the Liked Songs queue, per-song context and suggestions, staging, and
//! committing staged decisions to Spotify in as few requests as possible.

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{DateTime, Datelike, Local};
use rusqlite::{params, Connection, OptionalExtension};

use crate::db::{self, Db};
use crate::error::{AppError, AppResult};
use crate::model::{CommitSummary, DatedTarget, QueueItem, Suggestion, TrackContext};
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
    let already_in: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT pt.playlist_id FROM playlist_tracks pt
             JOIN tracks t ON t.id = pt.track_id
             JOIN playlists p ON p.id = pt.playlist_id
             WHERE p.present = 1
               AND (t.id = ?1 OR (t.isrc IS NOT NULL AND t.isrc = (SELECT isrc FROM tracks WHERE id = ?1)))",
        )?;
        let rows = stmt
            .query_map([track_id], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        rows
    };

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
        suggestions: artist_history(conn, track_id)?,
    })
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
        let weight = if position == 0 { 1.0 } else { 0.6 };
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

pub fn stage(conn: &Connection, track_id: &str, playlist_ids: &[String], unlike: bool) -> AppResult<()> {
    conn.execute(
        "INSERT INTO staged (track_id, playlist_ids, unlike, staged_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(track_id) DO UPDATE SET
            playlist_ids = excluded.playlist_ids, unlike = excluded.unlike, staged_at = excluded.staged_at",
        params![
            track_id,
            serde_json::to_string(playlist_ids)?,
            unlike,
            Local::now().to_rfc3339()
        ],
    )?;
    Ok(())
}

pub fn unstage(conn: &Connection, track_id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM staged WHERE track_id = ?1", [track_id])?;
    Ok(())
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

        // Skip playlists that already hold the song so nothing gets duplicated.
        let mut pending: HashMap<String, HashSet<String>> = HashMap::new();
        for row in &rows {
            let mut needed = HashSet::new();
            for pid in &row.playlists {
                let present: bool = conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2)",
                    params![pid, row.track_id],
                    |r| r.get(0),
                )?;
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
    }
    Ok(CommitSummary {
        songs: filings.len(),
        additions: removals,
        unliked: relike.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::semester_name;
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
}
