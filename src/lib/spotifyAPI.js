import { getToken } from './spotify';

const BASE_URL = 'https://api.spotify.com/v1';

async function fetchWebApi(endpoint, method = 'GET', body, retries = 3) {
  const token = getToken();
  const res = await fetch(`${BASE_URL}/${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (res.status === 429 && retries > 0) {
    const retryAfter = res.headers.get('Retry-After') || 2;
    const waitTime = parseInt(retryAfter, 10) * 1000;
    console.warn(`Rate limited (429). Waiting ${waitTime}ms before retrying...`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
    return fetchWebApi(endpoint, method, body, retries - 1);
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

export async function getPlaylistTracks(playlistId) {
  // 1. Check in-memory cache (fastest, survives component unmounts)
  if (memoryCache[playlistId]) {
    return memoryCache[playlistId];
  }

  // 2. Check localStorage cache (survives page refreshes)
  const cacheKey = `spotify_playlist_v3_${playlistId}`;
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      memoryCache[playlistId] = parsed; // warm up memory
      return parsed;
    } catch (e) {
      console.warn("Failed to parse cached playlist", e);
    }
  }

  let allTracks = [];
  // In February 2026, Spotify deprecated the /tracks endpoint for GET requests. We must use /items.
  let url = `playlists/${playlistId}/items?limit=50`;
  
  while (url) {
    const endpoint = url.replace(BASE_URL + '/', '');
    const response = await fetchWebApi(endpoint);
    if (response.items) {
      // Minify the tracks to fit in localStorage and save memory
      const minified = response.items.map(t => {
        if (!t.item) return t;
        return {
          is_local: t.is_local,
          item: {
            id: t.item.id,
            uri: t.item.uri,
            name: t.item.name,
            duration_ms: t.item.duration_ms,
            popularity: t.item.popularity || 0,
            artists: t.item.artists ? t.item.artists.map(a => ({ name: a.name, id: a.id })) : [],
            album: t.item.album ? { release_date: t.item.album.release_date } : null
          }
        };
      });
      allTracks = [...allTracks, ...minified];
    }
    url = response.next;
  }

  // Save to caches
  memoryCache[playlistId] = allTracks;
  try {
    localStorage.setItem(cacheKey, JSON.stringify(allTracks));
  } catch (e) {
    console.warn("Playlist too large to cache in localStorage, keeping in memory only.");
  }

  return allTracks;
}

export async function getArtists(artistIds) {
  // Spotify allows max 50 IDs per request for artists
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
  // POST /tracks deprecated in 2026, replaced by /items
  return await fetchWebApi(`playlists/${playlistId}/items`, 'POST', { uris: trackUris });
}

export async function removeTracksFromPlaylist(playlistId, trackUris) {
  const tracks = trackUris.map(uri => ({ uri }));
  // DELETE /tracks deprecated in 2026, replaced by /items
  return await fetchWebApi(`playlists/${playlistId}/items`, 'DELETE', { tracks });
}

export async function getCurrentUser() {
  return await fetchWebApi('me');
}

export async function createPlaylist(userId, name, description) {
  // POST users/{user_id}/playlists deprecated in 2026, replaced by me/playlists
  return await fetchWebApi(`me/playlists`, 'POST', {
    name,
    description,
    public: false
  });
}
