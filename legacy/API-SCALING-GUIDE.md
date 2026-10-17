# API Call Scaling & Complexity Guide

A practical reference for understanding how many network calls are made to the **Spotify Web API** and **Musicae (RapidAPI)** across all three application modes.

---

## 1. Quick Summary & RapidAPI Free Plan Impact

If you are downgrading to the **RapidAPI Free Plan** (typically 50–100 requests/month):

```
+-------------------------------------------------------------------------------+
| RAPIDAPI (MUSICAE) QUOTA IMPACT AT A GLANCE                                  |
+------------------------------------+------------------------------------------+
| Feature Mode                       | RapidAPI Calls Consumed                  |
+------------------------------------+------------------------------------------+
| 1. Deep Cuts (Discovery Engine)    | ZERO (0) calls - 100% Free Forever       |
| 2. Sort New Songs (Matcher)        | 0 to 1 call per new song                 |
| 3. Curate Playlists (Analyzer)     | 0 calls if cached; 1 call per 5 new songs|
+------------------------------------+------------------------------------------+
```

* **Your Existing Library:** You already have **4,763 songs** resolved and cached in your database (`spotify_sorter_acoustic_library.json`). These tracks will **never** consume a RapidAPI request again.
* **Batch Multiplier:** RapidAPI fetches acoustic features in batches of **5 songs per call**. A free limit of 100 calls/month allows resolving up to **500 brand new songs every month**.

---

## 2. Best, Normal, Average & Worst Case Scenarios

Below is the breakdown of API calls for each mode under different real-world conditions.

### Mode 1: Curate Playlists (Analyzer & Harmonic Flow)

```
=================================================================================================
MODE 1: CURATE PLAYLISTS (TARGET PLAYLIST + MASTER POOLS)
=================================================================================================
Scenario        Description                     Spotify Calls   RapidAPI Calls  Time
-------------------------------------------------------------------------------------------------
BEST CASE       Playlists already cached in     10 to 15        0 calls         ~1 sec
                IndexedDB (no new songs)        (snapshot check)(0% quota used)

NORMAL CASE     Analyzing playlists with        15 to 18 calls  1 to 2 calls    ~2 to 3 sec
                5 to 10 newly added tracks      (checks + get)  (1-2 batches)

AVERAGE CASE    Adding a new 60-track playlist  18 to 22 calls  4 to 6 calls    ~4 to 6 sec
                where ~25 songs are new         (checks + get)  (25 songs / 5)

WORST CASE      Importing a 500-track playlist  25 to 30 calls  100 calls       ~30 to 45 sec
                with 0 tracks in your database  (paginated)     (500 songs / 5) *Hits Free Limit!
=================================================================================================
```

---

### Mode 2: Sort New Songs (Song-to-Playlist Reverse Matcher)

```
=================================================================================================
MODE 2: SORT NEW SONGS (SONG INBOX & PLAYLIST COMPATIBILITY)
=================================================================================================
Scenario        Description                     Spotify Calls   RapidAPI Calls  Time
-------------------------------------------------------------------------------------------------
BEST CASE       Sorting a song already in your  2 calls         0 calls         < 300 ms
                4,763-track library             (queue + add)   (cached in DB)

NORMAL CASE     Sorting 1 brand new song        2 calls         1 call          < 600 ms
                discovered this week            (queue + add)   (resolves song)

AVERAGE CASE    Sorting a batch of 5 new songs  6 calls         3 to 5 calls    ~1 to 2 sec
                from Recently Played or Search  (1 queue + 5 add)(on-demand)

WORST CASE      Sorting 50 songs from Liked     51 calls        25 to 50 calls  ~10 to 15 sec
                Songs, all 50 brand new         (1 queue + 50)  (if all unseen)
=================================================================================================
```

---

### Mode 3: Deep Cuts (Under-Represented Artist Discovery Engine)

```
=================================================================================================
MODE 3: DEEP CUTS (UNDER-REPRESENTED ARTISTS DISCOVERY)
=================================================================================================
Scenario        Description                     Spotify Calls   RapidAPI Calls  Time
-------------------------------------------------------------------------------------------------
BEST CASE       Batch of 25 artists             15 checks +     0 calls         ~1.5 sec
                (artists cached in session)     0 artist calls  (NEVER uses it)

NORMAL CASE     Recommended Batch of 35         15 checks +     0 calls         ~2 to 3 sec
(RECOMMENDED)   (35 new artists scanned)        35 top-tracks   (NEVER uses it) *100% Safe

AVERAGE CASE    Batch of 50 artists             15 checks +     0 calls         ~3 to 4 sec
                (50 artists scanned)            50 top-tracks   (NEVER uses it) *100% Safe

WORST CASE      Scanning all 2,379 artists      15 checks +     0 calls         ~8 to 10 min
(UNBATCHED)     with no batch limit             2,379 calls     (NEVER uses it) *Hits 429 Limit!
=================================================================================================
```

---

## 3. Mathematical Scaling & Request Formulas

### Legend:
* **P** = Number of playlists selected
* **T** = Total number of tracks across playlists
* **U** = Uncached tracks (tracks not yet stored in IndexedDB)
* **B** = Batch limit for Deep Cuts artists (default: 35)
* **ceil(x)** = Rounded up to next whole number

```
+-----------------------------------+-----------------------+-----------------------+
| Operation                         | Spotify Web API Calls | RapidAPI Calls        |
+-----------------------------------+-----------------------+-----------------------+
| Check Playlist Changes            | P calls               | 0 calls               |
| Download Playlist Tracks (Cold)   | ceil(T / 100) calls   | 0 calls               |
| Download Playlist Tracks (Warm)   | 0 calls (from DB)     | 0 calls               |
| Fetch Acoustic Features           | 0 calls               | ceil(U / 5) calls     |
| Create New Playlist Copy          | 1 call                | 0 calls               |
| Add Tracks to Playlist            | ceil(Tracks / 100)    | 0 calls               |
| Deep Cuts: Scan Artists           | B calls               | 0 calls               |
| Deep Cuts: Deduplication & Filter | 0 calls (local memory)| 0 calls               |
+-----------------------------------+-----------------------+-----------------------+
```

---

## 4. How to Maximize the RapidAPI Free Tier

When you downgrade to the RapidAPI Free Plan, follow these guidelines to keep your usage minimal:

1. **Keep Your IndexedDB Populated:**
   Your current database already has **4,763 tracks**. Because the app checks IndexedDB before making any network request, these tracks never cost RapidAPI calls.
2. **Export Backup Regularly:**
   Use the **Acoustic Library** modal (`Database` icon on Dashboard) -> `Export Library (JSON)` to backup your database. If you switch browsers, you can import it and immediately restore 0-call performance.
3. **Use Deep Cuts Freely:**
   Deep Cuts relies on Spotify's top tracks catalog and 3-layer local deduplication (Spotify ID, ISRC, and title normalization). It uses **zero** RapidAPI quota.
4. **Avoid Force-Refreshing Giant Uncached Playlists:**
   If you have a playlist with 500+ songs that you have never analyzed before, analyzing it in one go would consume `500 / 5 = 100` calls. Analyze smaller playlists or curate incrementally.
