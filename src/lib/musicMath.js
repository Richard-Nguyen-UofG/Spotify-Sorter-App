/**
 * Maps standard musical keys to their Camelot Wheel equivalent.
 * Major keys end in "B", Minor keys end in "A".
 */
const camelotMap = {
  // Minor Keys
  "Ab Minor": "1A", "G# Minor": "1A",
  "Eb Minor": "2A", "D# Minor": "2A",
  "Bb Minor": "3A", "A# Minor": "3A",
  "F Minor": "4A",
  "C Minor": "5A",
  "G Minor": "6A",
  "D Minor": "7A",
  "A Minor": "8A",
  "E Minor": "9A",
  "B Minor": "10A",
  "F# Minor": "11A", "Gb Minor": "11A",
  "C# Minor": "12A", "Db Minor": "12A",

  // Major Keys
  "B Major": "1B", "Cb Major": "1B",
  "F# Major": "2B", "Gb Major": "2B",
  "Db Major": "3B", "C# Major": "3B",
  "Ab Major": "4B", "G# Major": "4B",
  "Eb Major": "5B", "D# Major": "5B",
  "Bb Major": "6B", "A# Major": "6B",
  "F Major": "7B",
  "C Major": "8B",
  "G Major": "9B",
  "D Major": "10B",
  "A Major": "11B",
  "E Major": "12B"
};

/**
 * Checks if two keys are harmonically compatible using the Camelot Wheel.
 * Compatible means:
 * - Exact match (e.g. 8A to 8A)
 * - Relative major/minor (e.g. 8A to 8B)
 * - Adjacent on the wheel (e.g. 8A to 7A or 9A)
 */
export function isHarmonicallyCompatible(key1, key2) {
  if (!key1 || !key2) return false;
  
  // Normalize string for safety
  const k1 = key1.replace(/min/i, "Minor").replace(/maj/i, "Major").trim();
  const k2 = key2.replace(/min/i, "Minor").replace(/maj/i, "Major").trim();

  // If we can't map them, fallback to exact string match
  const cam1 = camelotMap[k1];
  const cam2 = camelotMap[k2];

  if (!cam1 || !cam2) {
    return k1.toLowerCase() === k2.toLowerCase();
  }

  // They are the exact same camelot value
  if (cam1 === cam2) return true;

  const num1 = parseInt(cam1.slice(0, -1));
  const letter1 = cam1.slice(-1);

  const num2 = parseInt(cam2.slice(0, -1));
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
