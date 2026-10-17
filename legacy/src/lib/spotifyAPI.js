import { getToken, isTokenExpired, refreshAccessToken } from './spotify';
import { getCachedPlaylistTracks, saveCachedPlaylistTracks, invalidatePlaylistTracksCache } from './acousticDatabase';

const BASE_URL = 'https://api.spotify.com/v1';

async function fetchWebApi(endpoint, method = 'GET', body, retries = 3) {
  // Proactively refresh if token is expired or about to expire
  if (isTokenExpired()) {
    await refreshAccessToken();
  }

  let token = getToken();
  const res = await fetch(`${BASE_URL}/${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  // If 401 Unauthorized encountered, refresh token and retry immediately
  if (res.status === 401 && retries > 0) {
    const refreshedToken = await refreshAccessToken();
    if (refreshedToken) {
      return fetchWebApi(endpoint, method, body, retries - 1);
    }
  }

  if (res.status === 429) {
    const retryAfter = res.headers.get('Retry-After');
    const retrySecs = retryAfter ? parseInt(retryAfter, 10) : null;
    
    // Auto-retry short cooldowns if specified by Spotify
    if (retries > 0 && retrySecs && retrySecs <= 6) {
      const waitTime = retrySecs * 1000;
      console.warn(`Spotify rate limited (429). Auto-waiting ${retrySecs}s before retrying...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return fetchWebApi(endpoint, method, body, retries - 1);
    }

    if (retrySecs) {
      const timeFormatted = retrySecs >= 60 
        ? `${Math.ceil(retrySecs / 60)} minute${Math.ceil(retrySecs / 60) > 1 ? 's' : ''}`
        : `${retrySecs} second${retrySecs > 1 ? 's' : ''}`;
      throw new Error(`Spotify Rate Limited (429): Spotify is cooling down API requests for your account. Please wait approximately ${timeFormatted} (${retrySecs}s) before trying again.`);
    }

    throw new Error(`Spotify Rate Limited (429): Spotify temporarily paused API requests after fetching large batches of tracks. Spotify limits typically reset in 5–10 minutes. Please take a short break before retrying.`);
  }

  if (!res.ok) {
    let errorMsg = await res.text();
    throw new Error(`Spotify API error: ${res.status} on endpoint [${endpoint}]. Details: ${errorMsg}`);
  }
  
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

export async function getCurrentUserPlaylists(forceRefresh = false) {
  const cacheKey = 'spotify_cached_user_playlists';
  
  // Return cached playlist list if available
  if (!forceRefresh) {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      } catch {
        // Ignore cache parse error
      }
    }
  }

  let allPlaylists = [];
  let url = 'me/playlists?limit=50';
  
  while (url) {
    const endpoint = url.replace(BASE_URL + '/', '');
    const response = await fetchWebApi(endpoint);
    if (response.items) {
      allPlaylists = [...allPlaylists, ...response.items];
    }
    url = response.next;
  }

  try {
    localStorage.setItem(cacheKey, JSON.stringify(allPlaylists));
  } catch {
    // Ignore storage quota
  }

  return allPlaylists;
}

const memoryCache = {};

export async function getPlaylistTracks(playlistId, forceRefresh = false, onProgress = null, expectedSnapshotId = null) {
  let currentSnapshotId = expectedSnapshotId;

  // Check cache if not forcing refresh
  if (!forceRefresh) {
    if (currentSnapshotId) {
      // Snapshot ID was provided: check IndexedDB cache directly
      const idbCached = await getCachedPlaylistTracks(playlistId, currentSnapshotId);
      if (idbCached && idbCached.length > 0) {
        memoryCache[playlistId] = idbCached;
        return idbCached;
      }
    } else {
      // Auto-check: Query Spotify's lightweight snapshot_id to detect additions/removals
      try {
        const meta = await fetchWebApi(`playlists/${playlistId}?fields=snapshot_id,name,tracks.total`);
        if (meta && meta.snapshot_id) {
          currentSnapshotId = meta.snapshot_id;
          const idbCached = await getCachedPlaylistTracks(playlistId, currentSnapshotId);
          if (idbCached && idbCached.length > 0) {
            memoryCache[playlistId] = idbCached;
            return idbCached;
          }
        }
      } catch {
        // Fallback: If network/rate limit prevents checking snapshot, load from IndexedDB cache
        const fallbackCached = await getCachedPlaylistTracks(playlistId);
        if (fallbackCached && fallbackCached.length > 0) {
          memoryCache[playlistId] = fallbackCached;
          return fallbackCached;
        }
      }
    }
  }

  // If cache is missing or snapshot_id changed, download fresh tracks
  let allTracks = [];
  let url = `playlists/${playlistId}/items?limit=100`;
  let page = 0;
  
  while (url) {
    page++;
    if (onProgress) {
      onProgress(`Downloading playlist items from Spotify (page ${page}, ${allTracks.length} tracks so far)...`);
    }

    const endpoint = url.replace(BASE_URL + '/', '');
    const response = await fetchWebApi(endpoint);
    if (response.items) {
      const minified = response.items.map(t => {
        if (!t.item && !t.track) return t;
        const trackObj = t.item || t.track;
        return {
          is_local: t.is_local,
          item: {
            id: trackObj.id,
            uri: trackObj.uri,
            name: trackObj.name,
            duration_ms: trackObj.duration_ms,
            popularity: trackObj.popularity || 0,
            artists: trackObj.artists ? trackObj.artists.map(a => ({ name: a.name, id: a.id })) : [],
            album: trackObj.album ? { name: trackObj.album.name, release_date: trackObj.album.release_date } : null,
            external_ids: trackObj.external_ids ? { isrc: trackObj.external_ids.isrc } : null
          }
        };
      });
      allTracks = [...allTracks, ...minified];
    }
    url = response.next;

    // 50ms pacing delay between pages for large playlists
    if (url) {
      await new Promise(r => setTimeout(r, 50));
    }
  }

  // Retrieve current snapshot_id if not known
  if (!currentSnapshotId) {
    try {
      const meta = await fetchWebApi(`playlists/${playlistId}?fields=snapshot_id`);
      if (meta?.snapshot_id) currentSnapshotId = meta.snapshot_id;
    } catch {}
  }

  // Save fresh tracks and snapshot_id to Memory Cache & IndexedDB
  memoryCache[playlistId] = allTracks;
  await saveCachedPlaylistTracks(playlistId, allTracks, '', currentSnapshotId);

  return allTracks;
}

export async function getArtists(artistIds) {
  let allArtists = [];
  for (let i = 0; i < artistIds.length; i += 50) {
    const chunk = artistIds.slice(i, i + 50);
    const ids = chunk.join(',');
    const response = await fetchWebApi(`artists?ids=${ids}`);
    if (response.artists) {
      allArtists = [...allArtists, ...response.artists];
    }
  }
  return allArtists;
}

const artistTopTracksCache = {};

export async function getArtistTopTracks(artistId, artistName = '') {
  const cacheKey = (artistId ? `id_${artistId}` : null) || (artistName ? `name_${artistName.toLowerCase().trim()}` : null);
  if (!cacheKey) return [];
  if (artistTopTracksCache[cacheKey]) {
    return artistTopTracksCache[cacheKey];
  }

  // 1. Primary Method: Spotify Search endpoint by artist name
  // Note: /v1/artists/{id}/top-tracks returns 403 Forbidden for standard developer apps due to Spotify's late 2024 policy.
  // The Search endpoint is 100% active, unrestricted, and returns tracks ordered by Spotify popularity!
  if (artistName && artistName.trim()) {
    try {
      const cleanName = encodeURIComponent(artistName.trim());
      // Search API allows limit up to 10 for standard developer tokens (limit > 10 returns 400 Invalid limit)
      let response = await fetchWebApi(`search?q=artist:%22${cleanName}%22&type=track&limit=10`);
      
      // If empty, try general search without quotes
      if (!response?.tracks?.items || response.tracks.items.length === 0) {
        response = await fetchWebApi(`search?q=${cleanName}&type=track&limit=10`);
      }

      if (response?.tracks?.items && Array.isArray(response.tracks.items) && response.tracks.items.length > 0) {
        const normTarget = artistName.toLowerCase().replace(/[^\w\s]/g, '').trim();
        let matched = response.tracks.items.filter(t => {
          if (!t || t.is_local) return false;
          if (artistId && t.artists?.some(a => a.id === artistId)) return true;
          return t.artists?.some(a => {
            const name = (a.name || '').toLowerCase().replace(/[^\w\s]/g, '').trim();
            return name === normTarget || name.includes(normTarget) || normTarget.includes(name);
          });
        });

        // Fallback: If strict artist name match was too narrow, use the top items returned by Spotify
        if (matched.length === 0) {
          matched = response.tracks.items.filter(t => t && !t.is_local);
        }

        if (matched.length > 0) {
          // Prioritize tracks where artist is the lead/primary artist, then by popularity
          matched.sort((a, b) => {
            const aLead = (a.artists?.[0]?.name || '').toLowerCase().replace(/[^\w\s]/g, '').trim() === normTarget;
            const bLead = (b.artists?.[0]?.name || '').toLowerCase().replace(/[^\w\s]/g, '').trim() === normTarget;
            if (aLead && !bLead) return -1;
            if (!aLead && bLead) return 1;
            return (b.popularity || 0) - (a.popularity || 0);
          });

          const formatted = matched.map(formatSpotifyTrack).filter(Boolean);
          artistTopTracksCache[cacheKey] = formatted;
          return formatted;
        }
      }
    } catch (err) {
      if (err.message?.includes('429') || err.message?.includes('Rate Limited')) {
        throw err;
      }
      console.warn(`Search top tracks for artist "${artistName}" failed:`, err);
    }
  }

  // 2. Secondary fallback: artists/{id}/top-tracks (for apps with elevated access)
  if (artistId) {
    try {
      const response = await fetchWebApi(`artists/${artistId}/top-tracks?market=from_token`);
      if (response?.tracks && Array.isArray(response.tracks) && response.tracks.length > 0) {
        const formatted = response.tracks.map(formatSpotifyTrack).filter(Boolean);
        artistTopTracksCache[cacheKey] = formatted;
        return formatted;
      }
    } catch (err) {
      if (err.message?.includes('429') || err.message?.includes('Rate Limited')) {
        throw err;
      }
      try {
        const response = await fetchWebApi(`artists/${artistId}/top-tracks?market=US`);
        if (response?.tracks && Array.isArray(response.tracks) && response.tracks.length > 0) {
          const formatted = response.tracks.map(formatSpotifyTrack).filter(Boolean);
          artistTopTracksCache[cacheKey] = formatted;
          return formatted;
        }
      } catch (fbErr) {
        if (fbErr.message?.includes('429') || fbErr.message?.includes('Rate Limited')) {
          throw fbErr;
        }
      }
    }
  }

  return [];
}

export async function addTracksToPlaylist(playlistId, trackUris) {
  return await fetchWebApi(`playlists/${playlistId}/items`, 'POST', { uris: trackUris });
}

export async function removeTracksFromPlaylist(playlistId, trackUris) {
  const tracksPayload = trackUris.map(uri => ({ uri }));
  return await fetchWebApi(`playlists/${playlistId}/items`, 'DELETE', { tracks: tracksPayload });
}

export async function getCurrentUser() {
  return await fetchWebApi('me');
}

export async function createPlaylist(userId, name, description) {
  return await fetchWebApi(`me/playlists`, 'POST', {
    name,
    description,
    public: false
  });
}

export function invalidatePlaylistCache(playlistId) {
  delete memoryCache[playlistId];
  invalidatePlaylistTracksCache(playlistId);
}

/**
 * Formats a raw Spotify track object into our consistent standardized track schema.
 */
function formatSpotifyTrack(t) {
  if (!t) return null;
  return {
    id: t.id,
    uri: t.uri,
    name: t.name,
    duration_ms: t.duration_ms,
    popularity: t.popularity || 0,
    artists: t.artists ? t.artists.map(a => ({ name: a.name, id: a.id })) : [],
    album: t.album ? { 
      name: t.album.name, 
      release_date: t.album.release_date,
      images: t.album.images || []
    } : null,
    external_ids: t.external_ids ? { isrc: t.external_ids.isrc } : null
  };
}

/**
 * Fetches the user's recently played tracks (up to 50), deduplicated by song ID.
 */
export async function getRecentlyPlayedTracks(limit = 50) {
  const response = await fetchWebApi(`me/player/recently-played?limit=${limit}`);
  if (!response?.items) return [];

  const seenIds = new Set();
  const tracks = [];

  for (const item of response.items) {
    if (item?.track && !item.track.is_local && !seenIds.has(item.track.id)) {
      seenIds.add(item.track.id);
      const formatted = formatSpotifyTrack(item.track);
      if (formatted) {
        tracks.push({
          ...formatted,
          played_at: item.played_at
        });
      }
    }
  }

  return tracks;
}

/**
 * Fetches the user's saved / liked songs (up to 50).
 */
export async function getUserSavedTracks(limit = 50) {
  const response = await fetchWebApi(`me/tracks?limit=${limit}`);
  if (!response?.items) return [];

  return response.items
    .filter(item => item?.track && !item.track.is_local)
    .map(item => ({
      ...formatSpotifyTrack(item.track),
      added_at: item.added_at
    }))
    .filter(Boolean);
}

/**
 * Searches Spotify for tracks by title, artist, or keyword.
 */
export async function searchSpotifyTracks(query, limit = 10) {
  if (!query || !query.trim()) return [];
  const safeLimit = Math.min(Math.max(1, limit), 10);
  const cleanQ = encodeURIComponent(query.trim());
  const response = await fetchWebApi(`search?q=${cleanQ}&type=track&limit=${safeLimit}`);
  if (!response?.tracks?.items) return [];

  return response.tracks.items
    .filter(t => t && !t.is_local)
    .map(formatSpotifyTrack)
    .filter(Boolean);
}


