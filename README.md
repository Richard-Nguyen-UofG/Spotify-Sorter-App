# Spotify Sorter

A Windows desktop app for a weekly Liked Songs routine: go through the songs you've finished
listening to, file each one into the right playlists, and unlike it — in one batch, with undo.

Built with [Tauri 2](https://tauri.app) (Rust backend, React + TypeScript UI). Your library is
mirrored into a local SQLite database, so the app only talks to Spotify when something changed.

## How filing works

- **Defaults:** the current semester playlist (from the date you liked the song; Winter = Jan–Apr,
  Summer = May–Aug, Fall = Sep–Dec) and Internal are ticked automatically.
- **Automatic extras:** Skimmed Internal when a song earns any real playlist, the matching pool when
  you pick a vibe playlist, and the all-time Gold playlist when you pick a year's Gold.
- **Suggestions:** playlists where the song's artists already appear, plus a mood × pace grid that
  narrows the vibe playlists to a handful.
- **Staging:** decisions stay local until you click **Commit**, which sends one request per playlist
  and unlikes in batches. **Undo last commit** reverses the most recent commit.

Spotify's API doesn't expose folders, so the **Playlists** tab maps each playlist to a category once
(vibe with mood and pace, pool, exercise, random idea, semester, Gold, archived, memory, ignore).

## Setup

1. Install [Rust](https://rustup.rs) and Node.js 20+.
2. In your app on the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard), select
   **Web API** and add the redirect URI `http://127.0.0.1:8898/callback`.
3. Put your Client ID in `.env.local` at the repo root:
   ```
   VITE_SPOTIFY_CLIENT_ID=your_client_id
   ```
   (or enter it on the app's login screen).
4. `npm install`

## Running

| Command | What it does |
|---|---|
| `npm run app` | Runs the app in development mode |
| `npm run package` | Builds a Windows installer into `src-tauri/target/release/bundle/nsis` |
| `npm run typecheck` | Type-checks the frontend |
| `cd src-tauri && cargo test` | Runs the Rust tests |

Data lives in `%APPDATA%\com.richardnguyen.spotifysorter\sorter.db`; the Spotify login is stored in
Windows Credential Manager.

## Audio and lyrics suggestions (optional)

`ml/sorter_ml.py` suggests playlists from what a song sounds like:

- **Audio:** each song's 30 s Deezer preview (looked up by ISRC) is embedded with the
  [CLAP music model](https://huggingface.co/laion/larger_clap_music) on the GPU. Previews are
  decoded in memory and discarded; only the embedding is stored.
- **Lyrics:** fetched from [LRCLIB](https://lrclib.net) (rate-limited to 2 requests/s) and
  embedded with a multilingual sentence model.
- **Sound-alikes:** for each Liked Song, the 120 most similar songs in your library vote for the
  playlists they're in. The app blends that with artist history (history weighted 2×).

Cross-validated on the author's library (vibe playlist in the top 3): artist history alone 47%,
sound-alikes + history 63%; for artists with no history, 0% → 43%. A trained linear model and
mood/pace prediction were tried and did no better than these baselines, so they were dropped.

The app runs it after each sync (only new songs need downloading) and from **Analyse audio** in the
top bar. Local files are never synced, so they're never analysed.

Setup (Windows, NVIDIA GPU; CPU works but is slower):

```
py -3.10 -m venv ml/.venv
ml/.venv/Scripts/python -m pip install torch --index-url https://download.pytorch.org/whl/cu128
ml/.venv/Scripts/python -m pip install -r ml/requirements.txt
```

`ml/.venv/Scripts/python ml/sorter_ml.py eval` prints a cross-validated report comparing the model
with artist-history suggestions.

## Spotify API notes

The client targets the February 2026 Development Mode API (`/playlists/{id}/items`, `/me/library`,
search capped at 10 results, no batch track/artist lookups). Requests are paced, retried on short
rate limits, and counted per day (shown in the top bar). Refresh tokens expire after six months,
after which the app asks you to log in again.

## Legacy web app

The original Vite web app (Analyzer, Harmonic Flow, Deep Cuts, Musicae acoustic data) lives in
[`legacy/`](legacy/). Run it with `npm install && npm run dev` inside that folder.
