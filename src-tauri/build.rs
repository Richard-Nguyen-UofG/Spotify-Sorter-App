fn main() {
    // Bake the Spotify Client ID from the repo's .env.local (shared with the legacy web app)
    // so it doesn't have to be typed in on first launch. It can also be set in the app.
    println!("cargo:rerun-if-changed=../.env.local");
    if let Ok(text) = std::fs::read_to_string("../.env.local") {
        for line in text.lines() {
            if let Some(value) = line.trim().strip_prefix("VITE_SPOTIFY_CLIENT_ID=") {
                let value = value.trim().trim_matches('"').trim_matches('\'');
                if !value.is_empty() {
                    println!("cargo:rustc-env=SPOTIFY_CLIENT_ID={value}");
                }
            }
        }
    }
    tauri_build::build()
}
