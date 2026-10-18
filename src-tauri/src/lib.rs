mod db;
mod error;
mod explore;
mod ml;
mod model;
mod sorting;
mod spotify;
mod sync;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rusqlite::params;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use db::Db;
use error::{AppError, AppResult};
use model::{CommitSummary, PlaylistRow, QueueItem, Status, SyncSummary, TrackContext};
use spotify::Spotify;

pub struct AppState {
    db: Db,
    db_path: PathBuf,
    spotify: Spotify,
    /// Sound/lyrics vectors for Explore, loaded on first use and dropped after each analysis run.
    vectors: Mutex<Option<Arc<explore::VectorIndex>>>,
}

impl AppState {
    fn vectors(&self) -> AppResult<Arc<explore::VectorIndex>> {
        let mut slot = self.vectors.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(index) = slot.as_ref() {
            return Ok(index.clone());
        }
        let index = Arc::new(explore::VectorIndex::build(&db::lock(&self.db))?);
        if index.len() == 0 {
            return Err(AppError::msg("No songs have been analysed yet. Run Analyse audio first."));
        }
        *slot = Some(index.clone());
        Ok(index)
    }
}

/// Runs a CPU-heavy Explore search off the main thread.
async fn explore_task<T: Send + 'static>(
    state: &AppState,
    f: impl FnOnce(&explore::VectorIndex, &rusqlite::Connection) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    let index = state.vectors()?;
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || f(&index, &db::lock(&db)))
        .await
        .map_err(|e| AppError::msg(e.to_string()))?
}

const KINDS: &[&str] = &[
    "semester", "internal", "skimmed", "gold", "gold_all", "pool", "vibe", "exercise", "idea", "archive", "memory", "ignore", "unsorted",
];

#[tauri::command]
async fn status(state: State<'_, AppState>) -> AppResult<Status> {
    let logged_in = state.spotify.has_login().await;
    let ml_available = ml::available(&state.db);
    let cooldown_secs = state.spotify.cooldown_left();
    let conn = db::lock(&state.db);
    let ml_trained_at: Option<String> = conn
        .query_row("SELECT value FROM ml_meta WHERE key = 'trained_at'", [], |r| r.get(0))
        .ok()
        .and_then(|v: String| serde_json::from_str(&v).ok());
    let ml_songs: i64 =
        conn.query_row("SELECT COUNT(*) FROM ml_audio WHERE status = 'ok'", [], |r| r.get(0))?;
    Ok(Status {
        ml_songs,
        suggestion_stats: sorting::suggestion_stats(&conn)?,
        missing_scopes: match db::get_setting(&conn, "granted_scopes")? {
            // Unknown until the next token refresh records it.
            None => Vec::new(),
            Some(granted) => {
                let granted: Vec<&str> = granted.split_whitespace().collect();
                spotify::SCOPES
                    .split_whitespace()
                    .filter(|s| !granted.contains(s))
                    .map(str::to_owned)
                    .collect()
            }
        },
        cooldown_secs,
        ml_available,
        ml_running: ml::is_running(),
        ml_trained_at,
        has_client_id: !state.spotify.client_id().is_empty(),
        logged_in,
        display_name: db::get_setting(&conn, "display_name")?,
        redirect_uri: spotify::REDIRECT_URI.to_owned(),
        api_calls_today: db::api_calls_today(&conn)?,
        last_sync: db::get_setting(&conn, "last_sync")?,
        can_revert: sorting::can_revert(&conn)?,
    })
}

#[tauri::command]
fn set_client_id(state: State<'_, AppState>, client_id: String) -> AppResult<()> {
    let client_id = client_id.trim().to_owned();
    db::set_setting(&db::lock(&state.db), "client_id", &client_id)?;
    state.spotify.set_client_id(client_id);
    Ok(())
}

#[tauri::command]
async fn login(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    state
        .spotify
        .login(|url| {
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(|e| AppError::msg(format!("Couldn't open the browser: {e}")))
        })
        .await?;
    let me = state.spotify.me().await?;
    let conn = db::lock(&state.db);
    if let Some(id) = me["id"].as_str() {
        // A different account invalidates everything cached for the old one.
        if db::get_setting(&conn, "user_id")?.as_deref().is_some_and(|old| old != id) {
            conn.execute_batch(
                "DELETE FROM playlists; DELETE FROM playlist_tracks; DELETE FROM liked;
                 DELETE FROM liked_override; DELETE FROM staged;",
            )?;
        }
        db::set_setting(&conn, "user_id", id)?;
    }
    if let Some(name) = me["display_name"].as_str() {
        db::set_setting(&conn, "display_name", name)?;
    }
    Ok(())
}

#[tauri::command]
fn cancel_login(state: State<'_, AppState>) {
    state.spotify.cancel_login();
}

#[tauri::command]
async fn logout(state: State<'_, AppState>) -> AppResult<()> {
    state.spotify.logout().await;
    db::delete_setting(&db::lock(&state.db), "display_name")?;
    Ok(())
}

#[tauri::command]
async fn sync_library(app: AppHandle, state: State<'_, AppState>, force: bool) -> AppResult<SyncSummary> {
    sync::sync_library(&app, &state.db, &state.spotify, force).await
}

/// Analyses new songs' audio and lyrics, retrains, and rescores Liked Songs.
#[tauri::command]
async fn run_ml(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    ml::run_update(&app, &state.db, &state.db_path).await?;
    *state.vectors.lock().unwrap_or_else(|p| p.into_inner()) = None;
    Ok(())
}

#[tauri::command]
async fn explore_grow(
    state: State<'_, AppState>,
    playlist_id: String,
    include_internal: bool,
) -> AppResult<Vec<explore::Match>> {
    explore_task(&state, move |index, conn| explore::grow(index, conn, &playlist_id, include_internal)).await
}

#[tauri::command]
async fn explore_misfits(state: State<'_, AppState>, playlist_id: String) -> AppResult<Vec<explore::Match>> {
    explore_task(&state, move |index, conn| explore::misfits(index, conn, &playlist_id)).await
}

#[tauri::command]
async fn explore_similar(
    state: State<'_, AppState>,
    track_ids: Vec<String>,
    include_internal: bool,
) -> AppResult<Vec<explore::Match>> {
    explore_task(&state, move |index, conn| {
        explore::find(index, conn, &track_ids, explore::Seeds::Picks, include_internal)
    })
    .await
}

#[tauri::command]
fn search_library(state: State<'_, AppState>, query: String) -> AppResult<Vec<model::Track>> {
    explore::search(&db::lock(&state.db), &query)
}

#[tauri::command]
async fn add_tracks(state: State<'_, AppState>, playlist_id: String, track_ids: Vec<String>) -> AppResult<usize> {
    sorting::add_tracks(&state.db, &state.spotify, &playlist_id, &track_ids).await
}

#[tauri::command]
async fn remove_tracks(state: State<'_, AppState>, playlist_id: String, track_ids: Vec<String>) -> AppResult<usize> {
    sorting::remove_tracks(&state.db, &state.spotify, &playlist_id, &track_ids).await
}

#[tauri::command]
async fn create_playlist(state: State<'_, AppState>, name: String, track_ids: Vec<String>) -> AppResult<String> {
    sorting::create_playlist(&state.db, &state.spotify, &name, &track_ids).await
}

#[tauri::command]
fn get_playlists(state: State<'_, AppState>) -> AppResult<Vec<PlaylistRow>> {
    let conn = db::lock(&state.db);
    let mut stmt = conn.prepare(
        "SELECT id, name, total, image_url, kind, mood, pace, description, owned
         FROM playlists WHERE present = 1 ORDER BY list_position",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(PlaylistRow {
                id: r.get(0)?,
                name: r.get(1)?,
                total: r.get(2)?,
                image_url: r.get(3)?,
                kind: r.get(4)?,
                mood: r.get(5)?,
                pace: r.get(6)?,
                description: r.get(7)?,
                owned: r.get(8)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

#[tauri::command]
fn update_playlist(
    state: State<'_, AppState>,
    id: String,
    kind: String,
    mood: Option<String>,
    pace: Option<String>,
    description: Option<String>,
) -> AppResult<()> {
    if !KINDS.contains(&kind.as_str()) {
        return Err(AppError::msg(format!("Unknown category “{kind}”")));
    }
    let mood = mood.filter(|m| matches!(m.as_str(), "positive" | "negative"));
    let pace = pace.filter(|p| matches!(p.as_str(), "high" | "med" | "low"));
    let description = description.map(|d| d.trim().to_owned()).filter(|d| !d.is_empty());
    db::lock(&state.db).execute(
        "UPDATE playlists SET kind = ?2, mood = ?3, pace = ?4, description = ?5 WHERE id = ?1",
        params![id, kind, mood, pace, description],
    )?;
    Ok(())
}

#[tauri::command]
fn get_queue(state: State<'_, AppState>) -> AppResult<Vec<QueueItem>> {
    sorting::queue(&db::lock(&state.db))
}

#[tauri::command]
fn get_track_context(state: State<'_, AppState>, track_id: String) -> AppResult<TrackContext> {
    sorting::track_context(&db::lock(&state.db), &track_id)
}

#[tauri::command]
fn stage(
    state: State<'_, AppState>,
    track_id: String,
    playlist_ids: Vec<String>,
    unlike: bool,
    shown: Vec<String>,
    audio_analysed: bool,
) -> AppResult<()> {
    sorting::stage(&db::lock(&state.db), &track_id, &playlist_ids, unlike, &shown, audio_analysed)
}

#[tauri::command]
fn unstage(state: State<'_, AppState>, track_id: String) -> AppResult<()> {
    sorting::unstage(&db::lock(&state.db), &track_id)
}

#[tauri::command]
async fn commit(state: State<'_, AppState>) -> AppResult<CommitSummary> {
    sorting::commit(&state.db, &state.spotify).await
}

#[tauri::command]
async fn revert_last_commit(state: State<'_, AppState>) -> AppResult<CommitSummary> {
    sorting::revert_last_commit(&state.db, &state.spotify).await
}

#[tauri::command]
fn open_in_spotify(app: AppHandle, uri: String) -> AppResult<()> {
    if !uri.starts_with("spotify:") {
        return Err(AppError::msg("Not a Spotify URI"));
    }
    app.opener()
        .open_url(uri, None::<&str>)
        .map_err(|e| AppError::msg(e.to_string()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let db_path = dir.join("sorter.db");
            let conn = db::open(&db_path)?;
            let client_id = db::get_setting(&conn, "client_id")?
                .or_else(|| option_env!("SPOTIFY_CLIENT_ID").map(str::to_owned))
                .unwrap_or_default();
            let db: Db = Arc::new(Mutex::new(conn));
            app.manage(AppState {
                spotify: Spotify::new(client_id, db.clone()),
                db,
                db_path,
                vectors: Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            status,
            set_client_id,
            login,
            cancel_login,
            logout,
            sync_library,
            run_ml,
            explore_grow,
            explore_misfits,
            explore_similar,
            search_library,
            add_tracks,
            remove_tracks,
            create_playlist,
            get_playlists,
            update_playlist,
            get_queue,
            get_track_context,
            stage,
            unstage,
            commit,
            revert_last_commit,
            open_in_spotify,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Spotify Sorter");
}
