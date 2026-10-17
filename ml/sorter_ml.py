"""Audio + lyrics suggestions for Spotify Sorter.

Reads the app's SQLite database and:
  1. fills in features for songs that don't have them yet:
     - audio: Deezer's 30 s preview (looked up by ISRC) -> CLAP music embedding on the GPU
     - lyrics: LRCLIB -> multilingual sentence embedding
  2. for each Liked Song, finds the songs in your library that sound most alike and scores each
     filing playlist (vibe, pool, exercise, idea) by how many of those sound-alikes it holds,
  3. writes those scores to `ml_scores`, which the app blends with artist history.

Nearest neighbours beat a trained linear model in cross-validation (see `eval`), and need no
training: new filings count as soon as the playlists sync.

Progress is printed as JSON lines so the app can show it.

Usage:
  python sorter_ml.py update [--db PATH]   # features for new songs, score Liked Songs
  python sorter_ml.py eval   [--db PATH]   # cross-validated comparison with artist history
"""

import os

# Keep stdout/stderr quiet: the app reads progress from stdout as JSON lines.
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
os.environ.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")

import argparse
import io
import json
import math
import queue
import random
import re
import sqlite3
import sys
import threading
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import numpy as np
import requests

AUDIO_MODEL = "laion/larger_clap_music"
TEXT_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
AUDIO_DIM, TEXT_DIM = 512, 384
LYRICS_WEIGHT = 0.6     # how much lyrics count next to audio when comparing songs
NEIGHBOURS = 120        # sound-alikes per song (best of 25/60/120 in cross-validation)
HISTORY_WEIGHT = 2.0    # keep in sync with HISTORY_WEIGHT in src-tauri/src/sorting.rs

KEEPER_KINDS = ("pool", "vibe", "exercise", "idea")
# Songs the user kept (Skimmed Internal or a real playlist): the sound-alike reference library.
# Searching only these beat searching every heard song in cross-validation (46% vs 44% on new
# artists): Internal-only songs belong to no playlist and just dilute the votes.
KEPT_KINDS = KEEPER_KINDS + ("skimmed", "gold", "gold_all")
# Every song the user has heard gets features, so the app can optionally search Internal-only ones.
HEARD_KINDS = KEPT_KINDS + ("internal", "semester")
MIN_MEMBERS = 5

# Songs Deezer/LRCLIB didn't have get looked up again after a while, a few per run, since
# catalogues grow (new releases often get lyrics weeks later).
RECHECK_AFTER_DAYS = 90
RECHECK_PER_RUN = 25

SR = 48000
CHUNK = 10 * SR  # CLAP looks at 10 s windows; a 30 s preview gives three.

SCHEMA = """
CREATE TABLE IF NOT EXISTS ml_audio (
    track_id   TEXT PRIMARY KEY,
    status     TEXT NOT NULL,          -- ok | no_preview | error
    source     TEXT,                   -- isrc | search
    embedding  BLOB,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ml_lyrics (
    track_id   TEXT PRIMARY KEY,
    status     TEXT NOT NULL,          -- ok | instrumental | missing | error
    embedding  BLOB,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ml_scores (
    track_id TEXT NOT NULL,
    target   TEXT NOT NULL,            -- playlist id, 'mood:positive', 'pace:high|med|low'
    score    REAL NOT NULL,
    PRIMARY KEY (track_id, target)
);
CREATE TABLE IF NOT EXISTS ml_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


# ----------------------------------------------------------------------------- plumbing

def emit(stage, message, done=0, total=0, **extra):
    print(json.dumps({"stage": stage, "message": message, "done": done, "total": total, **extra}), flush=True)


def now():
    return datetime.now(timezone.utc).isoformat()


def default_db():
    return os.path.join(os.environ.get("APPDATA", ""), "com.richardnguyen.spotifysorter", "sorter.db")


def connect(path):
    db = sqlite3.connect(path, timeout=30)
    db.execute("PRAGMA busy_timeout = 30000")
    db.executescript(SCHEMA)
    return db


def set_meta(db, key, value):
    db.execute("INSERT OR REPLACE INTO ml_meta (key, value) VALUES (?, ?)", (key, json.dumps(value)))
    db.commit()


class RateLimiter:
    def __init__(self, per_second):
        self.gap = 1.0 / per_second
        self.lock = threading.Lock()
        self.next = 0.0

    def wait(self):
        with self.lock:
            t = max(time.monotonic(), self.next)
            self.next = t + self.gap
        time.sleep(max(0.0, t - time.monotonic()))


SESSION = requests.Session()
# LRCLIB requires the app name, version and a homepage link (or email) in the User-Agent.
SESSION.headers["User-Agent"] = "SpotifySorter v0.1 (https://github.com/Richard-Nguyen-UofG/Spotify-Sorter-App)"
DEEZER = RateLimiter(8)      # Deezer allows 50 requests / 5 s
# LRCLIB quotes ~90 requests/min for identified clients and asks for one request at a time with
# a short pause between. In practice 75/min still drew a "wait" on most songs, so use 60/min.
LRCLIB = RateLimiter(1.0)


# How often a server answered 429/503 ("slow down"); shown in progress messages.
SERVER_WAITS = defaultdict(int)


def retry_after(response, attempt):
    """Seconds to wait before retrying: the server's Retry-After plus up to 30% jitter, else backoff."""
    try:
        wait = float(response.headers.get("Retry-After", ""))
    except ValueError:
        wait = 2 ** attempt + 1
    return wait * (1 + random.uniform(0, 0.3))


def get_json(url, params=None, limiter=None, tries=5):
    """GET JSON, retrying transient failures (honouring Retry-After); None on 404."""
    for attempt in range(tries):
        if limiter:
            limiter.wait()
        try:
            r = SESSION.get(url, params=params, timeout=20)
        except requests.RequestException:
            time.sleep(2 ** attempt)
            continue
        if r.status_code == 404:
            return None
        if r.status_code in (429, 500, 502, 503, 504):
            if r.status_code in (429, 503):
                SERVER_WAITS[url.split("/")[2]] += 1
            time.sleep(retry_after(r, attempt))
            continue
        r.raise_for_status()
        return r.json()
    raise RuntimeError(f"{url} kept failing")


def norm(s):
    return re.sub(r"[^\w]+", " ", (s or "").lower()).strip()


def load_tracks(db, ids):
    out = {}
    for tid in ids:
        row = db.execute(
            "SELECT t.id, t.name, t.isrc, t.duration_ms, t.album,"
            " (SELECT artist_name FROM track_artists WHERE track_id = t.id ORDER BY position LIMIT 1)"
            " FROM tracks t WHERE t.id = ?", (tid,)).fetchone()
        if row:
            out[tid] = dict(zip(("id", "name", "isrc", "duration_ms", "album", "artist"), row))
    return out


def stale_misses(db, table, status, ids):
    """Up to RECHECK_PER_RUN songs (of `ids`) marked `status` longest ago, if over RECHECK_AFTER_DAYS.

    A re-check that misses again rewrites updated_at, so the backlog rotates through over time.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(days=RECHECK_AFTER_DAYS)).isoformat()
    wanted = set(ids)
    rows = db.execute(
        f"SELECT track_id FROM {table} WHERE status = ? AND updated_at < ? ORDER BY updated_at",
        (status, cutoff))
    return [tid for (tid,) in rows if tid in wanted][:RECHECK_PER_RUN]


def tracks_needing_features(db):
    """Songs that matter for filing: anything heard, plus the current Liked Songs."""
    kinds = ",".join(f"'{k}'" for k in HEARD_KINDS)
    rows = db.execute(f"""
        SELECT DISTINCT pt.track_id FROM playlist_tracks pt JOIN playlists p ON p.id = pt.playlist_id
        WHERE p.present = 1 AND p.owned = 1 AND p.kind IN ({kinds})
        UNION SELECT track_id FROM liked""").fetchall()
    return [r[0] for r in rows]


# ----------------------------------------------------------------------------- audio

def deezer_call(url, params=None):
    for _ in range(5):
        d = get_json(url, params, DEEZER)
        err = d.get("error") if isinstance(d, dict) else None
        if err and err.get("code") == 4:  # "Quota limit exceeded": back off and retry
            time.sleep(5)
            continue
        return d
    return None


def deezer_preview(t):
    if t["isrc"]:
        d = deezer_call(f"https://api.deezer.com/track/isrc:{t['isrc']}")
        if d and not d.get("error") and d.get("preview"):
            return d["preview"], "isrc"
    d = deezer_call("https://api.deezer.com/search", {"q": f'artist:"{t["artist"]}" track:"{t["name"]}"', "limit": 10})
    want = norm(t["name"])
    for item in (d or {}).get("data", []) if isinstance(d, dict) else []:
        if not item.get("preview"):
            continue
        title = norm(item.get("title"))
        same_title = title.startswith(want[:12]) or want.startswith(title[:12])
        same_length = not t["duration_ms"] or abs(item.get("duration", 0) - t["duration_ms"] / 1000) <= 4
        if same_title and same_length:
            return item["preview"], "search"
    return None, None


def decode_preview(url):
    import soundfile as sf
    from scipy.signal import resample_poly

    for attempt in range(4):
        r = SESSION.get(url, timeout=30)
        if r.status_code != 429:  # the preview CDN occasionally pushes back on bursts
            break
        time.sleep(2 ** attempt + 1)
    r.raise_for_status()
    data = r.content
    # Deezer previews start with an (empty) ID3v2 tag that libsndfile won't sniff past; skip it.
    if data[:3] == b"ID3" and len(data) > 10:
        size = (data[6] << 21) | (data[7] << 14) | (data[8] << 7) | data[9]
        data = data[10 + size:]
    audio, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    audio = audio.mean(axis=1)
    if sr != SR:
        g = math.gcd(SR, sr)
        audio = resample_poly(audio, SR // g, sr // g).astype(np.float32)
    return audio


def fetch_audio(t):
    try:
        url, source = deezer_preview(t)
        if not url:
            return t["id"], None, "no_preview", None
        return t["id"], decode_preview(url), "ok", source
    except Exception as e:  # noqa: BLE001 - one bad song shouldn't stop the run
        return t["id"], None, "error", repr(e)[:200]


class AudioEmbedder:
    def __init__(self):
        import torch
        from transformers import ClapModel, ClapProcessor

        self.torch = torch
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model = ClapModel.from_pretrained(AUDIO_MODEL).to(self.device).eval()
        self.extractor = ClapProcessor.from_pretrained(AUDIO_MODEL).feature_extractor

    def embed(self, audios):
        torch = self.torch
        chunks, owner = [], []
        for i, a in enumerate(audios):
            pieces = [a[k * CHUNK:(k + 1) * CHUNK] for k in range(max(1, min(3, len(a) // CHUNK)))]
            for p in pieces:
                chunks.append(np.pad(p, (0, CHUNK - len(p))) if len(p) < CHUNK else p)
                owner.append(i)
        inputs = self.extractor(chunks, sampling_rate=SR, return_tensors="pt")
        with torch.no_grad():
            out = self.model.get_audio_features(**{k: v.to(self.device) for k, v in inputs.items()})
        feats = out if isinstance(out, torch.Tensor) else out.pooler_output
        feats = torch.nn.functional.normalize(feats.float(), dim=-1).cpu().numpy()
        result = np.zeros((len(audios), feats.shape[1]), np.float32)
        for row, i in zip(feats, owner):
            result[i] += row
        return result / np.linalg.norm(result, axis=1, keepdims=True)


def run_pool(items, fetch, consume, workers, stage, label, counts, host):
    """Fetches items on worker threads; consumes results on this thread (keeps SQLite/GPU here).

    `consume` tallies outcomes in `counts`; progress shows them plus how often `host` asked us to wait.
    """
    work = queue.Queue()
    for item in items:
        work.put(item)
    results = queue.Queue(maxsize=64)  # bounds memory: decoded previews are ~6 MB each

    def worker():
        while True:
            try:
                item = work.get_nowait()
            except queue.Empty:
                return
            results.put(fetch(item))

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(workers)]
    for th in threads:
        th.start()
    for done in range(1, len(items) + 1):
        consume(results.get())
        if done % 10 == 0 or done == len(items):
            tally = ", ".join(f"{n} {status}" for status, n in sorted(counts.items()))
            waits = SERVER_WAITS[host]
            emit(stage, f"{label} ({done}/{len(items)}): {tally}" + (f", asked to wait {waits}×" if waits else ""),
                 done, len(items), counts=dict(counts), waits=waits)
    consume(None)  # flush


def fill_audio(db, ids):
    have = {r[0]: r[1] for r in db.execute("SELECT track_id, status FROM ml_audio")}
    pending = [tid for tid in ids if have.get(tid) in (None, "error")]
    pending += stale_misses(db, "ml_audio", "no_preview", ids)
    if not pending:
        return
    tracks = list(load_tracks(db, pending).values())
    emit("audio", f"Loading audio model for {len(tracks)} songs…", 0, len(tracks))
    embedder = AudioEmbedder()
    batch = []
    counts = defaultdict(int)

    def flush():
        if not batch:
            return
        vecs = embedder.embed([a for _, a, _ in batch])
        db.executemany(
            "INSERT OR REPLACE INTO ml_audio (track_id, status, source, embedding, updated_at) VALUES (?, 'ok', ?, ?, ?)",
            [(tid, src, v.astype(np.float32).tobytes(), now()) for (tid, _, src), v in zip(batch, vecs)])
        db.commit()
        batch.clear()

    def consume(result):
        if result is None:
            flush()
            return
        tid, audio, status, source = result
        counts[status] += 1
        if audio is None:
            db.execute(
                "INSERT OR REPLACE INTO ml_audio (track_id, status, source, embedding, updated_at) VALUES (?, ?, ?, NULL, ?)",
                (tid, status, source, now()))
        else:
            batch.append((tid, audio, source))
            if len(batch) >= 16:
                flush()

    run_pool(tracks, fetch_audio, consume, workers=8, stage="audio", label="Analysing audio",
             counts=counts, host="api.deezer.com")
    db.commit()


# ----------------------------------------------------------------------------- lyrics

TIMESTAMP = re.compile(r"^\[[^\]]*\]\s*")


def fetch_lyrics(t):
    try:
        params = {"artist_name": t["artist"] or "", "track_name": t["name"], "album_name": t["album"] or ""}
        if t["duration_ms"]:
            params["duration"] = round(t["duration_ms"] / 1000)
        # /api/get only matches within ±2 s of the duration; search catches near-misses.
        d = get_json("https://lrclib.net/api/get", params, LRCLIB)
        if d is None:
            hits = get_json("https://lrclib.net/api/search",
                            {"track_name": t["name"], "artist_name": t["artist"] or ""}, LRCLIB) or []
            secs = (t["duration_ms"] or 0) / 1000
            d = next((h for h in hits if not secs or abs((h.get("duration") or 0) - secs) <= 3), None)
        if not d:
            return t["id"], "missing", None
        if d.get("instrumental"):
            return t["id"], "instrumental", None
        text = d.get("plainLyrics") or "\n".join(
            TIMESTAMP.sub("", line) for line in (d.get("syncedLyrics") or "").splitlines())
        return (t["id"], "ok", text) if text.strip() else (t["id"], "missing", None)
    except Exception:  # noqa: BLE001
        return t["id"], "error", None


class TextEmbedder:
    def __init__(self):
        import torch
        from sentence_transformers import SentenceTransformer

        self.model = SentenceTransformer(TEXT_MODEL, device="cuda" if torch.cuda.is_available() else "cpu")

    def embed(self, texts):
        # The model reads ~128 tokens at a time, so embed verses separately and average them.
        pieces, owner = [], []
        for i, text in enumerate(texts):
            lines = [l.strip() for l in text.splitlines() if l.strip()]
            for k in range(0, min(len(lines), 96), 8):
                pieces.append(" / ".join(lines[k:k + 8]))
                owner.append(i)
        vecs = self.model.encode(pieces, batch_size=64, normalize_embeddings=True, show_progress_bar=False)
        result = np.zeros((len(texts), vecs.shape[1]), np.float32)
        for row, i in zip(vecs, owner):
            result[i] += row
        n = np.linalg.norm(result, axis=1, keepdims=True)
        return result / np.where(n == 0, 1, n)


def fill_lyrics(db, ids):
    have = {r[0]: r[1] for r in db.execute("SELECT track_id, status FROM ml_lyrics")}
    pending = [tid for tid in ids if have.get(tid) in (None, "error")]
    pending += stale_misses(db, "ml_lyrics", "missing", ids)
    if not pending:
        return
    tracks = list(load_tracks(db, pending).values())
    emit("lyrics", f"Loading lyrics model for {len(tracks)} songs…", 0, len(tracks))
    embedder = TextEmbedder()
    batch = []
    counts = defaultdict(int)

    def flush():
        if not batch:
            return
        vecs = embedder.embed([text for _, text in batch])
        db.executemany(
            "INSERT OR REPLACE INTO ml_lyrics (track_id, status, embedding, updated_at) VALUES (?, 'ok', ?, ?)",
            [(tid, v.astype(np.float32).tobytes(), now()) for (tid, _), v in zip(batch, vecs)])
        db.commit()
        batch.clear()

    def consume(result):
        if result is None:
            flush()
            return
        tid, status, text = result
        counts[status] += 1
        if status == "ok":
            batch.append((tid, text))
            if len(batch) >= 16:  # small batches: results are saved as they come in
                flush()
        else:
            db.execute(
                "INSERT OR REPLACE INTO ml_lyrics (track_id, status, embedding, updated_at) VALUES (?, ?, NULL, ?)",
                (tid, status, now()))
            db.commit()

    # One worker: LRCLIB asks clients to send requests sequentially.
    run_pool(tracks, fetch_lyrics, consume, workers=1, stage="lyrics", label="Fetching lyrics",
             counts=counts, host="lrclib.net")
    db.commit()


# ----------------------------------------------------------------------------- dataset

class Library:
    def __init__(self, db):
        self.playlists = {r[0]: dict(zip(("id", "name", "kind"), r)) for r in db.execute(
            "SELECT id, name, kind FROM playlists WHERE present = 1 AND owned = 1")}
        self.members = defaultdict(set)
        for pid, tid in db.execute("SELECT playlist_id, track_id FROM playlist_tracks"):
            if pid in self.playlists:
                self.members[pid].add(tid)
        self.audio = {tid: np.frombuffer(b, np.float32) for tid, b in db.execute(
            "SELECT track_id, embedding FROM ml_audio WHERE status = 'ok'")}
        self.lyrics = {tid: np.frombuffer(b, np.float32) for tid, b in db.execute(
            "SELECT track_id, embedding FROM ml_lyrics WHERE status = 'ok'")}
        self.artists = defaultdict(list)
        for tid, aid, pos in db.execute(
                "SELECT track_id, artist_id, position FROM track_artists WHERE artist_id IS NOT NULL"):
            self.artists[tid].append((aid, pos))
        self.isrc = dict(db.execute("SELECT id, isrc FROM tracks"))

        self.targets = [pid for pid, p in self.playlists.items()
                        if p["kind"] in KEEPER_KINDS
                        and len([t for t in self.members[pid] if t in self.audio]) >= MIN_MEMBERS]
        kept = set()
        for pid, p in self.playlists.items():
            if p["kind"] in KEPT_KINDS:
                kept |= self.members[pid]
        # Reference songs: kept songs we have audio for.
        self.universe = sorted(t for t in kept if t in self.audio)

    def vectors(self, ids):
        """Audio embedding with the lyrics embedding (when known) mixed in, unit length.

        Each part is centred on the library average first: raw CLAP vectors all share a big
        common component (average cosine between two songs ~0.96), which makes a few "hub"
        songs look similar to everything. Mirrors VectorIndex::build in src-tauri/src/explore.rs.
        """
        if not hasattr(self, "_means"):
            self._means = (np.mean(list(self.audio.values()), axis=0),
                           np.mean(list(self.lyrics.values()), axis=0) if self.lyrics else np.zeros(TEXT_DIM))
        audio_mean, lyrics_mean = self._means
        X = np.zeros((len(ids), AUDIO_DIM + TEXT_DIM), np.float32)
        for i, t in enumerate(ids):
            a = self.audio[t] - audio_mean
            X[i, :AUDIO_DIM] = a / (np.linalg.norm(a) + 1e-9)
            if t in self.lyrics:
                l = self.lyrics[t] - lyrics_mean
                X[i, AUDIO_DIM:] = LYRICS_WEIGHT * l / (np.linalg.norm(l) + 1e-9)
        return X / np.linalg.norm(X, axis=1, keepdims=True)

    def labels(self, ids):
        Y = np.zeros((len(ids), len(self.targets)), np.float32)
        index = {t: i for i, t in enumerate(ids)}
        for j, pid in enumerate(self.targets):
            for t in self.members[pid]:
                if t in index:
                    Y[index[t], j] = 1
        return Y

    def artist_history(self, train_ids, test_ids):
        """Mirror of the app's artist-history suggestion, using training songs only."""
        train = set(train_ids)
        known = defaultdict(int)
        count = defaultdict(lambda: defaultdict(int))
        target_index = {pid: j for j, pid in enumerate(self.targets)}
        for t in train:
            for aid, _ in self.artists[t]:
                known[aid] += 1
        for pid in self.targets:
            for t in self.members[pid] & train:
                for aid, _ in self.artists[t]:
                    count[aid][pid] += 1
        S = np.zeros((len(test_ids), len(self.targets)), np.float32)
        for i, t in enumerate(test_ids):
            for aid, pos in self.artists[t]:
                if not known[aid]:
                    continue
                w = 1.0 if pos == 0 else 0.6
                for pid, c in count[aid].items():
                    S[i, target_index[pid]] += w * c / (known[aid] + 1)
        return S


# ----------------------------------------------------------------------------- sound-alikes

def neighbour_scores(ref_vectors, ref_labels, query_vectors, exclude=None, k=NEIGHBOURS):
    """For each query song: weighted share of its k most similar reference songs in each playlist.

    Similarity is cosine; weights are similarity cubed so the closest matches count most.
    `exclude[i]` is a reference row to skip (the query song itself, when it's in the library).
    """
    import torch

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    ref = torch.tensor(ref_vectors, device=dev)
    lab = torch.tensor(ref_labels, device=dev)
    out = np.zeros((len(query_vectors), ref_labels.shape[1]), np.float32)
    for start in range(0, len(query_vectors), 512):
        q = torch.tensor(query_vectors[start:start + 512], device=dev)
        sim = q @ ref.T
        if exclude is not None:
            for row, col in enumerate(exclude[start:start + 512]):
                if col is not None:
                    sim[row, col] = -1
        top, idx = sim.topk(min(k, ref.shape[0]), dim=1)
        w = top.clamp(min=0) ** 3
        scores = (w.unsqueeze(2) * lab[idx]).sum(1) / (w.sum(1, keepdim=True) + 1e-9)
        out[start:start + len(q)] = scores.cpu().numpy()
    return out


def blend(neighbours, history, weight=HISTORY_WEIGHT):
    """Same blend the app uses: each source scaled to its best playlist, history weighted up."""
    def scaled(s):
        return s / (s.max(axis=1, keepdims=True) + 1e-9)
    return scaled(neighbours) + weight * scaled(history)


# ----------------------------------------------------------------------------- evaluation

def evaluate(db, folds=5):
    """Cross-validated vibe hit@3 (a correct vibe playlist in the top 3), split by whether the
    song's artist already appears in the training songs."""
    lib = Library(db)
    labeled = [t for t in lib.universe if any(t in lib.members[p] for p in lib.targets)]
    groups = defaultdict(list)  # keep single/album versions of a recording in the same fold
    for t in labeled:
        groups[lib.isrc.get(t) or t].append(t)
    keys = sorted(groups)
    np.random.default_rng(0).shuffle(keys)

    vibe_cols = np.array([lib.playlists[p]["kind"] == "vibe" for p in lib.targets])
    hits = defaultdict(list)
    for f in range(folds):
        emit("eval", f"Fold {f + 1}/{folds}", f, folds)
        test = [t for k in keys[f::folds] for t in groups[k]]
        test_set = set(test)
        train = [t for t in lib.universe if t not in test_set]
        Y_train, Y = lib.labels(train), lib.labels(test)
        history = lib.artist_history(train, test)
        neighbours = neighbour_scores(lib.vectors(train), Y_train, lib.vectors(test))
        popular = np.repeat(Y_train.mean(0, keepdims=True), len(test), axis=0)
        methods = {
            "artist history": history,
            "biggest playlists + history": blend(popular, history),
            "sound-alikes": neighbours,
            "sound-alikes + history": blend(neighbours, history),
        }
        for name, scores in methods.items():
            for i in range(len(test)):
                truth = (Y[i] > 0) & vibe_cols
                if not truth.any():
                    continue
                ranked = np.argsort(-np.where(vibe_cols, scores[i], -np.inf))
                hit = bool(scores[i][vibe_cols].max() > 0 and truth[ranked[:3]].any())
                group = "known artist" if history[i].max() > 0 else "new artist"
                hits[(name, group)].append(hit)
                hits[(name, "all")].append(hit)

    report = defaultdict(dict)
    for (name, group), values in hits.items():
        report[name][group] = round(float(np.mean(values)) * 100, 1)
    report = dict(report)
    report["_counts"] = {
        "songs_with_audio": len(lib.audio), "reference_songs": len(lib.universe),
        "labeled_songs": len(labeled), "playlists_modeled": len(lib.targets),
        "with_lyrics": len(lib.lyrics),
        "new_artist_tests": len(hits[("artist history", "new artist")]),
        "known_artist_tests": len(hits[("artist history", "known artist")]),
    }
    set_meta(db, "eval", report)
    set_meta(db, "eval_at", now())
    return report


# ----------------------------------------------------------------------------- scoring

def score_liked(db):
    lib = Library(db)
    if len(lib.universe) < 50 or not lib.targets:
        emit("score", "Not enough analysed songs yet")
        return
    liked = [tid for (tid,) in db.execute("SELECT track_id FROM liked") if tid in lib.audio]
    db.execute("DELETE FROM ml_scores")
    if liked:
        emit("score", f"Comparing {len(liked)} liked songs with {len(lib.universe)} of yours…")
        position = {t: i for i, t in enumerate(lib.universe)}
        scores = neighbour_scores(lib.vectors(lib.universe), lib.labels(lib.universe), lib.vectors(liked),
                                  exclude=[position.get(t) for t in liked])
        db.executemany(
            "INSERT INTO ml_scores (track_id, target, score) VALUES (?, ?, ?)",
            [(tid, pid, float(scores[i, j]))
             for i, tid in enumerate(liked) for j, pid in enumerate(lib.targets) if scores[i, j] > 0])
    db.commit()
    set_meta(db, "trained_at", now())
    set_meta(db, "reference_songs", len(lib.universe))
    emit("score", f"Scored {len(liked)} liked song{'s' if len(liked) != 1 else ''}", len(liked), len(liked))


# ----------------------------------------------------------------------------- main

def acquire_lock(db_path):
    """One analysis at a time (the app runs one after every sync); returns None if taken."""
    handle = open(db_path + ".ml-lock", "a+")
    try:
        if os.name == "nt":
            import msvcrt
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        return None
    return handle


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["update", "eval"])
    parser.add_argument("--db", default=default_db())
    parser.add_argument("--skip-lyrics", action="store_true")
    args = parser.parse_args()

    lock = acquire_lock(args.db)
    if lock is None:
        emit("done", "Another audio analysis is already running")
        return

    db = connect(args.db)
    ids = tracks_needing_features(db)
    fill_audio(db, ids)
    if not args.skip_lyrics:
        fill_lyrics(db, ids)
    if args.command == "eval":
        report = evaluate(db)
        emit("done", "Evaluation finished", report=report)
    else:
        score_liked(db)
        emit("done", "Suggestions updated")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        emit("error", f"{type(e).__name__}: {e}")
        sys.exit(1)
