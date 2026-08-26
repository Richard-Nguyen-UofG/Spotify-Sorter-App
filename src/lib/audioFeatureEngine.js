import { getTrack, saveTracksBatch, getTrackLookupKey } from './acousticDatabase.js';
import { normalizeKey, toCamelotKey } from './musicMath.js';

export class RateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "RateLimitError";
  }
}

export class InvalidApiKeyError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidApiKeyError";
  }
}

const PITCH_CLASSES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

/**
 * Converts Spotify pitch class (0-11) and mode (0=minor, 1=major) to standard key string.
 */
export function pitchClassToKey(pitch, mode) {
  if (pitch === null || pitch === undefined || pitch < 0 || pitch > 11) return null;
  const note = PITCH_CLASSES[pitch];
  if (mode === 0) return `${note}m`;
  return note;
}

/**
 * Fetches a single batch of up to 5 tracks from Musicae via RapidAPI.
 * Includes automatic 429 exponential backoff retry.
 */
export async function fetchMusicaeBatch(spotifyIds, rapidApiKey, retries = 3) {
  if (!spotifyIds || spotifyIds.length === 0) return [];
  if (!rapidApiKey) throw new InvalidApiKeyError("RapidAPI Key for Musicae is missing in .env.local.");

  const validIds = spotifyIds.filter(id => id && id.length === 22);
  if (validIds.length === 0) return [];

  const url = `/api/musicae/v1/audio-features?ids=${validIds.join(',')}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-rapidapi-key': rapidApiKey,
        'x-rapidapi-host': 'spotify-extended-audio-features-api.p.rapidapi.com'
      }
    });

    if (response.status === 401 || response.status === 403) {
      throw new InvalidApiKeyError("RapidAPI Key is invalid or unauthorized for Musicae API.");
    }

    if (response.status === 429) {
      if (retries > 0) {
        const delay = (4 - retries) * 600;
        console.warn(`Musicae rate limit encountered (429). Retrying in ${delay}ms... (${retries} attempts left)`);
        await new Promise(r => setTimeout(r, delay));
        return fetchMusicaeBatch(validIds, rapidApiKey, retries - 1);
      }
      throw new RateLimitError("Musicae API rate limit or monthly quota reached.");
    }

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`Musicae API Warning: ${response.status} ${response.statusText} - ${errText}`);
      return [];
    }

    const data = await response.json();
    const rawFeatures = data.audio_features || (Array.isArray(data) ? data : []);

    return rawFeatures.map((f, idx) => {
      const id = validIds[idx];
      if (!f) return null;

      const tempo = f.tempo ? parseFloat(f.tempo) : null;
      const rawKey = f.key;
      const mode = f.mode;
      const stdKey = pitchClassToKey(rawKey, mode) || normalizeKey(rawKey, mode);
      const camelot = toCamelotKey(rawKey, mode);

      return {
        id: f.id || id,
        spotify_id: f.id || id,
        bpm: tempo,
        key: stdKey,
        camelot: camelot,
        danceability: f.danceability !== undefined && f.danceability !== null ? parseFloat(f.danceability) : null,
        energy: f.energy !== undefined && f.energy !== null ? parseFloat(f.energy) : null,
        valence: f.valence !== undefined && f.valence !== null ? parseFloat(f.valence) : null,
        acousticness: f.acousticness !== undefined && f.acousticness !== null ? parseFloat(f.acousticness) : null,
        loudness: f.loudness !== undefined && f.loudness !== null ? parseFloat(f.loudness) : null,
        speechiness: f.speechiness !== undefined && f.speechiness !== null ? parseFloat(f.speechiness) : null,
        instrumentalness: f.instrumentalness !== undefined && f.instrumentalness !== null ? parseFloat(f.instrumentalness) : null,
        liveness: f.liveness !== undefined && f.liveness !== null ? parseFloat(f.liveness) : null,
        source: 'musicae',
        status: tempo ? 'resolved' : 'missing'
      };
    });
  } catch (err) {
    if (err instanceof RateLimitError || err instanceof InvalidApiKeyError) {
      throw err;
    }
    console.warn("Musicae batch fetch error:", err);
    return [];
  }
}

/**
 * Multi-pass acoustic feature fetcher for an array of Spotify track objects:
 * - Pass 1: Local IndexedDB instant cache lookup (0ms, 0 API calls).
 * - Pass 2: Musicae.io API in parallel controlled batches (5 tracks per request).
 * - Automatically saves all newly resolved features to IndexedDB.
 */
export async function fetchAcousticFeaturesForTracks(tracks, onProgress = () => {}, forceQuery = false) {
  if (!tracks || tracks.length === 0) {
    return { tracksWithFeatures: [], stats: { total: 0, cached: 0, musicae: 0, missing: 0 } };
  }

  const rapidApiKey = import.meta.env.VITE_RAPIDAPI_KEY;

  let cachedCount = 0;
  let musicaeCount = 0;
  let missingCount = 0;
  let rateLimitHit = false;

  const tracksWithFeatures = [];
  const tracksToQuery = [];
  const queryIndexMap = new Map();

  // ----------------------------------------------------
  // Pass 1: Local IndexedDB Database Check
  // ----------------------------------------------------
  onProgress({ stage: 'cache', message: 'Checking Local IndexedDB Database...', percent: 10 });

  tracks.forEach((track, index) => {
    const artist = track.artists && track.artists[0] ? track.artists[0].name : (track.artist || '');
    const title = track.name || track.title || '';
    const isrc = track.external_ids?.isrc || track.isrc || null;
    const id = track.id || null;

    const stored = getTrack(id, { artist, title, isrc });

    if (stored && stored.bpm) {
      cachedCount++;
      tracksWithFeatures[index] = {
        ...track,
        bpm: stored.bpm,
        key: stored.key,
        camelot: stored.camelot,
        danceability: stored.danceability,
        energy: stored.energy,
        acousticness: stored.acousticness,
        valence: stored.valence,
        acoustic_source: stored.source || 'indexeddb',
        status: 'resolved'
      };
    } else if (!forceQuery && stored && (stored.status === 'missing' || stored.bpm === null)) {
      // Previously confirmed missing from Musicae catalog — avoid querying RapidAPI repeatedly
      cachedCount++;
      tracksWithFeatures[index] = {
        ...track,
        bpm: null,
        key: null,
        camelot: null,
        danceability: null,
        energy: null,
        valence: null,
        acousticness: null,
        acoustic_source: 'cached_missing',
        status: 'missing'
      };
    } else {
      // Needs to be queried from Musicae
      const queryItem = {
        trackIndex: index,
        id,
        isrc,
        name: title,
        title: title,
        artist,
        album: track.album?.name || null,
        year: track.album?.release_date ? new Date(track.album.release_date).getFullYear() : null,
        duration_ms: track.duration_ms || null,
        uri: track.uri || (id ? `spotify:track:${id}` : null)
      };

      const dedupKey = id || getTrackLookupKey(artist, title) || isrc;
      if (!queryIndexMap.has(dedupKey)) {
        queryIndexMap.set(dedupKey, [index]);
        tracksToQuery.push(queryItem);
      } else {
        queryIndexMap.get(dedupKey).push(index);
      }
    }
  });

  if (tracksToQuery.length === 0) {
    onProgress({ stage: 'complete', message: `All ${tracks.length} tracks loaded instantly from Local Database!`, percent: 100 });
    return {
      tracksWithFeatures,
      stats: { total: tracks.length, cached: cachedCount, musicae: 0, missing: tracksWithFeatures.filter(t => !t?.bpm).length },
      missingTracks: tracksWithFeatures.filter(t => !t?.bpm),
      rateLimitHit: false
    };
  }

  // ----------------------------------------------------
  // Pass 2: Musicae.io API (Batch size: 5 tracks per request)
  // ----------------------------------------------------
  const BATCH_SIZE = 5;
  const CONCURRENCY = 4;
  const newTracksToSave = [];

  if (rapidApiKey) {
    // Chunk tracksToQuery into batches of 5 Spotify IDs
    const batches = [];
    for (let i = 0; i < tracksToQuery.length; i += BATCH_SIZE) {
      batches.push(tracksToQuery.slice(i, i + BATCH_SIZE));
    }

    const totalBatches = batches.length;
    let completedBatches = 0;

    for (let i = 0; i < totalBatches; i += CONCURRENCY) {
      const currentConcurrentBatches = batches.slice(i, i + CONCURRENCY);

      const batchProgress = 10 + Math.round((completedBatches / totalBatches) * 85);
      onProgress({
        stage: 'musicae',
        message: `Querying Musicae API (${completedBatches * BATCH_SIZE} / ${tracksToQuery.length} tracks)...`,
        percent: batchProgress
      });

      try {
        const batchPromises = currentConcurrentBatches.map(batch => {
          const ids = batch.map(b => b.id).filter(id => id);
          return fetchMusicaeBatch(ids, rapidApiKey);
        });

        const batchResultsArray = await Promise.all(batchPromises);

        currentConcurrentBatches.forEach((batch, batchIdx) => {
          const results = batchResultsArray[batchIdx] || [];

          batch.forEach((queryItem, itemIdx) => {
            const feature = results[itemIdx];
            const dedupKey = queryItem.id || getTrackLookupKey(queryItem.artist, queryItem.name) || queryItem.isrc;
            const matchedIndices = queryIndexMap.get(dedupKey) || [queryItem.trackIndex];

            if (feature && feature.bpm) {
              musicaeCount += matchedIndices.length;

              const fullData = {
                ...queryItem,
                ...feature,
                status: 'resolved',
                source: 'musicae'
              };

              newTracksToSave.push(fullData);

              matchedIndices.forEach(targetIdx => {
                tracksWithFeatures[targetIdx] = {
                  ...tracks[targetIdx],
                  ...feature,
                  acoustic_source: 'musicae',
                  status: 'resolved'
                };
              });
            } else {
              // Unresolved from Musicae: persist as 'missing' to avoid re-querying every run
              missingCount += matchedIndices.length;

              const missingData = {
                ...queryItem,
                bpm: null,
                key: null,
                camelot: null,
                danceability: null,
                energy: null,
                valence: null,
                acousticness: null,
                status: 'missing',
                source: 'musicae'
              };

              newTracksToSave.push(missingData);

              matchedIndices.forEach(targetIdx => {
                tracksWithFeatures[targetIdx] = {
                  ...tracks[targetIdx],
                  bpm: null,
                  key: null,
                  camelot: null,
                  danceability: null,
                  energy: null,
                  valence: null,
                  acousticness: null,
                  acoustic_source: 'musicae_missing',
                  status: 'missing'
                };
              });
            }
          });
        });

        completedBatches += currentConcurrentBatches.length;

        // Small 50ms pacing between concurrent waves to stay safely within RapidAPI rate limits
        if (i + CONCURRENCY < totalBatches) {
          await new Promise(r => setTimeout(r, 50));
        }
      } catch (err) {
        if (err instanceof RateLimitError || err.name === 'RateLimitError') {
          console.warn("Musicae rate limit reached:", err.message);
          rateLimitHit = true;
          break;
        }
        if (err instanceof InvalidApiKeyError || err.name === 'InvalidApiKeyError') {
          throw err;
        }
        console.warn("Musicae batch processing warning:", err);
      }
    }

    // Persist all newly checked tracks (resolved + confirmed missing) to IndexedDB in bulk
    if (newTracksToSave.length > 0) {
      await saveTracksBatch(newTracksToSave);
    }
  } else {
    console.warn("No RapidAPI Key configured. Skipping Musicae API lookup.");
  }

  // Final pass: ensure all output array slots are populated
  const missingTracksList = [];
  tracks.forEach((track, index) => {
    if (!tracksWithFeatures[index]) {
      tracksWithFeatures[index] = {
        ...track,
        bpm: null,
        key: null,
        camelot: null,
        danceability: null,
        energy: null,
        valence: null,
        acousticness: null,
        acoustic_source: null
      };
    }

    if (!tracksWithFeatures[index].bpm) {
      missingTracksList.push(tracksWithFeatures[index]);
    }
  });

  onProgress({
    stage: 'complete',
    message: `Acoustic analysis complete (${cachedCount} cached, ${musicaeCount} Musicae, ${missingTracksList.length} missing).`,
    percent: 100
  });

  return {
    tracksWithFeatures,
    stats: {
      total: tracks.length,
      cached: cachedCount,
      musicae: musicaeCount,
      missing: missingTracksList.length
    },
    missingTracks: missingTracksList,
    rateLimitHit
  };
}
