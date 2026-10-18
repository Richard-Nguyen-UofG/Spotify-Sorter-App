use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("NOT_LOGGED_IN: Spotify login required")]
    NotLoggedIn,
    #[error("Spotify is rate limiting requests. Try again in about {0} seconds.")]
    RateLimited(u64),
    /// A 429 marked QUOTA_EXCEEDED. Spotify doesn't publish the quota or its window, so the
    /// message only repeats what Spotify said.
    #[error("Spotify says this developer account is over its request quota (QUOTA_EXCEEDED); it asked to wait about {wait_secs} s. Spotify's message: {message}")]
    QuotaExceeded { wait_secs: u64, message: String },
    #[error("Spotify API error {status} on {endpoint}: {body}")]
    Api {
        status: u16,
        endpoint: String,
        body: String,
    },
    #[error("{0}")]
    Msg(String),
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error(transparent)]
    Db(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl AppError {
    pub fn msg(text: impl Into<String>) -> Self {
        AppError::Msg(text.into())
    }
}

// Commands return errors to the frontend as plain strings.
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
