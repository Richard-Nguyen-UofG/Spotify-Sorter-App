/**
 * Complete Camelot Wheel mapping for musical keys.
 * Minor keys end in "A", Major keys end in "B".
 */
export const CAMELOT_MAP = {
  // Minor Keys (Camelot A)
  "ab minor": "1A", "g# minor": "1A", "abm": "1A", "g#m": "1A", "ab-minor": "1A", "g#-minor": "1A",
  "eb minor": "2A", "d# minor": "2A", "ebm": "2A", "d#m": "2A", "eb-minor": "2A", "d#-minor": "2A",
  "bb minor": "3A", "a# minor": "3A", "bbm": "3A", "a#m": "3A", "bb-minor": "3A", "a#-minor": "3A",
  "f minor": "4A", "fm": "4A", "f-minor": "4A",
  "c minor": "5A", "cm": "5A", "c-minor": "5A",
  "g minor": "6A", "gm": "6A", "g-minor": "6A",
  "d minor": "7A", "dm": "7A", "d-minor": "7A",
  "a minor": "8A", "am": "8A", "a-minor": "8A",
  "e minor": "9A", "em": "9A", "e-minor": "9A",
  "b minor": "10A", "bm": "10A", "b-minor": "10A",
  "f# minor": "11A", "gb minor": "11A", "f#m": "11A", "gbm": "11A", "f#-minor": "11A", "gb-minor": "11A",
  "c# minor": "12A", "db minor": "12A", "c#m": "12A", "dbm": "12A", "c#-minor": "12A", "db-minor": "12A",

  // Major Keys (Camelot B)
  "b major": "1B", "cb major": "1B", "b-major": "1B", "cb-major": "1B",
  "f# major": "2B", "gb major": "2B", "f#-major": "2B", "gb-major": "2B",
  "db major": "3B", "c# major": "3B", "db-major": "3B", "c#-major": "3B",
  "ab major": "4B", "g# major": "4B", "ab-major": "4B", "g#-major": "4B",
  "eb major": "5B", "d# major": "5B", "eb-major": "5B", "d#-major": "5B",
  "bb major": "6B", "a# major": "6B", "bb-major": "6B", "a#-major": "6B",
  "f major": "7B", "f-major": "7B",
  "c major": "8B", "c-major": "8B",
  "g major": "9B", "g-major": "9B",
  "d major": "10B", "d-major": "10B",
  "a major": "11B", "a-major": "11B",
  "e major": "12B", "e-major": "12B"
};

// Direct standard display names for Camelot codes
export const CAMELOT_TO_STANDARD = {
  "1A": "Ab Minor", "1B": "B Major",
  "2A": "Eb Minor", "2B": "F# Major",
  "3A": "Bb Minor", "3B": "Db Major",
  "4A": "F Minor",  "4B": "Ab Major",
  "5A": "C Minor",  "5B": "Eb Major",
  "6A": "G Minor",  "6B": "Bb Major",
  "7A": "D Minor",  "7B": "F Major",
  "8A": "A Minor",  "8B": "C Major",
  "9A": "E Minor",  "9B": "G Major",
  "10A": "B Minor", "10B": "D Major",
  "11A": "F# Minor","11B": "A Major",
  "12A": "C# Minor","12B": "E Major"
};

const PITCH_CLASSES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

/**
 * Normalizes pitch integer and mode to standard Key string.
 */
export function pitchClassToKey(pitch, mode) {
  if (pitch === null || pitch === undefined || pitch < 0 || pitch > 11) return null;
  const note = PITCH_CLASSES[pitch];
  const modeStr = mode === 0 ? "Minor" : "Major";
  return `${note} ${modeStr}`;
}

/**
 * Converts any key format into its standard Camelot representation (e.g. "8A", "12B").
 */
export function toCamelotKey(key, mode = null) {
  if (!key) return null;

  const keyStr = String(key).trim();
  
  // Check if it's already a Camelot key like "8A", "12b"
  const camelotMatch = keyStr.match(/^([1-9]|1[0-2])([a-bA-B])$/i);
  if (camelotMatch) {
    return `${camelotMatch[1]}${camelotMatch[2].toUpperCase()}`;
  }

  // Handle number input (pitch class) if mode is given
  if (!isNaN(keyStr) && mode !== null) {
    const pitch = parseInt(keyStr, 10);
    const stdKey = pitchClassToKey(pitch, mode);
    if (stdKey) return toCamelotKey(stdKey);
  }

  // Clean and normalize input string
  const cleaned = keyStr
    .toLowerCase()
    .replace(/♯/g, '#')
    .replace(/♭/g, 'b')
    .replace(/min$/, ' minor')
    .replace(/maj$/, ' major')
    .replace(/_/, ' ')
    .trim();

  // Try direct map lookup
  if (CAMELOT_MAP[cleaned]) {
    return CAMELOT_MAP[cleaned];
  }

  // Single letter major keys (e.g. "C", "G", "F#", "Eb")
  const majorLookup = `${cleaned} major`;
  if (CAMELOT_MAP[majorLookup]) {
    return CAMELOT_MAP[majorLookup];
  }

  return null;
}

/**
 * Normalizes any key format into clean standard text (e.g. "A Minor", "C# Major").
 */
export function normalizeKey(key, mode = null) {
  if (!key) return null;
  const camelot = toCamelotKey(key, mode);
  if (camelot && CAMELOT_TO_STANDARD[camelot]) {
    return CAMELOT_TO_STANDARD[camelot];
  }
  return String(key).trim();
}

/**
 * Checks if two keys are harmonically compatible using the Camelot Wheel.
 * Compatible means:
 * - Exact match (e.g. 8A to 8A)
 * - Relative major/minor (e.g. 8A to 8B)
 * - Adjacent on the wheel (e.g. 8A to 7A or 9A)
 */
export function isHarmonicallyCompatible(key1, key2) {
  if (!key1 || !key2) return false;
  
  const cam1 = toCamelotKey(key1);
  const cam2 = toCamelotKey(key2);

  if (!cam1 || !cam2) {
    return String(key1).toLowerCase().trim() === String(key2).toLowerCase().trim();
  }

  if (cam1 === cam2) return true;

  const num1 = parseInt(cam1.slice(0, -1), 10);
  const letter1 = cam1.slice(-1);

  const num2 = parseInt(cam2.slice(0, -1), 10);
  const letter2 = cam2.slice(-1);

  // Check Relative Major/Minor (same number, different letter)
  if (num1 === num2 && letter1 !== letter2) return true;

  // Check Adjacent (same letter, adjacent number 1-12 wrapping)
  if (letter1 === letter2) {
    const prevNum = num1 === 1 ? 12 : num1 - 1;
    const nextNum = num1 === 12 ? 1 : num1 + 1;
    if (num2 === prevNum || num2 === nextNum) return true;
  }

  return false;
}

/**
 * Calculates the smallest tempo difference between two BPMs,
 * checking for half-time and double-time relationships.
 */
export function getTrueBpmDifference(bpm1, bpm2) {
  if (!bpm1 || !bpm2) return Infinity;

  const diffStandard = Math.abs(bpm1 - bpm2);
  const diffHalf = Math.abs((bpm1 / 2) - bpm2);
  const diffDouble = Math.abs((bpm1 * 2) - bpm2);

  return Math.min(diffStandard, diffHalf, diffDouble);
}

/**
 * Calculates the Standard Deviation of an array of numbers.
 */
export function calculateStandardDeviation(values) {
  if (!values || values.length <= 1) return 0;
  
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
  
  return Math.sqrt(variance);
}

/**
 * 5D Multi-Dimensional Acoustic Distance between two tracks.
 * Evaluates: [BPM, Energy, Valence, Danceability, Acousticness]
 * Returns normalized score between 0.0 (identical) and 1.0 (opposite).
 */
export function calculate5DVibeDistance(t1, t2) {
  let dimensionsUsed = 0;
  let squaredDistance = 0;

  // 1. BPM / Tempo (Normalized by 40 BPM window)
  if (t1.bpm && t2.bpm) {
    const bpmDiff = getTrueBpmDifference(t1.bpm, t2.bpm);
    const normalizedBpmDiff = Math.min(1.0, bpmDiff / 35.0);
    squaredDistance += Math.pow(normalizedBpmDiff * 1.2, 2);
    dimensionsUsed += 1.44; // weight: 1.2^2
  }

  // 2. Energy (Weight: 1.3 - critical for mood/vibe)
  if (t1.energy !== null && t1.energy !== undefined && t2.energy !== null && t2.energy !== undefined) {
    const energyDiff = Math.abs(t1.energy - t2.energy);
    squaredDistance += Math.pow(energyDiff * 1.3, 2);
    dimensionsUsed += 1.69;
  }

  // 3. Valence / Mood (Weight: 1.2 - happy vs melancholic)
  if (t1.valence !== null && t1.valence !== undefined && t2.valence !== null && t2.valence !== undefined) {
    const valenceDiff = Math.abs(t1.valence - t2.valence);
    squaredDistance += Math.pow(valenceDiff * 1.2, 2);
    dimensionsUsed += 1.44;
  }

  // 4. Acousticness (Weight: 1.0 - acoustic/organic vs electronic)
  if (t1.acousticness !== null && t1.acousticness !== undefined && t2.acousticness !== null && t2.acousticness !== undefined) {
    const acousticDiff = Math.abs(t1.acousticness - t2.acousticness);
    squaredDistance += Math.pow(acousticDiff * 1.0, 2);
    dimensionsUsed += 1.0;
  }

  // 5. Danceability (Weight: 0.8)
  if (t1.danceability !== null && t1.danceability !== undefined && t2.danceability !== null && t2.danceability !== undefined) {
    const danceDiff = Math.abs(t1.danceability - t2.danceability);
    squaredDistance += Math.pow(danceDiff * 0.8, 2);
    dimensionsUsed += 0.64;
  }

  if (dimensionsUsed === 0) return 0.5; // fallback neutral

  const normalizedDistance = Math.sqrt(squaredDistance / dimensionsUsed);
  return Math.min(1.0, Math.max(0.0, normalizedDistance));
}

/**
 * Finds the closest matching seed track in a playlist and builds reasoning badges.
 */
export function scoreCandidateAgainstSeedTracks(candidateTrack, seedTracks, topArtists = new Set()) {
  let closestTrack = null;
  let lowestDistance = Infinity;

  for (const seed of seedTracks) {
    const dist = calculate5DVibeDistance(candidateTrack, seed);
    if (dist < lowestDistance) {
      lowestDistance = dist;
      closestTrack = seed;
    }
  }

  const similarity = Math.max(0, Math.round((1 - lowestDistance) * 100));

  // Determine Harmonic Match
  const candKey = candidateTrack.camelot || candidateTrack.key;
  let harmonicMatch = false;
  let matchedHarmonicKey = null;

  if (candKey) {
    for (const seed of seedTracks) {
      const seedKey = seed.camelot || seed.key;
      if (seedKey && isHarmonicallyCompatible(candKey, seedKey)) {
        harmonicMatch = true;
        matchedHarmonicKey = seedKey;
        break;
      }
    }
  }

  // Determine Artist Match
  let hasArtistMatch = false;
  let matchedArtist = null;
  if (candidateTrack.artists && Array.isArray(candidateTrack.artists) && candidateTrack.artists.length > 0) {
    for (const a of candidateTrack.artists) {
      const aName = typeof a === 'string' ? a : (a?.name || '');
      if (aName && topArtists.has(aName)) {
        hasArtistMatch = true;
        matchedArtist = aName;
        break;
      }
    }
  } else if (candidateTrack.artist) {
    const aName = typeof candidateTrack.artist === 'string' ? candidateTrack.artist : (candidateTrack.artist?.name || '');
    if (aName && topArtists.has(aName)) {
      hasArtistMatch = true;
      matchedArtist = aName;
    }
  }

  // Build Reasoning Badges
  const badges = [];
  if (similarity >= 80) {
    badges.push({ type: 'vibe', label: `✨ ${similarity}% Vibe Twin`, color: '#00d4ff' });
  } else if (similarity >= 65) {
    badges.push({ type: 'vibe', label: `💫 ${similarity}% Match`, color: '#60a5fa' });
  }

  if (candidateTrack.energy !== null && candidateTrack.energy !== undefined) {
    const energyPct = Math.round(candidateTrack.energy * 100);
    badges.push({
      type: 'energy',
      label: energyPct > 70 ? `⚡ ${energyPct}% Energy` : energyPct > 40 ? `🌊 ${energyPct}% Energy` : `🌙 ${energyPct}% Chill`,
      color: energyPct > 70 ? '#ff9500' : '#34c759'
    });
  }

  if (candidateTrack.bpm) {
    badges.push({ type: 'bpm', label: `🎵 ${Math.round(candidateTrack.bpm)} BPM`, color: '#a78bfa' });
  }

  if (harmonicMatch && candKey) {
    badges.push({ type: 'key', label: `🎹 Harmonic ${candKey}`, color: '#d8b4fe' });
  }

  if (hasArtistMatch) {
    badges.push({ type: 'artist', label: `👤 ${matchedArtist}`, color: '#1db954' });
  }

  // Final Composite Score (0-100)
  // Weights: 70% Vibe Similarity, 20% Harmonic Key, 5% Artist Match, 5% Popularity
  let score = similarity * 0.7; // up to 70
  if (harmonicMatch) score += 20;
  if (hasArtistMatch) score += 5;
  if (candidateTrack.popularity) score += (candidateTrack.popularity / 100) * 5;

  return {
    score: Math.round(score),
    similarity,
    closestTrack,
    badges,
    harmonicMatch,
    hasArtistMatch
  };
}

/**
 * Orders a playlist of tracks into a smooth Harmonic Flow sequence:
 * Progresses along Camelot wheel with gradual energy/tempo transition.
 */
export function calculateHarmonicSequence(tracks) {
  if (!tracks || tracks.length <= 2) return [...tracks];

  const pool = [...tracks];
  const sorted = [];

  // Start with the lowest energy/bpm track or first track
  let current = pool.splice(0, 1)[0];
  sorted.push(current);

  while (pool.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < pool.length; i++) {
      const candidate = pool[i];
      let score = 0;

      // 1. Camelot Key Transition (High priority)
      const curKey = current.camelot || current.key;
      const candKey = candidate.camelot || candidate.key;
      if (curKey && candKey && isHarmonicallyCompatible(curKey, candKey)) {
        score += 50;
        if (curKey === candKey) score += 15; // exact key match bonus
      }

      // 2. Tempo Proximity (BPM within 5-10 is great)
      if (current.bpm && candidate.bpm) {
        const bpmDiff = getTrueBpmDifference(current.bpm, candidate.bpm);
        score += Math.max(0, 30 - bpmDiff * 2);
      }

      // 3. Smooth Energy Transition (minimize jarring jumps)
      if (current.energy !== null && candidate.energy !== null) {
        const energyDiff = Math.abs(current.energy - candidate.energy);
        score += Math.max(0, 20 - energyDiff * 25);
      }

      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    current = pool.splice(bestIndex, 1)[0];
    sorted.push(current);
  }

  return sorted;
}

/**
 * Clean and normalize song titles by removing feature tags, remaster tags, etc.
 */
export function normalizeSongTitle(title) {
  if (!title) return '';
  const titleStr = typeof title === 'string' ? title : (title?.name || title?.title || '');
  return String(titleStr || '')
    .toLowerCase()
    .replace(/\s*[\(\[](feat\.|ft\.|with|featuring).*?[\)\]]/gi, '')
    .replace(/\s*[-–—/]\s*(remastered|remaster|single version|album version|radio edit|original mix|deluxe edition|bonus track|anniversary edition|version orchestrale|orchestral|version|mix|edit|mono|stereo|live|acoustic).*$/i, '')
    .replace(/\s*[\(\[](remastered|remaster|single version|album version|radio edit|original mix|deluxe|bonus|anniversary|version|mix|edit|mono|stereo|live|acoustic|orchestral).*?[\)\]]/gi, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Clean and normalize artist name from a track object.
 */
export function normalizeArtistName(track) {
  if (!track) return '';
  let artist = '';
  if (track.artists && Array.isArray(track.artists) && track.artists.length > 0) {
    const first = track.artists[0];
    artist = typeof first === 'string' ? first : (first?.name || '');
  } else if (typeof track.artist === 'string') {
    artist = track.artist.split(',')[0].split('feat')[0].split('ft.')[0];
  } else if (track.artist && typeof track.artist === 'object') {
    artist = track.artist.name || '';
  }
  return String(artist || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Returns a normalized song key (Artist + Title) for cross-release deduplication.
 */
export function getNormalizedSongKey(track) {
  if (!track) return null;
  const isrc = track.external_ids?.isrc || track.isrc;
  const normTitle = normalizeSongTitle(track.name || track.title);
  const normArtist = normalizeArtistName(track);
  if (!normTitle || !normArtist) {
    return isrc ? `isrc_${isrc}` : (track.id || null);
  }
  return `${normArtist}___${normTitle}`;
}

/**
 * Computes an acoustic vibe profile and centroid for a playlist.
 */
export function computePlaylistProfile(playlistId, playlistName, snapshotId, tracksWithFeatures) {
  const tracks = tracksWithFeatures || [];
  let totalEnergy = 0, validEnergy = 0;
  let totalValence = 0, validValence = 0;
  let totalDance = 0, validDance = 0;
  let totalAcoustic = 0, validAcoustic = 0;
  let totalBpm = 0, validBpm = 0;
  const bpmArray = [];
  const keyCounts = {};
  const artistCounts = {};
  const trackIds = [];
  const trackIsrcs = [];
  const trackNormalizedKeys = [];

  for (const t of tracks) {
    if (!t) continue;
    if (t.id) trackIds.push(t.id);
    const isrc = t.external_ids?.isrc || t.isrc;
    if (isrc) trackIsrcs.push(isrc);
    const normKey = getNormalizedSongKey(t);
    if (normKey) trackNormalizedKeys.push(normKey);

    if (t.energy !== null && t.energy !== undefined && !isNaN(t.energy)) {
      totalEnergy += t.energy;
      validEnergy++;
    }
    if (t.valence !== null && t.valence !== undefined && !isNaN(t.valence)) {
      totalValence += t.valence;
      validValence++;
    }
    if (t.danceability !== null && t.danceability !== undefined && !isNaN(t.danceability)) {
      totalDance += t.danceability;
      validDance++;
    }
    if (t.acousticness !== null && t.acousticness !== undefined && !isNaN(t.acousticness)) {
      totalAcoustic += t.acousticness;
      validAcoustic++;
    }
    if (t.bpm && !isNaN(t.bpm)) {
      totalBpm += t.bpm;
      validBpm++;
      bpmArray.push(t.bpm);
    }

    const key = t.camelot || t.key;
    if (key) {
      keyCounts[key] = (keyCounts[key] || 0) + 1;
    }

    if (t.artists && Array.isArray(t.artists)) {
      t.artists.forEach(a => {
        const name = typeof a === 'string' ? a : a?.name;
        if (name) artistCounts[name] = (artistCounts[name] || 0) + 1;
      });
    } else if (t.artist) {
      const name = typeof t.artist === 'string' ? t.artist : t.artist?.name;
      if (name) artistCounts[name] = (artistCounts[name] || 0) + 1;
    }
  }

  const topKeys = Object.entries(keyCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(e => e[0]);

  const topArtists = Object.entries(artistCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(e => e[0]);

  const bpmStdDev = calculateStandardDeviation(bpmArray);

  return {
    playlist_id: playlistId,
    name: playlistName,
    snapshot_id: snapshotId,
    track_count: tracks.length,
    centroid: {
      energy: validEnergy > 0 ? totalEnergy / validEnergy : 0.5,
      valence: validValence > 0 ? totalValence / validValence : 0.5,
      danceability: validDance > 0 ? totalDance / validDance : 0.5,
      acousticness: validAcoustic > 0 ? totalAcoustic / validAcoustic : 0.2,
      bpm: validBpm > 0 ? totalBpm / validBpm : null,
      bpmStdDev: bpmStdDev || 10
    },
    topKeys,
    topArtists,
    trackIds,
    trackIsrcs,
    trackNormalizedKeys
  };
}

/**
 * Matches a single song against multiple destination playlist profiles.
 * Returns an array of compatibility results ranked by match percentage.
 */
export function matchSongToPlaylists(song, playlistProfiles) {
  if (!song || !Array.isArray(playlistProfiles) || playlistProfiles.length === 0) {
    return [];
  }

  const songId = song.id || null;
  const songIsrc = song.external_ids?.isrc || song.isrc || null;
  const songNormKey = getNormalizedSongKey(song);

  const songEnergy = song.energy ?? 0.5;
  const songValence = song.valence ?? 0.5;
  const songDance = song.danceability ?? 0.5;
  const songAcoustic = song.acousticness ?? 0.2;
  const songBpm = song.bpm || null;
  const songKey = song.camelot || song.key || null;

  // Extract artist names from song
  const songArtists = [];
  if (song.artists && Array.isArray(song.artists)) {
    song.artists.forEach(a => {
      const n = typeof a === 'string' ? a : a?.name;
      if (n) songArtists.push(n);
    });
  } else if (song.artist) {
    const n = typeof song.artist === 'string' ? song.artist : song.artist?.name;
    if (n) songArtists.push(n);
  }

  const results = playlistProfiles.map(profile => {
    const centroid = profile.centroid;

    // Multi-layer duplicate detection:
    // 1. Direct Spotify ID match
    // 2. Universal ISRC match
    // 3. Normalized Title + Artist match (e.g. Single vs Album vs Remaster)
    const isAlreadyIn = Boolean(
      (songId && profile.trackIds && profile.trackIds.includes(songId)) ||
      (songIsrc && profile.trackIsrcs && profile.trackIsrcs.includes(songIsrc)) ||
      (songNormKey && profile.trackNormalizedKeys && profile.trackNormalizedKeys.includes(songNormKey))
    );

    // 1. Acoustic dimension distance (Energy, Valence, Danceability, Acousticness)
    const energyDiff = Math.abs(songEnergy - centroid.energy);
    const valenceDiff = Math.abs(songValence - centroid.valence);
    const danceDiff = Math.abs(songDance - centroid.danceability);
    const acousticDiff = Math.abs(songAcoustic - centroid.acousticness);

    // Weighted distance (0.0 to 1.0)
    const weightedDist = (energyDiff * 1.3 + valenceDiff * 1.1 + danceDiff * 0.9 + acousticDiff * 0.7) / 4.0;
    let baseScore = Math.max(0, Math.min(100, Math.round((1 - weightedDist) * 100)));

    // 2. Tempo alignment
    let bpmPenalty = 0;
    let bpmMatch = false;
    if (songBpm && centroid.bpm) {
      const bpmDiff = getTrueBpmDifference(songBpm, centroid.bpm);
      const tolerance = Math.max(10, Math.min(25, centroid.bpmStdDev * 1.5));
      if (bpmDiff <= tolerance) {
        bpmMatch = true;
      } else {
        bpmPenalty = Math.min(20, Math.round((bpmDiff - tolerance) * 1.2));
      }
    }

    // 3. Harmonic Key Compatibility
    let harmonicMatch = false;
    let matchedKey = null;
    if (songKey && profile.topKeys && profile.topKeys.length > 0) {
      for (const k of profile.topKeys) {
        if (isHarmonicallyCompatible(songKey, k)) {
          harmonicMatch = true;
          matchedKey = k;
          break;
        }
      }
    }

    // 4. Artist Familiarity
    let artistMatch = false;
    let matchedArtistName = null;
    if (profile.topArtists && profile.topArtists.length > 0 && songArtists.length > 0) {
      for (const a of songArtists) {
        if (profile.topArtists.includes(a)) {
          artistMatch = true;
          matchedArtistName = a;
          break;
        }
      }
    }

    // Composite Final Score
    let finalScore = baseScore - bpmPenalty;
    if (harmonicMatch) finalScore += 6;
    if (artistMatch) finalScore += 5;
    finalScore = Math.max(5, Math.min(99, Math.round(finalScore)));

    // Reasoning Badges
    const badges = [];
    if (finalScore >= 85) {
      badges.push({ label: `✨ ${finalScore}% Vibe Twin`, color: '#00d4ff' });
    } else if (finalScore >= 70) {
      badges.push({ label: `💫 ${finalScore}% Great Fit`, color: '#60a5fa' });
    } else {
      badges.push({ label: `${finalScore}% Match`, color: 'var(--text-secondary)' });
    }

    if (energyDiff < 0.18) {
      const energyPct = Math.round(songEnergy * 100);
      badges.push({ label: `⚡ Energy Match (${energyPct}%)`, color: '#ff9500' });
    }

    if (bpmMatch && songBpm && centroid.bpm) {
      badges.push({ label: `🎵 ${Math.round(songBpm)} BPM (~${Math.round(centroid.bpm)} avg)`, color: '#a78bfa' });
    }

    if (harmonicMatch && matchedKey) {
      badges.push({ label: `🔑 Harmonic Fit (${songKey})`, color: '#34c759' });
    }

    if (artistMatch && matchedArtistName) {
      badges.push({ label: `🎤 Plays ${matchedArtistName}`, color: '#ec4899' });
    }

    return {
      playlistId: profile.playlist_id,
      playlistName: profile.name,
      trackCount: profile.track_count,
      score: finalScore,
      isAlreadyIn,
      badges,
      centroid,
      energyDiff,
      bpmDiff: (songBpm && centroid.bpm) ? Math.abs(songBpm - centroid.bpm) : 999,
      harmonicMatch
    };
  });

  return results.sort((a, b) => b.score - a.score);
}

/**
 * Builds fast O(1) lookup Sets for the 3-layer deduplication check
 * across all pool tracks.
 */
export function buildPoolLookupSets(poolTracks) {
  const ids = new Set();
  const isrcs = new Set();
  const normKeys = new Set();

  if (!Array.isArray(poolTracks)) return { ids, isrcs, normKeys };

  for (const t of poolTracks) {
    if (!t) continue;
    if (t.id) ids.add(t.id);
    if (t.spotify_id) ids.add(t.spotify_id);
    const isrc = t.external_ids?.isrc || t.isrc;
    if (isrc) isrcs.add(isrc);
    const normKey = getNormalizedSongKey(t);
    if (normKey) normKeys.add(normKey);
  }

  return { ids, isrcs, normKeys };
}

/**
 * Scans a pool of tracks, groups them by primary/featured artists,
 * counts occurrences across the pool, filters by max threshold,
 * and excludes blacklisted artist IDs.
 *
 * @param {Array} poolTracks - List of tracks in master pool
 * @param {number} maxTrackThreshold - Max songs allowed (default 3, meaning artists with 1..3 songs)
 * @param {Set|Array} excludedArtistIds - IDs/keys of artists the user blacklisted
 * @returns {Array} List of under-represented artists: [{ id, name, count, sampleTracks: [...] }]
 */
export function findUnderRepresentedArtists(poolTracks, maxTrackThreshold = 3, excludedArtistIds = new Set()) {
  if (!Array.isArray(poolTracks) || poolTracks.length === 0) return [];

  const excludedSet = excludedArtistIds instanceof Set 
    ? excludedArtistIds 
    : new Set(excludedArtistIds || []);

  const artistMap = new Map();

  for (const track of poolTracks) {
    if (!track) continue;

    // Extract artists
    let artistsList = [];
    if (Array.isArray(track.artists) && track.artists.length > 0) {
      artistsList = track.artists;
    } else if (track.artist) {
      if (typeof track.artist === 'string') {
        artistsList = track.artist.split(',').map(name => ({ name: name.trim(), id: null }));
      } else if (typeof track.artist === 'object') {
        artistsList = [track.artist];
      }
    }

    for (const a of artistsList) {
      if (!a) continue;
      const artistName = typeof a === 'string' ? a.trim() : (a.name || '').trim();
      const artistId = typeof a === 'object' && a?.id ? a.id : null;
      if (!artistName) continue;

      // Key by artistId if available, otherwise by normalized name
      const key = artistId ? `id_${artistId}` : `name_${artistName.toLowerCase()}`;
      
      if (artistId && excludedSet.has(artistId)) continue;
      if (excludedSet.has(artistName.toLowerCase())) continue;
      if (excludedSet.has(key)) continue;

      if (!artistMap.has(key)) {
        artistMap.set(key, {
          key,
          id: artistId,
          name: artistName,
          count: 0,
          sampleTracks: []
        });
      }

      const entry = artistMap.get(key);
      entry.count++;
      if (entry.sampleTracks.length < 3) {
        entry.sampleTracks.push(track);
      }
      // If artistId was null before but now found, update it
      if (!entry.id && artistId) {
        entry.id = artistId;
      }
    }
  }

  // Filter by threshold (1 <= count <= maxTrackThreshold)
  const results = [];
  for (const entry of artistMap.values()) {
    if (entry.count >= 1 && entry.count <= maxTrackThreshold && (entry.id || entry.name)) {
      results.push(entry);
    }
  }

  // Sort by count ascending (1 song first, then 2, etc.), then alphabetically by name
  return results.sort((a, b) => {
    if (a.count !== b.count) return a.count - b.count;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Takes candidates fetched from Spotify for an artist and eliminates
 * any track that already exists in the user's master pool using the 3-layer check:
 * 1. Spotify ID
 * 2. ISRC
 * 3. Normalized Title + Artist
 *
 * @param {Array} artistTracks - Raw/formatted tracks from Spotify API
 * @param {Set} poolTrackIds - Set of track IDs in master pool
 * @param {Set} poolIsrcs - Set of ISRCs in master pool
 * @param {Set} poolNormKeys - Set of normalized song keys (artist___title)
 * @returns {Array} Candidate tracks that are completely unheard / not in master pool
 */
export function filterUnheardArtistTracks(artistTracks, poolTrackIds, poolIsrcs, poolNormKeys) {
  if (!Array.isArray(artistTracks)) return [];

  const uniqueCandidates = [];
  const seenCandidateKeys = new Set();

  for (const t of artistTracks) {
    if (!t) continue;

    // 1. Check ID
    if (t.id && poolTrackIds && poolTrackIds.has(t.id)) {
      continue;
    }

    // 2. Check ISRC
    const isrc = t.external_ids?.isrc || t.isrc;
    if (isrc && poolIsrcs && poolIsrcs.has(isrc)) {
      continue;
    }

    // 3. Check Normalized Title + Artist
    const normKey = getNormalizedSongKey(t);
    if (normKey && poolNormKeys && poolNormKeys.has(normKey)) {
      continue;
    }

    // Deduplicate within the candidate batch itself
    const dedupKey = t.id || normKey || isrc;
    if (dedupKey && seenCandidateKeys.has(dedupKey)) {
      continue;
    }
    if (dedupKey) seenCandidateKeys.add(dedupKey);

    uniqueCandidates.push(t);
  }

  return uniqueCandidates;
}


