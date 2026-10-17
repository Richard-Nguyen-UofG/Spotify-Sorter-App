//! Runs the Python audio/lyrics pipeline (ml/sorter_ml.py) and relays its progress.
//!
//! The pipeline is optional: without the venv the app falls back to artist history alone.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;

use crate::db::{self, Db};
use crate::error::{AppError, AppResult};
use crate::model::SyncProgress;

static RUNNING: AtomicBool = AtomicBool::new(false);

/// Where the pipeline lives. Defaults to the repo's ml/ folder (baked in at compile time);
/// `ml_python` / `ml_script` settings override it.
pub fn paths(db: &Db) -> (PathBuf, PathBuf) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("ml");
    let conn = db::lock(db);
    let python = db::get_setting(&conn, "ml_python")
        .ok()
        .flatten()
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join(".venv").join("Scripts").join("python.exe"));
    let script = db::get_setting(&conn, "ml_script")
        .ok()
        .flatten()
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("sorter_ml.py"));
    (python, script)
}

pub fn available(db: &Db) -> bool {
    let (python, script) = paths(db);
    python.exists() && script.exists()
}

pub fn is_running() -> bool {
    RUNNING.load(Ordering::SeqCst)
}

struct RunningGuard;
impl Drop for RunningGuard {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::SeqCst);
    }
}

pub async fn run_update(app: &AppHandle, db: &Db, db_path: &Path) -> AppResult<()> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err(AppError::msg("Audio analysis is already running."));
    }
    let _guard = RunningGuard;
    let (python, script) = paths(db);
    if !python.exists() || !script.exists() {
        return Err(AppError::msg("Audio analysis isn't set up (ml/.venv not found)."));
    }

    let mut cmd = Command::new(&python);
    cmd.arg(&script)
        .arg("update")
        .arg("--db")
        .arg(db_path)
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUNBUFFERED", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashing up

    let mut child = cmd.spawn()?;
    let stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let stderr_task = tokio::spawn(async move {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text).await;
        text
    });

    let mut lines = BufReader::new(stdout).lines();
    let mut last_error = None;
    while let Some(line) = lines.next_line().await? {
        let Ok(event) = serde_json::from_str::<Value>(&line) else { continue };
        let stage = event["stage"].as_str().unwrap_or_default();
        let message = event["message"].as_str().unwrap_or_default().to_owned();
        if stage == "error" {
            last_error = Some(message.clone());
        }
        let _ = app.emit(
            "ml-progress",
            SyncProgress {
                message,
                done: event["done"].as_u64().unwrap_or(0) as usize,
                total: event["total"].as_u64().unwrap_or(0) as usize,
            },
        );
    }

    let status = child.wait().await?;
    let stderr_text = stderr_task.await.unwrap_or_default();
    if status.success() {
        Ok(())
    } else {
        let tail: String = stderr_text.lines().rev().take(3).collect::<Vec<_>>().join(" | ");
        Err(AppError::msg(format!(
            "Audio analysis failed: {}",
            last_error.unwrap_or(tail)
        )))
    }
}
