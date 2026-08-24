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
  if (candidateTrack.artists && candidateTrack.artists.length > 0) {
    for (const a of candidateTrack.artists) {
      if (topArtists.has(a.name)) {
        hasArtistMatch = true;
        matchedArtist = a.name;
        break;
      }
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
