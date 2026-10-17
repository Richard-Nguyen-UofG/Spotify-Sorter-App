//! Spotify Web API client: PKCE login, token refresh, pacing and retries.
//!
//! Every request goes through `call`, which spaces requests out, refreshes the token once on
//! 401, honours short `Retry-After` waits, and counts calls per day so usage stays visible.
//! Endpoints follow the February 2026 Development Mode API (playlist `/items`, `/me/library`).

use std::collections::HashMap;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use reqwest::header::RETRY_AFTER;
use reqwest::Method;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};

use crate::db::{self, Db};
use crate::error::{AppError, AppResult};

const API: &str = "https://api.spotify.com/v1";
const AUTHORIZE_URL: &str = "https://accounts.spotify.com/authorize";
const TOKEN_URL: &str = "https://accounts.spotify.com/api/token";
pub const REDIRECT_PORT: u16 = 8898;
pub const REDIRECT_URI: &str = "http://127.0.0.1:8898/callback";
const SCOPES: &str = "playlist-read-private playlist-read-collaborative playlist-modify-public \
playlist-modify-private user-library-read user-library-modify user-read-recently-played";

/// Minimum gap between requests. Spotify's limit is a rolling 30s window; this keeps bursts
/// (like a first full sync) well under it.
const MIN_GAP: Duration = Duration::from_millis(250);
const KEYRING_SERVICE: &str = "spotify-sorter";
const KEYRING_USER: &str = "refresh_token";

struct Tokens {
    access: Option<String>,
    expires_at: Instant,
    refresh: Option<String>,
}

pub struct Spotify {
    http: reqwest::Client,
    client_id: StdMutex<String>,
    tokens: Mutex<Tokens>,
    pacer: Mutex<Instant>,
    login_cancel: StdMutex<Option<oneshot::Sender<()>>>,
    db: Db,
}

fn keyring_entry() -> AppResult<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| AppError::msg(format!("Windows Credential Manager unavailable: {e}")))
}

fn load_refresh_token() -> Option<String> {
    keyring_entry().ok()?.get_password().ok()
}

fn store_refresh_token(token: &str) -> AppResult<()> {
    keyring_entry()?
        .set_password(token)
        .map_err(|e| AppError::msg(format!("Couldn't save login to Credential Manager: {e}")))
}

fn random_urlsafe(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

impl Spotify {
    pub fn new(client_id: String, db: Db) -> Self {
        Spotify {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .expect("HTTP client"),
            client_id: StdMutex::new(client_id),
            tokens: Mutex::new(Tokens {
                access: None,
                expires_at: Instant::now(),
                refresh: load_refresh_token(),
            }),
            pacer: Mutex::new(Instant::now() - MIN_GAP),
            login_cancel: StdMutex::new(None),
            db,
        }
    }

    pub fn client_id(&self) -> String {
        self.client_id.lock().map(|c| c.clone()).unwrap_or_default()
    }

    pub fn set_client_id(&self, id: String) {
        if let Ok(mut c) = self.client_id.lock() {
            *c = id;
        }
    }

    pub async fn has_login(&self) -> bool {
        self.tokens.lock().await.refresh.is_some()
    }

    pub async fn logout(&self) {
        let mut tokens = self.tokens.lock().await;
        tokens.access = None;
        tokens.refresh = None;
        if let Ok(entry) = keyring_entry() {
            let _ = entry.delete_credential();
        }
    }

    // ---------------------------------------------------------------- login

    /// Runs the PKCE flow: opens the browser, waits for Spotify to redirect back to the
    /// loopback listener, then exchanges the code for tokens.
    pub async fn login(&self, open_browser: impl FnOnce(&str) -> AppResult<()>) -> AppResult<()> {
        let client_id = self.client_id();
        if client_id.is_empty() {
            return Err(AppError::msg("Set your Spotify Client ID first."));
        }
        let verifier = random_urlsafe(64);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let state = random_urlsafe(16);

        // A new attempt replaces any login still waiting on the redirect port.
        self.cancel_login();
        let (cancel_tx, cancel_rx) = oneshot::channel();
        if let Ok(mut slot) = self.login_cancel.lock() {
            *slot = Some(cancel_tx);
        }
        let listener = bind_redirect_port().await?;

        let auth_url = url::Url::parse_with_params(
            AUTHORIZE_URL,
            &[
                ("client_id", client_id.as_str()),
                ("response_type", "code"),
                ("redirect_uri", REDIRECT_URI),
                ("scope", SCOPES),
                ("code_challenge_method", "S256"),
                ("code_challenge", challenge.as_str()),
                ("state", state.as_str()),
            ],
        )
        .map_err(|e| AppError::msg(e.to_string()))?;
        open_browser(auth_url.as_str())?;

        let params = tokio::select! {
            result = tokio::time::timeout(Duration::from_secs(300), wait_for_callback(listener)) => {
                result.map_err(|_| AppError::msg("Login timed out after 5 minutes."))??
            }
            _ = cancel_rx => return Err(AppError::msg("Login cancelled.")),
        };

        if params.get("state") != Some(&state) {
            return Err(AppError::msg("Login response didn't match this request. Try again."));
        }
        if let Some(err) = params.get("error") {
            return Err(AppError::msg(format!("Spotify login was cancelled ({err}).")));
        }
        let code = params
            .get("code")
            .ok_or_else(|| AppError::msg("Spotify didn't return a login code."))?;

        let resp = self
            .http
            .post(TOKEN_URL)
            .form(&[
                ("client_id", client_id.as_str()),
                ("grant_type", "authorization_code"),
                ("code", code.as_str()),
                ("redirect_uri", REDIRECT_URI),
                ("code_verifier", verifier.as_str()),
            ])
            .send()
            .await?;
        let status = resp.status();
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            return Err(AppError::msg(format!(
                "Token exchange failed: {}",
                body["error_description"].as_str().unwrap_or("unknown error")
            )));
        }
        let mut tokens = self.tokens.lock().await;
        apply_token_response(&mut tokens, &body)
    }

    /// Stops a login that's waiting for the browser (e.g. the user closed the tab).
    pub fn cancel_login(&self) {
        if let Some(tx) = self.login_cancel.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = tx.send(());
        }
    }

    // ---------------------------------------------------------------- tokens

    async fn access_token(&self) -> AppResult<String> {
        let mut tokens = self.tokens.lock().await;
        if let Some(access) = &tokens.access {
            if Instant::now() + Duration::from_secs(60) < tokens.expires_at {
                return Ok(access.clone());
            }
        }
        // Holding the lock while refreshing means concurrent callers share one refresh.
        self.refresh(&mut tokens).await?;
        tokens.access.clone().ok_or(AppError::NotLoggedIn)
    }

    async fn force_refresh(&self) -> AppResult<()> {
        let mut tokens = self.tokens.lock().await;
        self.refresh(&mut tokens).await
    }

    async fn refresh(&self, tokens: &mut Tokens) -> AppResult<()> {
        let refresh = tokens.refresh.clone().ok_or(AppError::NotLoggedIn)?;
        let resp = self
            .http
            .post(TOKEN_URL)
            .form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh.as_str()),
                ("client_id", self.client_id().as_str()),
            ])
            .send()
            .await?;
        let status = resp.status();
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            if body["error"] == "invalid_grant" || body["error"] == "invalid_client" {
                // Refresh tokens now expire after six months, and a token from a different
                // Client ID is useless; either way the user has to log in again.
                tokens.access = None;
                tokens.refresh = None;
                if let Ok(entry) = keyring_entry() {
                    let _ = entry.delete_credential();
                }
                return Err(AppError::NotLoggedIn);
            }
            return Err(AppError::msg(format!("Token refresh failed ({status}): {body}")));
        }
        apply_token_response(tokens, &body)
    }

    // ---------------------------------------------------------------- requests

    async fn pace(&self) {
        let mut last = self.pacer.lock().await;
        let next = *last + MIN_GAP;
        let now = Instant::now();
        if next > now {
            tokio::time::sleep(next - now).await;
        }
        *last = Instant::now();
    }

    fn count_call(&self) {
        let conn = db::lock(&self.db);
        let _ = db::bump_api_calls(&conn);
    }

    /// `path` is relative to the API root, or a full `next` URL from a paging object.
    pub async fn call(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<&Value>,
    ) -> AppResult<Value> {
        let url = if path.starts_with("https://") {
            path.to_owned()
        } else {
            format!("{API}/{path}")
        };
        let mut refreshed = false;
        let mut attempt = 0u32;
        loop {
            attempt += 1;
            let token = self.access_token().await?;
            self.pace().await;
            let mut req = self.http.request(method.clone(), &url).bearer_auth(&token);
            if !query.is_empty() {
                req = req.query(query);
            }
            if let Some(b) = body {
                req = req.json(b);
            }
            self.count_call();
            let resp = req.send().await?;
            let status = resp.status();

            if status.as_u16() == 401 && !refreshed {
                refreshed = true;
                self.force_refresh().await?;
                continue;
            }
            if status.as_u16() == 429 {
                let wait = resp
                    .headers()
                    .get(RETRY_AFTER)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.trim().parse::<u64>().ok())
                    .unwrap_or(5);
                let text = resp.text().await.unwrap_or_default();
                if text.contains("QUOTA_EXCEEDED") {
                    return Err(AppError::QuotaExceeded);
                }
                if wait <= 30 && attempt < 4 {
                    tokio::time::sleep(Duration::from_secs(wait + 1)).await;
                    continue;
                }
                return Err(AppError::RateLimited(wait));
            }
            if status.is_server_error() && attempt < 3 {
                tokio::time::sleep(Duration::from_millis(1500 * attempt as u64)).await;
                continue;
            }

            let text = resp.text().await?;
            if !status.is_success() {
                return Err(AppError::Api {
                    status: status.as_u16(),
                    endpoint: path.split('?').next().unwrap_or(path).replace(API, ""),
                    body: text.chars().take(300).collect(),
                });
            }
            return Ok(if text.trim().is_empty() {
                Value::Null
            } else {
                serde_json::from_str(&text)?
            });
        }
    }

    pub async fn get(&self, path: &str) -> AppResult<Value> {
        self.call(Method::GET, path, &[], None).await
    }

    /// Follows `next` links and returns every item.
    pub async fn get_all_pages(&self, first: &str) -> AppResult<Vec<Value>> {
        let mut items = Vec::new();
        let mut next = Some(first.to_owned());
        while let Some(path) = next {
            let page = self.get(&path).await?;
            if let Some(list) = page["items"].as_array() {
                items.extend(list.iter().cloned());
            }
            next = page["next"].as_str().map(str::to_owned);
        }
        Ok(items)
    }

    // ---------------------------------------------------------------- endpoints

    pub async fn me(&self) -> AppResult<Value> {
        self.get("me").await
    }

    /// Adds up to 100 URIs; returns the playlist's new snapshot_id.
    pub async fn add_to_playlist(&self, playlist_id: &str, uris: &[String]) -> AppResult<Option<String>> {
        let resp = self
            .call(
                Method::POST,
                &format!("playlists/{playlist_id}/items"),
                &[],
                Some(&json!({ "uris": uris })),
            )
            .await?;
        Ok(resp["snapshot_id"].as_str().map(str::to_owned))
    }

    /// Removes every occurrence of the URIs (up to 100) from the playlist.
    pub async fn remove_from_playlist(&self, playlist_id: &str, uris: &[String]) -> AppResult<Option<String>> {
        let items: Vec<Value> = uris.iter().map(|u| json!({ "uri": u })).collect();
        let resp = self
            .call(
                Method::DELETE,
                &format!("playlists/{playlist_id}/items"),
                &[],
                Some(&json!({ "items": items })),
            )
            .await?;
        Ok(resp["snapshot_id"].as_str().map(str::to_owned))
    }

    /// Unlikes up to 40 tracks (removes them from Liked Songs).
    pub async fn library_remove(&self, uris: &[String]) -> AppResult<()> {
        self.call(Method::DELETE, "me/library", &[("uris", uris.join(","))], None)
            .await
            .map(|_| ())
    }

    /// Likes up to 40 tracks again (used by "revert last commit").
    pub async fn library_save(&self, uris: &[String]) -> AppResult<()> {
        self.call(Method::PUT, "me/library", &[("uris", uris.join(","))], None)
            .await
            .map(|_| ())
    }
}

fn apply_token_response(tokens: &mut Tokens, body: &Value) -> AppResult<()> {
    let access = body["access_token"]
        .as_str()
        .ok_or_else(|| AppError::msg("Spotify didn't return an access token."))?;
    let expires_in = body["expires_in"].as_u64().unwrap_or(3600);
    tokens.access = Some(access.to_owned());
    tokens.expires_at = Instant::now() + Duration::from_secs(expires_in);
    if let Some(refresh) = body["refresh_token"].as_str() {
        store_refresh_token(refresh)?;
        tokens.refresh = Some(refresh.to_owned());
    }
    Ok(())
}

/// Binds the loopback redirect port, briefly retrying while a cancelled login releases it.
async fn bind_redirect_port() -> AppResult<TcpListener> {
    let mut last_err = None;
    for _ in 0..20 {
        match TcpListener::bind(("127.0.0.1", REDIRECT_PORT)).await {
            Ok(listener) => return Ok(listener),
            Err(e) => {
                last_err = Some(e);
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
    Err(AppError::msg(format!(
        "Couldn't listen on port {REDIRECT_PORT} for the login redirect ({}). Is another copy of the app open?",
        last_err.map(|e| e.to_string()).unwrap_or_default()
    )))
}

async fn wait_for_callback(listener: TcpListener) -> AppResult<HashMap<String, String>> {
    loop {
        let (mut stream, _) = listener.accept().await?;
        let mut buf = vec![0u8; 8192];
        let n = stream.read(&mut buf).await?;
        let request = String::from_utf8_lossy(&buf[..n]);
        let target = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .unwrap_or("")
            .to_owned();

        if !target.starts_with("/callback") {
            // Browsers also ask for /favicon.ico and the like.
            let _ = stream
                .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await;
            continue;
        }

        let parsed = url::Url::parse(&format!("http://127.0.0.1{target}"))
            .map_err(|e| AppError::msg(e.to_string()))?;
        let params: HashMap<String, String> = parsed.query_pairs().into_owned().collect();
        let message = if params.contains_key("code") {
            "Spotify Sorter is connected. You can close this tab and go back to the app."
        } else {
            "Login didn't complete. You can close this tab and try again from the app."
        };
        let html = format!(
            "<!doctype html><meta charset=utf-8><title>Spotify Sorter</title>\
             <body style=\"font-family:system-ui;background:#121212;color:#eee;display:grid;place-items:center;height:100vh;margin:0\">\
             <p style=\"font-size:1.1rem\">{message}</p></body>"
        );
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            html.len(),
            html
        );
        let _ = stream.write_all(response.as_bytes()).await;
        return Ok(params);
    }
}
