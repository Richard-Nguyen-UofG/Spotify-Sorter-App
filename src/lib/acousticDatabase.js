import { normalizeKey, toCamelotKey } from './musicMath.js';

const DB_NAME = 'SpotifySorterDB';
const DB_VERSION = 2;
const STORE_NAME = 'tracks';
const PLAYLIST_STORE_NAME = 'playlist_cache';
const LEGACY_STORAGE_KEY = 'spotify_sorter_acoustic_library_v2';

// Fast In-Memory Map loaded from IndexedDB
let inMemoryStore = new Map();
const isrcIndex = new Map();
const lookupKeyIndex = new Map();
const spotifyIdIndex = new Map();

const listeners = new Set();
let dbPromise = null;
let isInitialized = false;

function notifyListeners() {
  setTimeout(() => {
    listeners.forEach(cb => {
      try {
        cb();
      } catch (e) {
        console.error("Error in acoustic database listener", e);
      }
    });
  }, 0);
}

/**
 * Normalizes artist and title for deduplication and secondary indexing.
 */
export function getTrackLookupKey(artist, title) {
  if (!artist && !title) return null;
  const a = (artist || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();
  const t = (title || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();
  return `${a}_${t}`;
}

/**
 * Indexes track in secondary in-memory maps.
 */
function indexTrackInMemory(track) {
  const primaryId = track.id || track.spotify_id || track.isrc || track.lookup_key;
  if (!primaryId) return;

  if (track.isrc) isrcIndex.set(track.isrc, primaryId);
  if (track.lookup_key) lookupKeyIndex.set(track.lookup_key, primaryId);
  if (track.spotify_id) spotifyIdIndex.set(track.spotify_id, primaryId);
  if (track.id && track.id.length === 22) spotifyIdIndex.set(track.id, primaryId);
}

/**
 * Opens native IndexedDB database.
 */
function openIndexedDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      console.warn("IndexedDB not available, falling back to in-memory store.");
      resolve(null);
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('lookup_key', 'lookup_key', { unique: false });
        store.createIndex('spotify_id', 'spotify_id', { unique: false });
        store.createIndex('isrc', 'isrc', { unique: false });
        store.createIndex('bpm', 'bpm', { unique: false });
        store.createIndex('camelot', 'camelot', { unique: false });
        store.createIndex('updated_at', 'updated_at', { unique: false });
      }
      if (!db.objectStoreNames.contains(PLAYLIST_STORE_NAME)) {
        db.createObjectStore(PLAYLIST_STORE_NAME, { keyPath: 'playlist_id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      console.error("IndexedDB open error:", request.error);
      resolve(null);
    };
  });

  return dbPromise;
}

/**
 * Gets cached playlist track list from IndexedDB.
 * If expectedSnapshotId is provided, returns null if Spotify has an updated version.
 */
export async function getCachedPlaylistTracks(playlistId, expectedSnapshotId = null) {
  if (!playlistId) return null;
  const db = await openIndexedDB();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(PLAYLIST_STORE_NAME, 'readonly');
      const store = tx.objectStore(PLAYLIST_STORE_NAME);
      const req = store.get(playlistId);
      req.onsuccess = () => {
        const record = req.result;
        if (!record || !record.tracks) {
          resolve(null);
          return;
        }
        // If snapshot_id is specified and does not match, cache is outdated
        if (expectedSnapshotId && record.snapshot_id && record.snapshot_id !== expectedSnapshotId) {
          resolve(null);
          return;
        }
        resolve(record.tracks);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Saves playlist track list to IndexedDB (virtually unlimited size, handles 10,000+ tracks).
 */
export async function saveCachedPlaylistTracks(playlistId, tracks, playlistName = '', snapshotId = null) {
  if (!playlistId || !tracks) return;
  const db = await openIndexedDB();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(PLAYLIST_STORE_NAME, 'readwrite');
      const store = tx.objectStore(PLAYLIST_STORE_NAME);
      store.put({
        playlist_id: playlistId,
        name: playlistName,
        snapshot_id: snapshotId,
        track_count: tracks.length,
        tracks: tracks,
        cached_at: Date.now()
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * Invalidates cached playlist track list from IndexedDB.
 */
export async function invalidatePlaylistTracksCache(playlistId) {
  if (!playlistId) return;
  const db = await openIndexedDB();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(PLAYLIST_STORE_NAME, 'readwrite');
      const store = tx.objectStore(PLAYLIST_STORE_NAME);
      store.delete(playlistId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * Initializes database, migrates legacy localStorage items into IndexedDB, and warms in-memory cache.
 */
export async function initDatabase() {
  if (isInitialized) return inMemoryStore;

  const db = await openIndexedDB();

  // 1. Read all records from IndexedDB into memory
  if (db) {
    await new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.getAll();

        req.onsuccess = () => {
          const records = req.result || [];
          records.forEach(track => {
            if (track && track.id) {
              inMemoryStore.set(track.id, track);
              indexTrackInMemory(track);
            }
          });
          resolve();
        };
        req.onerror = () => {
          console.warn("Error reading IndexedDB records:", req.error);
          resolve();
        };
      } catch (err) {
        console.warn("Transaction error in initDatabase:", err);
        resolve();
      }
    });
  }

  // 2. One-time Migration from localStorage / legacy keys
  try {
    const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
    const legacyTracks = [];

    if (legacyRaw) {
      try {
        const parsed = JSON.parse(legacyRaw);
        if (Array.isArray(parsed)) {
          parsed.forEach(t => {
            if (t && (t.id || t.spotify_id || (t.artist && t.name))) {
              const primaryKey = t.id || t.spotify_id || t.isrc || getTrackLookupKey(t.artist, t.name);
              if (primaryKey && !inMemoryStore.has(primaryKey)) {
                legacyTracks.push({
                  ...t,
                  id: primaryKey,
                  source: t.source === 'freqblog' || t.source === 'getsongbpm' ? 'musicae' : (t.source || 'migrated')
                });
              }
            }
          });
        }
      } catch {}
      // Clear legacy storage after loading to free localStorage quota
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    }

    // Also migrate any legacy gsb_v*, freqblog_v* items
    const keysToPurge = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('gsb_v') || k.startsWith('freqblog_v') || k.startsWith('spotify_playlist_v'))) {
        keysToPurge.push(k);
      }
    }
    keysToPurge.forEach(k => {
      try { localStorage.removeItem(k); } catch {}
    });

    if (legacyTracks.length > 0) {
      await saveTracksBatch(legacyTracks);
    }
  } catch (err) {
    console.warn("Error during legacy localStorage migration:", err);
  }

  isInitialized = true;
  notifyListeners();
  return inMemoryStore;
}

// Auto-initialize in background on module load
if (typeof window !== 'undefined') {
  initDatabase().catch(console.error);
}

/**
 * Subscribes to changes in the database.
 */
export function onDatabaseChange(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/**
 * Retrieves all stored tracks as a clean array.
 */
export function getAllTracks() {
  return Array.from(inMemoryStore.values());
}

/**
 * Fast synchronous lookup by Spotify ID, ISRC, or Artist+Title.
 */
export function getTrack(identifier, { artist = '', title = '', isrc = '' } = {}) {
  if (!identifier && !artist && !title && !isrc) return null;

  // 1. Direct primary key lookup
  if (identifier && inMemoryStore.has(identifier)) {
    return inMemoryStore.get(identifier);
  }

  // 2. Spotify ID index lookup
  if (identifier && spotifyIdIndex.has(identifier)) {
    const primaryId = spotifyIdIndex.get(identifier);
    if (inMemoryStore.has(primaryId)) return inMemoryStore.get(primaryId);
  }

  // 3. ISRC index lookup
  const queryIsrc = isrc || (identifier && identifier.length === 12 ? identifier : null);
  if (queryIsrc && isrcIndex.has(queryIsrc)) {
    const primaryId = isrcIndex.get(queryIsrc);
    if (inMemoryStore.has(primaryId)) return inMemoryStore.get(primaryId);
  }

  // 4. Artist + Title key lookup
  const lookupKey = getTrackLookupKey(artist, title);
  if (lookupKey && lookupKeyIndex.has(lookupKey)) {
    const primaryId = lookupKeyIndex.get(lookupKey);
    if (inMemoryStore.has(primaryId)) return inMemoryStore.get(primaryId);
  }

  return null;
}

/**
 * Normalizes and saves a track to in-memory store and IndexedDB.
 */
export async function saveTrack(trackData) {
  if (!trackData) return null;

  const id = trackData.id || trackData.spotify_id || trackData.isrc || null;
  const isrc = trackData.isrc || null;
  const name = trackData.name || trackData.title || '';
  const artist = trackData.artist || (trackData.artists && trackData.artists[0]?.name) || '';
  const lookupKey = getTrackLookupKey(artist, name);

  const rawKey = trackData.key;
  const camelot = trackData.camelot || toCamelotKey(rawKey, trackData.mode);
  const stdKey = normalizeKey(rawKey, trackData.mode);

  const primaryKey = id || isrc || lookupKey;
  if (!primaryKey) return null;

  const existing = getTrack(primaryKey, { artist, title: name, isrc });

  const entry = {
    id: primaryKey,
    spotify_id: trackData.spotify_id || trackData.id || existing?.spotify_id || (primaryKey.length === 22 ? primaryKey : null),
    isrc: isrc || existing?.isrc || null,
    uri: trackData.uri || existing?.uri || (id ? `spotify:track:${id}` : null),
    name: name || existing?.name || '',
    artist: artist || existing?.artist || '',
    album: trackData.album || existing?.album || null,
    year: trackData.year || existing?.year || null,
    duration_ms: trackData.duration_ms || existing?.duration_ms || null,
    bpm: trackData.bpm !== null && trackData.bpm !== undefined && !isNaN(trackData.bpm) ? parseFloat(trackData.bpm) : existing?.bpm || null,
    key: stdKey || (rawKey ? String(rawKey) : existing?.key || null),
    camelot: camelot || existing?.camelot || null,
    danceability: trackData.danceability !== null && trackData.danceability !== undefined && !isNaN(trackData.danceability) ? parseFloat(trackData.danceability) : existing?.danceability || null,
    energy: trackData.energy !== null && trackData.energy !== undefined && !isNaN(trackData.energy) ? parseFloat(trackData.energy) : existing?.energy || null,
    acousticness: trackData.acousticness !== null && trackData.acousticness !== undefined && !isNaN(trackData.acousticness) ? parseFloat(trackData.acousticness) : existing?.acousticness || null,
    valence: trackData.valence !== null && trackData.valence !== undefined && !isNaN(trackData.valence) ? parseFloat(trackData.valence) : existing?.valence || null,
    source: trackData.source || existing?.source || 'musicae',
    status: trackData.status || (trackData.bpm ? 'resolved' : existing?.status || 'missing'),
    lookup_key: lookupKey || existing?.lookup_key || null,
    updated_at: new Date().toISOString()
  };

  inMemoryStore.set(primaryKey, entry);
  indexTrackInMemory(entry);

  // Persist to IndexedDB
  const db = await openIndexedDB();
  if (db) {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(entry);
    } catch (e) {
      console.warn("Failed to put track in IndexedDB:", e);
    }
  }

  notifyListeners();
  return entry;
}

/**
 * Saves multiple tracks in batch to IndexedDB.
 */
export async function saveTracksBatch(tracksList) {
  if (!Array.isArray(tracksList) || tracksList.length === 0) return;

  const entriesToSave = [];

  tracksList.forEach(t => {
    if (!t) return;
    const name = t.name || t.title || '';
    const artist = t.artist || (t.artists && t.artists[0]?.name) || '';
    const lookupKey = getTrackLookupKey(artist, name);
    const camelot = t.camelot || toCamelotKey(t.key, t.mode);
    const stdKey = normalizeKey(t.key, t.mode);

    const primaryKey = t.id || t.spotify_id || t.isrc || lookupKey;
    if (!primaryKey) return;

    const existing = getTrack(primaryKey, { artist, title: name, isrc: t.isrc });

    const entry = {
      id: primaryKey,
      spotify_id: t.spotify_id || t.id || existing?.spotify_id || (primaryKey.length === 22 ? primaryKey : null),
      isrc: t.isrc || existing?.isrc || null,
      uri: t.uri || existing?.uri || (t.id ? `spotify:track:${t.id}` : null),
      name: name || existing?.name || '',
      artist: artist || existing?.artist || '',
      album: t.album || existing?.album || null,
      year: t.year || existing?.year || null,
      duration_ms: t.duration_ms || existing?.duration_ms || null,
      bpm: t.bpm !== null && t.bpm !== undefined && !isNaN(t.bpm) ? parseFloat(t.bpm) : existing?.bpm || null,
      key: stdKey || (t.key ? String(t.key) : existing?.key || null),
      camelot: camelot || existing?.camelot || null,
      danceability: t.danceability !== null && t.danceability !== undefined && !isNaN(t.danceability) ? parseFloat(t.danceability) : existing?.danceability || null,
      energy: t.energy !== null && t.energy !== undefined && !isNaN(t.energy) ? parseFloat(t.energy) : existing?.energy || null,
      acousticness: t.acousticness !== null && t.acousticness !== undefined && !isNaN(t.acousticness) ? parseFloat(t.acousticness) : existing?.acousticness || null,
      valence: t.valence !== null && t.valence !== undefined && !isNaN(t.valence) ? parseFloat(t.valence) : existing?.valence || null,
      source: t.source || existing?.source || 'musicae',
      status: t.status || (t.bpm ? 'resolved' : existing?.status || 'missing'),
      lookup_key: lookupKey || existing?.lookup_key || null,
      updated_at: new Date().toISOString()
    };

    inMemoryStore.set(primaryKey, entry);
    indexTrackInMemory(entry);
    entriesToSave.push(entry);
  });

  const db = await openIndexedDB();
  if (db && entriesToSave.length > 0) {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      entriesToSave.forEach(entry => store.put(entry));
    } catch (e) {
      console.warn("Failed to put batch in IndexedDB:", e);
    }
  }

  notifyListeners();
}

/**
 * Updates specific fields on an existing track row (for manual edits).
 */
export async function updateTrackRow(identifier, updates) {
  const existing = getTrack(identifier);
  if (!existing) {
    return saveTrack({ id: identifier, ...updates });
  }

  const updated = {
    ...existing,
    ...updates,
    updated_at: new Date().toISOString()
  };

  if (updates.key !== undefined) {
    updated.camelot = toCamelotKey(updates.key);
    updated.key = normalizeKey(updates.key);
  }
  if (updates.bpm !== undefined) {
    updated.bpm = updates.bpm !== null && updates.bpm !== '' && !isNaN(updates.bpm) ? parseFloat(updates.bpm) : null;
    updated.status = updated.bpm ? 'resolved' : 'missing';
  }

  return saveTrack(updated);
}

/**
 * Deletes a track from the library.
 */
export async function deleteTrack(identifier) {
  const track = getTrack(identifier);
  if (!track) return false;

  const primaryId = track.id || track.isrc || track.lookup_key;
  if (primaryId) inMemoryStore.delete(primaryId);
  if (track.isrc) isrcIndex.delete(track.isrc);
  if (track.lookup_key) lookupKeyIndex.delete(track.lookup_key);
  if (track.spotify_id) spotifyIdIndex.delete(track.spotify_id);

  const db = await openIndexedDB();
  if (db && primaryId) {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(primaryId);
    } catch (e) {
      console.warn("Failed to delete track from IndexedDB:", e);
    }
  }

  notifyListeners();
  return true;
}

/**
 * Clears the entire database.
 */
export async function clearDatabase() {
  inMemoryStore.clear();
  isrcIndex.clear();
  lookupKeyIndex.clear();
  spotifyIdIndex.clear();

  const db = await openIndexedDB();
  if (db) {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
    } catch (e) {
      console.warn("Failed to clear IndexedDB:", e);
    }
  }

  notifyListeners();
}

// ----------------------------------------------------
// JSON Backup Export & Import Engine
// ----------------------------------------------------

/**
 * Exports all tracks in the database to a formatted JSON string.
 */
export function exportToJson() {
  const uniqueTracks = getAllTracks();
  uniqueTracks.sort((a, b) => {
    const artistComp = (a.artist || '').localeCompare(b.artist || '');
    if (artistComp !== 0) return artistComp;
    return (a.name || '').localeCompare(b.name || '');
  });

  return JSON.stringify({
    version: "1.0",
    engine: "musicae_indexeddb",
    exported_at: new Date().toISOString(),
    track_count: uniqueTracks.length,
    tracks: uniqueTracks
  }, null, 2);
}

/**
 * Triggers a browser download of the acoustic library as a JSON backup file.
 */
export function downloadJsonFile(filename = 'spotify_sorter_acoustic_library.json') {
  const jsonStr = exportToJson();
  const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Imports tracks from a JSON string or parsed JSON object into IndexedDB.
 */
export async function importFromJson(jsonContent) {
  if (!jsonContent) throw new Error("JSON content is empty.");

  let parsed = null;
  if (typeof jsonContent === 'string') {
    try {
      parsed = JSON.parse(jsonContent);
    } catch (e) {
      throw new Error(`Invalid JSON syntax: ${e.message}`);
    }
  } else if (typeof jsonContent === 'object') {
    parsed = jsonContent;
  }

  const rawTracks = Array.isArray(parsed) ? parsed : (parsed.tracks || []);
  if (!Array.isArray(rawTracks) || rawTracks.length === 0) {
    return { total: 0, added: 0, updated: 0, errors: [] };
  }

  let added = 0;
  let updated = 0;
  const errors = [];
  const validTracks = [];

  rawTracks.forEach((t, i) => {
    try {
      if (!t || (!t.id && !t.spotify_id && !t.name)) return;
      const key = t.id || t.spotify_id || t.isrc || getTrackLookupKey(t.artist, t.name);
      if (inMemoryStore.has(key)) {
        updated++;
      } else {
        added++;
      }
      validTracks.push({
        ...t,
        source: t.source || 'imported_backup'
      });
    } catch (err) {
      errors.push(`Row ${i + 1}: ${err.message}`);
    }
  });

  if (validTracks.length > 0) {
    await saveTracksBatch(validTracks);
  }

  return {
    total: rawTracks.length,
    added,
    updated,
    errors
  };
}
