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

## Audio, lyrics and genre suggestions (optional)

`ml/sorter_ml.py` suggests playlists from what a song sounds like, what it's about, and its
artists' genres:

- **Audio:** each song's 30 s Deezer preview (looked up by ISRC) is embedded with
  [MERT-v1-95M](https://huggingface.co/m-a-p/MERT-v1-95M) (one middle layer, averaged over the
  clip) on the GPU. Previews are decoded in memory and discarded; only the embedding is stored.
  Changing the audio model re-analyses every song automatically.
- **Lyrics:** fetched from [LRCLIB](https://lrclib.net) (one request at a time, 1 per second, as its API guidelines ask) and
  embedded with a multilingual sentence model.
- **Artist genres:** looked up on [MusicBrainz](https://musicbrainz.org) (via its link to the
  artist's Spotify page, else an unambiguous exact-name match; 1 request/s), using curated genres
  plus the top community tags. Only tags shared by 5+ of your kept songs are used. Spotify no
  longer returns artist genres to Development Mode apps.
- **Sound-alikes:** each song's audio, lyrics (equal weight) and genres (0.6×) form one vector.
  For each Liked Song, the 120 most similar kept songs vote for the playlists they're in. The app
  blends that with artist history (history weighted 2×).

How well it does, on the author's library. Each song is predicted only from songs filed before
its quarter (last 8 quarters, 474 songs going into playlists that already existed) and judged on
the vibe playlists picked when it was first sorted (later backfills don't count):

| | Top pick right | Right one in top 3 | Among the 9 suggested vibes |
|---|---|---|---|
| MERT audio + lyrics + artist history | 40% | 64% | 84% |
| **+ MusicBrainz genres (current)** | **43%** | **68%** | **86%** |

(With 31 vibe playlists and usually one right answer, chance is ~3% for the top pick.)

Also tried and not adopted, each no better than the baseline on this test: CLAP audio (MERT beat
it by ~5 points on a random split), MERT-v1-330M and other layers, CLAP and MERT combined, Qwen3-4B
lyric labels (mood, themes), weighting recent filings more, a learned similarity metric, a trained
linear model, mood/pace prediction, and several weighting tweaks. Leaving pools, exercise and
Random Ideas out of the Suggested row raised vibe picks among the chips from 63% to 77%.

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

The original Vite web app (Analyzer, Harmonic Flow, Deep Cuts, Musicae acoustic data) was removed;
it's in git history at commit `67a80b5` (`git checkout 67a80b5 -- legacy` restores it).
