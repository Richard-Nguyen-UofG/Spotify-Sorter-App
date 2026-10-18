use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::{params, Connection, OptionalExtension, Transaction};

use crate::error::AppResult;
use crate::model::Track;

pub type Db = Arc<Mutex<Connection>>;

/// Locks the shared connection. Never hold the guard across an `.await`.
pub fn lock(db: &Db) -> MutexGuard<'_, Connection> {
    db.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// Each entry runs once, in order; `PRAGMA user_version` records how many have run.
const MIGRATIONS: &[&str] = &[r#"
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE api_calls (
    day   TEXT PRIMARY KEY,
    count INTEGER NOT NULL
);

CREATE TABLE tracks (
    id           TEXT PRIMARY KEY,
    uri          TEXT NOT NULL,
    name         TEXT NOT NULL,
    album        TEXT,
    release_date TEXT,
    isrc         TEXT,
    duration_ms  INTEGER,
    image_url    TEXT
);
CREATE INDEX idx_tracks_isrc ON tracks(isrc);

CREATE TABLE track_artists (
    track_id    TEXT NOT NULL,
    position    INTEGER NOT NULL,
    artist_id   TEXT,
    artist_name TEXT NOT NULL,
    PRIMARY KEY (track_id, position)
);
CREATE INDEX idx_track_artists_artist ON track_artists(artist_id);

-- kind: semester | internal | skimmed | gold | gold_all | pool | vibe | exercise | idea | archive | memory | ignore | unsorted
-- (archive: old taste-based playlists; memory: time-capsule playlists. Neither is suggested or
--  re-downloaded, but their songs still count as "already in".)
-- mood: positive | negative (pool, vibe)    pace: high | med | low (vibe)
CREATE TABLE playlists (
    id                 TEXT PRIMARY KEY,
    name               TEXT NOT NULL,
    snapshot_id        TEXT,
    synced_snapshot_id TEXT,
    owned              INTEGER NOT NULL DEFAULT 1,
    total              INTEGER NOT NULL DEFAULT 0,
    image_url          TEXT,
    kind               TEXT NOT NULL DEFAULT 'unsorted',
    mood               TEXT,
    pace               TEXT,
    description        TEXT,
    list_position      INTEGER NOT NULL DEFAULT 0,
    present            INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE playlist_tracks (
    playlist_id TEXT NOT NULL,
    track_id    TEXT NOT NULL,
    added_at    TEXT,
    PRIMARY KEY (playlist_id, track_id)
);
CREATE INDEX idx_playlist_tracks_track ON playlist_tracks(track_id);

CREATE TABLE liked (
    track_id TEXT PRIMARY KEY,
    added_at TEXT NOT NULL
);

-- Original like dates for songs re-liked by "revert last commit", so the semester doesn't drift.
CREATE TABLE liked_override (
    track_id TEXT PRIMARY KEY,
    added_at TEXT NOT NULL
);

CREATE TABLE staged (
    track_id     TEXT PRIMARY KEY,
    playlist_ids TEXT NOT NULL,
    unlike       INTEGER NOT NULL,
    staged_at    TEXT NOT NULL
);

-- Every filing decision, kept for undo and as training data for future suggestions.
CREATE TABLE filings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    commit_id    INTEGER NOT NULL,
    track_id     TEXT NOT NULL,
    playlist_ids TEXT NOT NULL,
    unliked      INTEGER NOT NULL,
    liked_at     TEXT,
    filed_at     TEXT NOT NULL,
    reverted     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_filings_commit ON filings(commit_id);
"#,
// The all-time Gold playlist ("2018-Present Gold") became its own kind.
r#"
UPDATE playlists SET kind = 'gold_all'
WHERE kind = 'unsorted' AND lower(name) LIKE '%-present gold';
"#,
// Time-capsule playlists ("2019 Aug - Sept Memory") got their own kind.
r#"
UPDATE playlists SET kind = 'memory'
WHERE kind = 'unsorted' AND (lower(name) LIKE '%memory%' OR lower(name) LIKE '%memories%');
"#,
// Audio/lyrics suggestions, written by ml/sorter_ml.py (which also creates these if missing).
r#"
CREATE TABLE IF NOT EXISTS ml_audio (
    track_id   TEXT PRIMARY KEY,
    status     TEXT NOT NULL,
    source     TEXT,
    embedding  BLOB,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ml_lyrics (
    track_id   TEXT PRIMARY KEY,
    status     TEXT NOT NULL,
    embedding  BLOB,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ml_scores (
    track_id TEXT NOT NULL,
    target   TEXT NOT NULL,
    score    REAL NOT NULL,
    PRIMARY KEY (track_id, target)
);
CREATE TABLE IF NOT EXISTS ml_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#,
// Artist genres. (Spotify's artist objects no longer include genres for Development Mode
// apps, so this is filled from elsewhere, e.g. MusicBrainz tags.)
r#"
CREATE TABLE artists (
    id         TEXT PRIMARY KEY,
    name       TEXT,
    genres     TEXT,          -- JSON array of genre/tag names; NULL if none were found
    fetched_at TEXT NOT NULL
);
"#,
// Per-song genre vectors (written by ml/sorter_ml.py for Explore), and songs the user removed from
// playlists (detected at sync): "doesn't fit here" evidence for future suggestions.
r#"
CREATE TABLE IF NOT EXISTS ml_genres (
    track_id  TEXT PRIMARY KEY,
    embedding BLOB NOT NULL
);
CREATE TABLE playlist_removals (
    playlist_id TEXT NOT NULL,
    track_id    TEXT NOT NULL,
    added_at    TEXT,          -- when it had been added, if known
    detected_at TEXT NOT NULL,
    PRIMARY KEY (playlist_id, track_id, detected_at)
);
"#];

pub fn open(path: &Path) -> AppResult<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")?;
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, migration) in MIGRATIONS.iter().enumerate().skip(version as usize) {
        conn.execute_batch(migration)?;
        conn.pragma_update(None, "user_version", (i + 1) as i64)?;
    }
    Ok(conn)
}

pub fn get_setting(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
        .optional()?)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn delete_setting(conn: &Connection, key: &str) -> AppResult<()> {
    conn.execute("DELETE FROM settings WHERE key = ?1", [key])?;
    Ok(())
}

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

pub fn bump_api_calls(conn: &Connection) -> AppResult<()> {
    conn.execute(
        "INSERT INTO api_calls (day, count) VALUES (?1, 1)
         ON CONFLICT(day) DO UPDATE SET count = count + 1",
        [today()],
    )?;
    Ok(())
}

pub fn api_calls_today(conn: &Connection) -> AppResult<i64> {
    Ok(conn
        .query_row("SELECT count FROM api_calls WHERE day = ?1", [today()], |r| r.get(0))
        .optional()?
        .unwrap_or(0))
}

pub fn upsert_track(tx: &Transaction, track: &Track) -> AppResult<()> {
    tx.execute(
        "INSERT INTO tracks (id, uri, name, album, release_date, isrc, duration_ms, image_url)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
            uri = excluded.uri, name = excluded.name, album = excluded.album,
            release_date = excluded.release_date,
            isrc = COALESCE(excluded.isrc, tracks.isrc),
            duration_ms = excluded.duration_ms,
            image_url = COALESCE(excluded.image_url, tracks.image_url)",
        params![
            track.id,
            track.uri,
            track.name,
            track.album,
            track.release_date,
            track.isrc,
            track.duration_ms,
            track.image_url
        ],
    )?;
    tx.execute("DELETE FROM track_artists WHERE track_id = ?1", [&track.id])?;
    for (position, artist) in track.artists.iter().enumerate() {
        tx.execute(
            "INSERT INTO track_artists (track_id, position, artist_id, artist_name) VALUES (?1, ?2, ?3, ?4)",
            params![track.id, position as i64, artist.id, artist.name],
        )?;
    }
    Ok(())
}

/// Lowercased title with punctuation and extra spaces removed, for matching re-releases.
pub fn normalise_title(title: &str) -> String {
    title
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// IDs of every copy of the same recording: the track itself, other releases with the same ISRC,
/// and tracks by the same lead artist with the same title and length (±2 s), which catches
/// explicit/clean and re-release pairs that got a new ISRC.
pub fn same_song_ids(conn: &Connection, track_id: &str) -> AppResult<Vec<String>> {
    let Some(track) = load_track(conn, track_id)? else { return Ok(vec![track_id.to_owned()]) };
    let mut ids = vec![track.id.clone()];
    if let Some(isrc) = &track.isrc {
        let mut stmt = conn.prepare("SELECT id FROM tracks WHERE isrc = ?1 AND id != ?2")?;
        for id in stmt.query_map(params![isrc, track.id], |r| r.get::<_, String>(0))? {
            ids.push(id?);
        }
    }
    if let (Some(lead), Some(duration)) = (track.artists.first().and_then(|a| a.id.clone()), track.duration_ms) {
        let title = normalise_title(&track.name);
        let mut stmt = conn.prepare(
            "SELECT t.id, t.name FROM tracks t JOIN track_artists ta ON ta.track_id = t.id AND ta.position = 0
             WHERE ta.artist_id = ?1 AND t.id != ?2 AND ABS(COALESCE(t.duration_ms, 0) - ?3) <= 2000",
        )?;
        for row in stmt.query_map(params![lead, track.id, duration], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (id, name) = row?;
            if normalise_title(&name) == title && !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    Ok(ids)
}

pub fn load_track(conn: &Connection, id: &str) -> AppResult<Option<Track>> {
    let track = conn
        .query_row(
            "SELECT id, uri, name, album, release_date, isrc, duration_ms, image_url FROM tracks WHERE id = ?1",
            [id],
            |r| {
                Ok(Track {
                    id: r.get(0)?,
                    uri: r.get(1)?,
                    name: r.get(2)?,
                    album: r.get(3)?,
                    release_date: r.get(4)?,
                    isrc: r.get(5)?,
                    duration_ms: r.get(6)?,
                    image_url: r.get(7)?,
                    artists: Vec::new(),
                })
            },
        )
        .optional()?;
    let Some(mut track) = track else { return Ok(None) };
    let mut stmt = conn.prepare(
        "SELECT artist_id, artist_name FROM track_artists WHERE track_id = ?1 ORDER BY position",
    )?;
    track.artists = stmt
        .query_map([id], |r| {
            Ok(crate::model::Artist {
                id: r.get(0)?,
                name: r.get(1)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(Some(track))
}

#[cfg(test)]
mod tests {
    use super::normalise_title;

    #[test]
    fn titles_normalise_for_matching() {
        assert_eq!(normalise_title("I Like You (A Happier Song) (with Doja Cat)"), "i like you a happier song with doja cat");
        assert_eq!(normalise_title("  BANDIT!! "), "bandit");
        assert_eq!(normalise_title("ギミアブレスタッナウ"), "ギミアブレスタッナウ");
    }
}
