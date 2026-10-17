# Spotify Sorter App

An intelligent, multi-mode Spotify companion application for music curation, harmonic sequencing, song-to-playlist reverse matching, and under-represented artist discovery.

## Features & Modes

1. **Curate Playlists (Analyzer & Harmonic Flow)**:
   - Identifies outliers in target playlists and recommends harmonic additions from your master pool.
   - Generates 1-click **Harmonic Flow** sequenced playlist copies based on Camelot key progression and tempo curves.
2. **Sort New Songs (Song-to-Playlist Matcher)**:
   - Pulls from Recently Played, Liked Songs, Search, or Custom Inboxes.
   - Calculates 5D acoustic centroids and compatibility scores ($0\% - 100\%$) against your destination playlists with 1-click add.
3. **Deep Cuts (Under-Represented Artist Discovery Engine)**:
   - Scans your library pool to identify artists with $\le 1-3$ songs.
   - Pulls unheard top tracks from Spotify with 3-layer cross-release deduplication (Spotify ID, ISRC, and normalized Title+Artist).
   - Integrated persistent artist exclusion blacklist and 1-click Spotify playlist creation.

---

## 📊 API Scaling & Request Complexity

For a complete breakdown of API requests, Big-O scaling complexity, caching mechanics, and rate limit boundaries for all modes, see:

👉 **[API-SCALING-GUIDE.md](API-SCALING-GUIDE.md)**

---

**Note:** Acoustic feature and Camelot key data powered by Spotify Web API, Musicae.io, and GetSongBPM.
