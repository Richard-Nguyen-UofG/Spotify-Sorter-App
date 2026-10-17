use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artist {
    pub id: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub uri: String,
    pub name: String,
    pub album: Option<String>,
    pub release_date: Option<String>,
    pub isrc: Option<String>,
    pub duration_ms: Option<i64>,
    pub image_url: Option<String>,
    pub artists: Vec<Artist>,
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// Parses a Spotify track object. Returns None for local files, episodes and unavailable tracks.
pub fn parse_track(v: &Value) -> Option<Track> {
    if v.get("is_local").and_then(Value::as_bool).unwrap_or(false) {
        return None;
    }
    if let Some(kind) = v.get("type").and_then(Value::as_str) {
        if kind != "track" {
            return None;
        }
    }
    let id = str_field(v, "id")?;
    let album = v.get("album");
    // Spotify lists album images largest first; the smallest is plenty for thumbnails.
    let image_url = album
        .and_then(|a| a.get("images"))
        .and_then(Value::as_array)
        .and_then(|imgs| imgs.last().or(imgs.first()))
        .and_then(|img| str_field(img, "url"));
    let artists = v
        .get("artists")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|a| {
                    Some(Artist {
                        id: str_field(a, "id"),
                        name: str_field(a, "name")?,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(Track {
        uri: str_field(v, "uri").unwrap_or_else(|| format!("spotify:track:{id}")),
        name: str_field(v, "name").unwrap_or_default(),
        album: album.and_then(|a| str_field(a, "name")),
        release_date: album.and_then(|a| str_field(a, "release_date")),
        isrc: v
            .get("external_ids")
            .and_then(|e| str_field(e, "isrc")),
        duration_ms: v.get("duration_ms").and_then(Value::as_i64),
        image_url,
        artists,
        id,
    })
}

/// Playlist item entries use `item` now; `track` is the deprecated name.
pub fn parse_playlist_entry(entry: &Value) -> Option<(Track, Option<String>)> {
    if entry.get("is_local").and_then(Value::as_bool).unwrap_or(false) {
        return None;
    }
    let obj = entry
        .get("item")
        .filter(|v| !v.is_null())
        .or_else(|| entry.get("track"))?;
    let track = parse_track(obj)?;
    Some((track, str_field(entry, "added_at")))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistRow {
    pub id: String,
    pub name: String,
    pub total: i64,
    pub image_url: Option<String>,
    pub kind: String,
    pub mood: Option<String>,
    pub pace: Option<String>,
    pub description: Option<String>,
    pub owned: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    pub track: Track,
    pub liked_at: String,
    pub staged: Option<Vec<String>>,
    pub unlike: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatedTarget {
    pub name: String,
    pub playlist_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub playlist_id: String,
    pub score: f64,
    pub reasons: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackContext {
    pub already_in: Vec<String>,
    pub semester: DatedTarget,
    pub gold: DatedTarget,
    pub suggestions: Vec<Suggestion>,
    /// Whether sound-alike scores (ml/sorter_ml.py) went into the suggestions.
    pub audio_analysed: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgress {
    pub message: String,
    pub done: usize,
    pub total: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSummary {
    pub playlists: usize,
    pub playlists_downloaded: usize,
    pub liked: usize,
    pub api_calls: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    pub songs: usize,
    pub additions: usize,
    pub unliked: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub has_client_id: bool,
    pub logged_in: bool,
    pub display_name: Option<String>,
    pub redirect_uri: String,
    pub api_calls_today: i64,
    pub last_sync: Option<String>,
    pub can_revert: bool,
    pub ml_available: bool,
    pub ml_running: bool,
    pub ml_trained_at: Option<String>,
}
