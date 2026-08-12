let lastRequestTime = 0;

export async function fetchBPMAndKey(trackName, artistName) {
  if (!trackName || !artistName) return { tempo: null, key: null };

  // Clean names to maximize search success and cache hits
  const cleanTrack = trackName.toLowerCase().split(/ - |\(/)[0].trim();
  const cleanArtist = artistName.toLowerCase();
  
  const cacheKey = `gsb_v1_${cleanArtist}_${cleanTrack}`;
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (e) {
      // ignore parsing errors
    }
  }

  // Throttle to respect the 3000 req/hr (0.83 req/sec = ~1200ms per request)
  const now = Date.now();
  const timeSinceLast = now - lastRequestTime;
  if (timeSinceLast < 1200) {
    await new Promise(resolve => setTimeout(resolve, 1200 - timeSinceLast));
  }
  
  lastRequestTime = Date.now();
  const apiKey = import.meta.env.VITE_GETSONGBPM_API_KEY;
  if (!apiKey) return { tempo: null, key: null };

  // Use the search endpoint with type=both
  const query = `song:${cleanTrack} artist:${cleanArtist}`;
  const url = `https://api.getsong.co/search/?api_key=${apiKey}&type=both&lookup=${encodeURIComponent(query)}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
       console.warn("GetSongBPM error or rate limit hit");
       const emptyResult = { tempo: null, key: null };
       localStorage.setItem(cacheKey, JSON.stringify(emptyResult));
       return emptyResult;
    }
    
    const data = await res.json();
    let result = { tempo: null, key: null };
    
    // Parse response carefully based on standard GetSongBPM structures
    if (data && data.search && data.search.songs && data.search.songs.length > 0) {
      result.tempo = data.search.songs[0].tempo;
      result.key = data.search.songs[0].key_of || data.search.songs[0].key;
    } else if (data && data.song) {
      result.tempo = data.song.tempo;
      result.key = data.song.key_of || data.song.key;
    }

    // Convert strings to proper types if needed
    if (result.tempo) result.tempo = parseFloat(result.tempo);

    localStorage.setItem(cacheKey, JSON.stringify(result));
    return result;
  } catch (err) {
    console.error("GetSongBPM network error:", err);
    // Cache the failure so we don't spam the API with bad queries
    const emptyResult = { tempo: null, key: null };
    localStorage.setItem(cacheKey, JSON.stringify(emptyResult));
    return emptyResult;
  }
}
