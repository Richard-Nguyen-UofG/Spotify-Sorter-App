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
    const retrySecs = retryAfter ? parseInt(retryAfter, 10) : 5;
    
    // Auto-retry small cooldowns (<= 6 seconds)
    if (retries > 0 && retrySecs <= 6) {
      const waitTime = retrySecs * 1000;
      console.warn(`Spotify rate limited (429). Auto-waiting ${retrySecs}s before retrying...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return fetchWebApi(endpoint, method, body, retries - 1);
    }

    // Format readable cooldown message
    const timeFormatted = retrySecs >= 60 
      ? `${Math.ceil(retrySecs / 60)} minute${Math.ceil(retrySecs / 60) > 1 ? 's' : ''}`
      : `${retrySecs} second${retrySecs > 1 ? 's' : ''}`;

    throw new Error(`Spotify Rate Limited (429): Spotify is cooling down API requests for your account. Please wait approximately ${timeFormatted} (${retrySecs}s) before trying again.`);
  }

  if (!res.ok) {
    let errorMsg = await res.text();
    throw new Error(`Spotify API error: ${res.status} on endpoint [${endpoint}]. Details: ${errorMsg}`);
  }
  
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

export async function getCurrentUserPlaylists() {
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
  return allPlaylists;
}

const memoryCache = {};

export async function getPlaylistTracks(playlistId, forceRefresh = false, onProgress = null) {
  // 1. Check in-memory cache (0ms)
  if (!forceRefresh && memoryCache[playlistId]) {
    return memoryCache[playlistId];
  }

  // 2. Check IndexedDB cache (1ms, virtually unlimited size for 10,000+ tracks)
  if (!forceRefresh) {
    const idbCached = await getCachedPlaylistTracks(playlistId);
    if (idbCached && idbCached.length > 0) {
      memoryCache[playlistId] = idbCached;
      return idbCached;
    }
  }

  let allTracks = [];
  // Spotify /items endpoint accepts limit=100 to cut request count in half
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

    // Gentle 30ms delay between pages for huge playlists to prevent hitting Spotify 429
    if (url) {
      await new Promise(r => setTimeout(r, 30));
    }
  }

  // Save to Memory Cache & IndexedDB
  memoryCache[playlistId] = allTracks;
  await saveCachedPlaylistTracks(playlistId, allTracks);

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
