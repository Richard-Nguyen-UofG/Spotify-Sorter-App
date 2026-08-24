import { useEffect, useState, useCallback, useMemo } from 'react';
import { 
  getPlaylistTracks, 
  addTracksToPlaylist, 
  removeTracksFromPlaylist, 
  getCurrentUser, 
  createPlaylist,
  invalidatePlaylistCache
} from '../lib/spotifyAPI';
import { fetchAcousticFeaturesForTracks } from '../lib/audioFeatureEngine';
import { 
  scoreCandidateAgainstSeedTracks, 
  getTrueBpmDifference, 
  calculateStandardDeviation 
} from '../lib/musicMath';
import LibraryManagerModal from './LibraryManagerModal';
import { 
  Check, 
  X, 
  AlertCircle, 
  Database, 
  Disc3, 
  Zap, 
  Flame, 
  Smile, 
  Play, 
  Pause,
  Plus, 
  Sliders, 
  Filter,
  RotateCcw,
  ShieldCheck
} from 'lucide-react';

/**
 * Cleans song titles by stripping remaster suffixes, edition tags, and feature brackets
 * e.g. "Caribbean Blue - Single Version" -> "caribbean blue"
 * e.g. "Love Story - Version Orchestrale" -> "love story"
 * e.g. "Starboy (feat. Daft Punk) - Remastered" -> "starboy"
 */
export function normalizeSongTitle(title) {
  if (!title) return '';
  return title
    .toLowerCase()
    .replace(/\s*[\(\[](feat\.|ft\.|with|featuring).*?[\)\]]/gi, '')
    .replace(/\s*[-–—/]\s*(remastered|remaster|single version|album version|radio edit|original mix|deluxe edition|bonus track|anniversary edition|version orchestrale|orchestral|version|mix|edit|mono|stereo|live|acoustic).*$/i, '')
    .replace(/\s*[\(\[](remastered|remaster|single version|album version|radio edit|original mix|deluxe|bonus|anniversary|version|mix|edit|mono|stereo|live|acoustic|orchestral).*?[\)\]]/gi, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeArtistName(track) {
  if (!track) return '';
  let artist = '';
  if (track.artists && Array.isArray(track.artists) && track.artists.length > 0) {
    artist = track.artists[0]?.name || track.artists[0] || '';
  } else if (typeof track.artist === 'string') {
    artist = track.artist.split(',')[0].split('feat')[0].split('ft.')[0];
  }
  return artist.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

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
 * Clean dual-thumb double-ended range slider
 */
function DualRangeSlider({ min, max, step = 1, minValue, maxValue, onChange, color = '#1DB954' }) {
  const minPercent = Math.min(100, Math.max(0, ((minValue - min) / (max - min)) * 100));
  const maxPercent = Math.min(100, Math.max(0, ((maxValue - min) / (max - min)) * 100));

  const handleMinChange = (e) => {
    const val = Math.min(Number(e.target.value), maxValue);
    onChange(val, maxValue);
  };

  const handleMaxChange = (e) => {
    const val = Math.max(Number(e.target.value), minValue);
    onChange(minValue, val);
  };

  return (
    <div className="dual-slider-container">
      <div className="dual-slider-track-bg" />
      <div 
        className="dual-slider-track-active" 
        style={{
          left: `${minPercent}%`,
          width: `${Math.max(0, maxPercent - minPercent)}%`,
          backgroundColor: color
        }}
      />
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={minValue}
        onChange={handleMinChange}
        className="dual-slider-input"
        style={{ zIndex: minValue > max - 10 ? 5 : 3 }}
      />
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={maxValue}
        onChange={handleMaxChange}
        className="dual-slider-input"
        style={{ zIndex: 4 }}
      />
    </div>
  );
}

export default function Analyzer({ targetPlaylist, masterPools, onBack }) {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("Initializing...");
  const [progressMsg, setProgressMsg] = useState("");
  const [progressPercent, setProgressPercent] = useState(0);
  const [analysis, setAnalysis] = useState(null);
  const [error, setError] = useState(null);
  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState(null);
  const [showLibraryModal, setShowLibraryModal] = useState(false);

  // Interactive Curation State
  const [sortBy, setSortBy] = useState('vibe'); // 'vibe' (Highest Vibe %) or 'composite' (Smart Weighted)
  const [maxSuggestions, setMaxSuggestions] = useState(25);
  const [activePreviewTrackId, setActivePreviewTrackId] = useState(null);
  const [addedTrackIds, setAddedTrackIds] = useState(new Set());
  const [removedTrackIds, setRemovedTrackIds] = useState(new Set());
  const [keptTrackIds, setKeptTrackIds] = useState(new Set());
  const [dismissedFitTrackIds, setDismissedFitTrackIds] = useState(new Set()); // strictly in-memory (resets on re-analyze/refresh)
  const [actionInProgressId, setActionInProgressId] = useState(null);

  // Double-Ended Sliding Acoustic Filter State
  const [minEnergy, setMinEnergy] = useState(0);       // 0% - 100%
  const [maxEnergy, setMaxEnergy] = useState(100);     // 0% - 100%
  const [minValence, setMinValence] = useState(0);     // 0% - 100% (Mood)
  const [maxValence, setMaxValence] = useState(100);   // 0% - 100%
  const [minDance, setMinDance] = useState(0);         // 0% - 100% (Danceability)
  const [maxDance, setMaxDance] = useState(100);       // 0% - 100%
  const [minBpm, setMinBpm] = useState(50);            // 50 - 220 BPM
  const [maxBpm, setMaxBpm] = useState(220);           // 50 - 220 BPM
  const [showFilterDrawer, setShowFilterDrawer] = useState(false);

  const performAnalysis = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setProgressPercent(5);
      setStatus("Fetching target playlist tracks from Spotify...");
      
      const targetTracksRaw = await getPlaylistTracks(targetPlaylist.id);
      const targetTracks = targetTracksRaw
        .filter(t => (t.item || t.track) && !t.is_local)
        .map(t => t.item || t.track); 
      
      if (targetTracks.length === 0) {
        throw new Error("Target playlist is empty or contains no valid tracks.");
      }
      
      setProgressPercent(15);
      setStatus("Fetching master pool tracks from Spotify...");
      let masterTracks = [];
      for (const pool of masterPools) {
        const poolTracksRaw = await getPlaylistTracks(pool.id);
        masterTracks = [
          ...masterTracks, 
          ...poolTracksRaw.filter(t => (t.item || t.track) && !t.is_local).map(t => t.item || t.track)
        ];
      }

      // Deduplicate master tracks by normalized Song (Artist + Clean Title)
      const uniqueMasterTracksMap = new Map();
      for (const t of masterTracks) {
        if (t && (t.id || t.name)) {
          const dedupKey = getNormalizedSongKey(t) || t.id;
          if (uniqueMasterTracksMap.has(dedupKey)) {
            const existing = uniqueMasterTracksMap.get(dedupKey);
            if ((t.popularity || 0) > (existing.popularity || 0)) {
              uniqueMasterTracksMap.set(dedupKey, t);
            }
          } else {
            uniqueMasterTracksMap.set(dedupKey, t);
          }
        }
      }
      const uniqueMasterTracks = Array.from(uniqueMasterTracksMap.values());

      setStatus("Fetching Acoustic Data (IndexedDB + Musicae.io)...");
      const allTracksToAnalyze = [...targetTracks, ...uniqueMasterTracks];
      
      const acousticResult = await fetchAcousticFeaturesForTracks(allTracksToAnalyze, (progress) => {
        setStatus(progress.message);
        setProgressMsg(progress.message);
        if (progress.percent) setProgressPercent(progress.percent);
      });

      const { tracksWithFeatures, stats: lookupStats, missingTracks, rateLimitHit } = acousticResult;

      const targetTracksWithFeatures = tracksWithFeatures.slice(0, targetTracks.length);
      const uniqueMasterTracksWithFeatures = tracksWithFeatures.slice(targetTracks.length);

      setStatus("Computing 5D Vibe Clustering & Harmonic Profiles...");
      setProgressPercent(90);

      let totalYear = 0;
      let totalDuration = 0;
      let totalBPM = 0;
      let validYearCount = 0;
      let validBPMCount = 0;
      let totalDanceability = 0;
      let validDanceCount = 0;
      let totalEnergy = 0;
      let validEnergyCount = 0;
      let totalValence = 0;
      let validValenceCount = 0;
      let totalAcousticness = 0;
      let validAcousticCount = 0;
      const artistCounts = {};
      const keyCounts = {};
      const bpmArray = [];

      for (const t of targetTracksWithFeatures) {
        if (t.album && t.album.release_date) {
          const year = new Date(t.album.release_date).getFullYear();
          if (!isNaN(year)) {
            totalYear += year;
            validYearCount++;
          }
        }
        
        if (t.duration_ms) totalDuration += t.duration_ms;

        if (t.bpm) {
          totalBPM += t.bpm;
          validBPMCount++;
          bpmArray.push(t.bpm);
        }
        if (t.danceability !== null && t.danceability !== undefined) {
          totalDanceability += t.danceability;
          validDanceCount++;
        }
        if (t.energy !== null && t.energy !== undefined) {
          totalEnergy += t.energy;
          validEnergyCount++;
        }
        if (t.valence !== null && t.valence !== undefined) {
          totalValence += t.valence;
          validValenceCount++;
        }
        if (t.acousticness !== null && t.acousticness !== undefined) {
          totalAcousticness += t.acousticness;
          validAcousticCount++;
        }
        
        const effectiveKey = t.camelot || t.key;
        if (effectiveKey) {
          keyCounts[effectiveKey] = (keyCounts[effectiveKey] || 0) + 1;
        }

        if (t.artists && t.artists.length > 0) {
          t.artists.forEach(a => {
            artistCounts[a.name] = (artistCounts[a.name] || 0) + 1;
          });
        }
      }

      const avgYear = validYearCount > 0 ? totalYear / validYearCount : new Date().getFullYear();
      const avgDuration = targetTracksWithFeatures.length > 0 ? totalDuration / targetTracksWithFeatures.length : 180000;
      const avgBPM = validBPMCount > 0 ? totalBPM / validBPMCount : null;
      const avgDanceability = validDanceCount > 0 ? totalDanceability / validDanceCount : null;
      const avgEnergy = validEnergyCount > 0 ? totalEnergy / validEnergyCount : null;
      const avgValence = validValenceCount > 0 ? totalValence / validValenceCount : null;
      const avgAcousticness = validAcousticCount > 0 ? totalAcousticness / validAcousticCount : null;
      
      const bpmStdDev = calculateStandardDeviation(bpmArray);
      const bpmFlexibility = Math.max(5, Math.min(30, Math.round(bpmStdDev + 5)));
      
      const sortedKeys = Object.entries(keyCounts).sort((a, b) => b[1] - a[1]);
      const dominantKey = sortedKeys.length > 0 ? sortedKeys[0][0] : null;
      
      const sortedArtists = Object.entries(artistCounts).sort((a, b) => b[1] - a[1]);
      const topArtists = new Set(sortedArtists.slice(0, 10).map(a => a[0]));

      const vibeProfile = {
        avgYear,
        avgDuration,
        avgBPM,
        avgDanceability,
        avgEnergy,
        avgValence,
        avgAcousticness,
        bpmFlexibility,
        dominantKey,
        topArtists,
        topArtistNames: Array.from(topArtists).slice(0, 3)
      };

      // ----------------------------------------------------
      // 1. Outlier Detection (5D Cluster Distance + Extreme Deltas)
      // ----------------------------------------------------
      const outliers = targetTracksWithFeatures.map(t => {
        const year = t.album && t.album.release_date ? new Date(t.album.release_date).getFullYear() : avgYear;
        const duration = t.duration_ms || avgDuration;
        
        let bpmDiff = 0;
        if (avgBPM && t.bpm) {
          bpmDiff = getTrueBpmDifference(t.bpm, avgBPM);
        }
        
        let energyDiff = 0;
        if (avgEnergy !== null && t.energy !== null && t.energy !== undefined) {
          energyDiff = Math.abs(t.energy - avgEnergy);
        }

        const outlierReasons = [];
        if (Math.abs(year - avgYear) > 22) {
          outlierReasons.push(`Era (${year} vs ~${Math.round(avgYear)})`);
        }
        if (Math.abs(duration - avgDuration) > 160000) {
          outlierReasons.push(`Length (${formatTime(duration)})`);
        }
        if (t.bpm && bpmDiff > bpmFlexibility * 1.6) {
          outlierReasons.push(`BPM (${Math.round(t.bpm)} vs ~${Math.round(avgBPM)})`);
        }
        if (energyDiff > 0.52) {
          outlierReasons.push(`Energy (${Math.round((t.energy || 0) * 100)}% vs ~${Math.round(avgEnergy * 100)}%)`);
        }

        return {
          track: t,
          year,
          duration,
          isOutlier: outlierReasons.length > 0,
          outlierReasons
        };
      }).filter(o => o.isOutlier);

      // ----------------------------------------------------
      // 2. 5D Vibe Distance Scoring for Master Pool Candidates
      // ----------------------------------------------------
      const targetIds = new Set(targetTracksWithFeatures.map(t => t.id).filter(Boolean));
      const targetIsrcs = new Set(targetTracksWithFeatures.map(t => t.external_ids?.isrc || t.isrc).filter(Boolean));
      const targetNormalizedKeys = new Set(targetTracksWithFeatures.map(getNormalizedSongKey).filter(Boolean));

      const candidates = uniqueMasterTracksWithFeatures
        .filter(t => {
          // 1. Direct Spotify ID match
          if (t.id && targetIds.has(t.id)) return false;
          // 2. ISRC recording match
          const isrc = t.external_ids?.isrc || t.isrc;
          if (isrc && targetIsrcs.has(isrc)) return false;
          // 3. Normalized Title + Artist match (Single vs Album vs Remaster)
          const normKey = getNormalizedSongKey(t);
          if (normKey && targetNormalizedKeys.has(normKey)) return false;
          return true;
        });

      const scoredFits = candidates.map(candidate => {
        const { score, similarity, closestTrack, badges, harmonicMatch, hasArtistMatch } = 
          scoreCandidateAgainstSeedTracks(candidate, targetTracksWithFeatures, topArtists);

        const year = candidate.album && candidate.album.release_date 
          ? new Date(candidate.album.release_date).getFullYear() 
          : avgYear;
        const duration = candidate.duration_ms || avgDuration;

        return {
          track: candidate,
          year,
          duration,
          score,
          similarity,
          closestTrack,
          badges,
          harmonicMatch,
          hasArtistMatch
        };
      });

      const validFits = scoredFits.filter(f => f.similarity >= 45 || f.score >= 40);
      validFits.sort((a, b) => b.score - a.score);

      // ----------------------------------------------------
      // 3. Duplicate Detection (Multiple copies in target playlist)
      // ----------------------------------------------------
      const duplicateMap = new Map();
      targetTracksWithFeatures.forEach(t => {
        const key = getNormalizedSongKey(t);
        if (key) {
          if (!duplicateMap.has(key)) duplicateMap.set(key, []);
          duplicateMap.get(key).push(t);
        }
      });

      const duplicateSets = [];
      for (const [, trackGroup] of duplicateMap.entries()) {
        if (trackGroup.length > 1) {
          duplicateSets.push({
            name: trackGroup[0].name,
            artist: trackGroup[0].artists?.[0]?.name || trackGroup[0].artist,
            count: trackGroup.length,
            tracks: trackGroup
          });
        }
      }

      setProgressPercent(100);
      setAnalysis({
        vibeProfile,
        outliers,
        allFits: validFits,
        duplicateSets,
        lookupStats,
        missingTracks: missingTracks || [],
        rateLimitHit
      });

    } catch (err) {
      console.error(err);
      if (err.message?.includes('401') && !err.message?.includes('Musicae') && !err.message?.includes('RapidAPI')) {
        setError(`Your Spotify session expired! Please click "Go Back", hit "Logout" at the top right, and log back in.`);
      } else {
        setError(err.message);
      }
    } finally {
      setLoading(false);
      setProgressMsg("");
    }
  }, [targetPlaylist, masterPools]);

  useEffect(() => {
    performAnalysis();
  }, [performAnalysis]);

  // Active filter count and reset handler
  const activeFilterCount = (minEnergy > 0 || maxEnergy < 100 ? 1 : 0) + 
                            (minValence > 0 || maxValence < 100 ? 1 : 0) + 
                            (minDance > 0 || maxDance < 100 ? 1 : 0) + 
                            (minBpm > 50 || maxBpm < 220 ? 1 : 0);

  const handleResetFilters = () => {
    setMinEnergy(0);
    setMaxEnergy(100);
    setMinValence(0);
    setMaxValence(100);
    setMinDance(0);
    setMaxDance(100);
    setMinBpm(50);
    setMaxBpm(220);
  };

  const displayedFits = useMemo(() => {
    if (!analysis?.allFits) return [];
    // 1. Filter out dismissed / hidden tracks for this session
    let fits = analysis.allFits.filter(f => !dismissedFitTrackIds.has(f.track.id));

    // 2. Double-Ended Acoustic Range Filters
    if (minEnergy > 0 || maxEnergy < 100) {
      fits = fits.filter(f => {
        if (f.track.energy === null || f.track.energy === undefined) return true;
        const energyPct = Math.round(f.track.energy * 100);
        return energyPct >= minEnergy && energyPct <= maxEnergy;
      });
    }

    if (minValence > 0 || maxValence < 100) {
      fits = fits.filter(f => {
        if (f.track.valence === null || f.track.valence === undefined) return true;
        const valencePct = Math.round(f.track.valence * 100);
        return valencePct >= minValence && valencePct <= maxValence;
      });
    }

    if (minDance > 0 || maxDance < 100) {
      fits = fits.filter(f => {
        if (f.track.danceability === null || f.track.danceability === undefined) return true;
        const dancePct = Math.round(f.track.danceability * 100);
        return dancePct >= minDance && dancePct <= maxDance;
      });
    }

    if (minBpm > 50 || maxBpm < 220) {
      fits = fits.filter(f => {
        if (!f.track.bpm) return true;
        return f.track.bpm >= minBpm && f.track.bpm <= maxBpm;
      });
    }

    // 3. Sorting
    if (sortBy === 'vibe') {
      fits.sort((a, b) => b.similarity - a.similarity || b.score - a.score);
    } else {
      fits.sort((a, b) => b.score - a.score || b.similarity - a.similarity);
    }

    return fits.slice(0, maxSuggestions);
  }, [
    analysis?.allFits, 
    sortBy, 
    maxSuggestions, 
    dismissedFitTrackIds,
    minEnergy,
    maxEnergy,
    minValence,
    maxValence,
    minDance,
    maxDance,
    minBpm,
    maxBpm
  ]);

  // Hide / Dismiss fit suggestion for this session (never permanently cached)
  const handleDismissFit = (track) => {
    setDismissedFitTrackIds(prev => new Set(prev).add(track.id));
  };

  const handleUnhideAllFits = () => {
    setDismissedFitTrackIds(new Set());
  };

  // Toggle inline Spotify player on card
  const handleTogglePreview = (track) => {
    setActivePreviewTrackId(prev => prev === track.id ? null : track.id);
  };

  // 1-Click Direct Add to Target Playlist
  const handleDirectAdd = async (track) => {
    try {
      setActionInProgressId(track.id);
      await addTracksToPlaylist(targetPlaylist.id, [track.uri]);
      invalidatePlaylistCache(targetPlaylist.id);
      setAddedTrackIds(prev => new Set(prev).add(track.id));
    } catch (e) {
      alert(`Failed to add track: ${e.message}`);
    } finally {
      setActionInProgressId(null);
    }
  };

  // 1-Click Direct Remove from Target Playlist
  const handleDirectRemove = async (track) => {
    try {
      setActionInProgressId(track.id);
      await removeTracksFromPlaylist(targetPlaylist.id, [track.uri]);
      invalidatePlaylistCache(targetPlaylist.id);
      setRemovedTrackIds(prev => new Set(prev).add(track.id));
      setKeptTrackIds(prev => {
        const next = new Set(prev);
        next.delete(track.id);
        return next;
      });
    } catch (e) {
      alert(`Failed to remove track: ${e.message}`);
    } finally {
      setActionInProgressId(null);
    }
  };

  // Keep an Outlier in Playlist (Mark Approved)
  const handleKeepOutlier = (track) => {
    setKeptTrackIds(prev => new Set(prev).add(track.id));
    setRemovedTrackIds(prev => {
      const next = new Set(prev);
      next.delete(track.id);
      return next;
    });
  };

  // Batch Export Playlists
  const handleCommit = async () => {
    try {
      setCommitting(true);
      
      const unmanagedOutliers = analysis.outliers.filter(o => !removedTrackIds.has(o.track.id) && !keptTrackIds.has(o.track.id));
      const unaddedFits = displayedFits.filter(f => !addedTrackIds.has(f.track.id));

      const tracksToRemove = unmanagedOutliers.map(o => o.track.uri);
      const tracksToAdd = unaddedFits.map(f => f.track.uri);

      setStatus("Fetching user profile...");
      const user = await getCurrentUser();
      const userId = user.id;

      let msg = "";

      if (tracksToRemove.length > 0) {
        setStatus("Creating Outliers playlist...");
        const outPlaylist = await createPlaylist(userId, `${targetPlaylist.name} - Outliers`, `Songs flagged for removal from ${targetPlaylist.name} by Spotify Sorter.`);
        
        setStatus("Adding tracks to Outliers playlist...");
        for (let i = 0; i < tracksToRemove.length; i += 100) {
          await addTracksToPlaylist(outPlaylist.id, tracksToRemove.slice(i, i + 100));
        }
        msg += `Created "${targetPlaylist.name} - Outliers". `;
      }

      if (tracksToAdd.length > 0) {
        setStatus("Creating Fits playlist...");
        const fitPlaylist = await createPlaylist(userId, `${targetPlaylist.name} - Fits`, `Songs suggested for addition to ${targetPlaylist.name} by Spotify Sorter.`);
        
        setStatus("Adding tracks to Fits playlist...");
        for (let i = 0; i < tracksToAdd.length; i += 100) {
          await addTracksToPlaylist(fitPlaylist.id, tracksToAdd.slice(i, i + 100));
        }
        msg += `Created "${targetPlaylist.name} - Fits".`;
      }

      setCommitResult(msg || "No playlists were created because there were no unreviewed tracks.");
    } catch (err) {
      console.error(err);
      if (err.message?.includes('401')) {
        setError(`Failed to create playlists: Your Spotify session expired! Please click "Go Back", hit "Logout" at the top right, and log back in.`);
      } else {
        setError(`Failed to create playlists on Spotify: ${err.message}`);
      }
    } finally {
      setCommitting(false);
    }
  };

  function formatTime(ms) {
    if (!ms) return '0:00';
    const mins = Math.floor(ms / 60000);
    const secs = ((ms % 60000) / 1000).toFixed(0);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }

  if (loading || committing) {
    return (
      <div className="glass-panel animate-fade-in" style={{ textAlign: 'center', padding: '3.5rem 2rem', maxWidth: '700px', margin: '2rem auto' }}>
        <Disc3 size={48} color="var(--accent-green)" className="animate-spin" style={{ marginBottom: '1.5rem', animationDuration: '3s' }} />
        <h3 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>{committing ? "Creating Playlists on Spotify..." : "Analyzing Playlists"}</h3>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>{status}</p>
        
        <div style={{ width: '100%', height: '8px', backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: '4px', overflow: 'hidden', marginBottom: '1.5rem' }}>
          <div style={{
            width: `${progressPercent}%`,
            height: '100%',
            backgroundColor: 'var(--accent-green)',
            transition: 'width 0.4s ease'
          }}></div>
        </div>

        {progressMsg && (
          <p style={{ color: 'var(--accent-green)', fontWeight: 600, fontSize: '0.9rem', marginBottom: '1.5rem' }}>
            {progressMsg}
          </p>
        )}

        <button className="btn-secondary" onClick={onBack} style={{ marginTop: '0.5rem', fontSize: '0.85rem' }}>
          Cancel & Return to Dashboard
        </button>
      </div>
    );
  }

  if (error) {
    return (
      <div className="glass-panel animate-fade-in" style={{ padding: '2.5rem', textAlign: 'center', maxWidth: '600px', margin: '3rem auto' }}>
        <AlertCircle size={48} color="var(--accent-red)" style={{ marginBottom: '1rem' }} />
        <h3 style={{ color: 'var(--accent-red)', marginBottom: '0.75rem' }}>Analysis Stopped</h3>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem', fontSize: '0.95rem', lineHeight: '1.5' }}>{error}</p>
        <button className="btn-primary" onClick={onBack}>Back to Dashboard</button>
      </div>
    );
  }

  if (commitResult) {
    return (
      <div className="glass-panel" style={{ textAlign: 'center', padding: '3rem' }}>
        <Check size={64} color="var(--accent-green)" style={{ marginBottom: '1rem' }} />
        <h2>Playlists Created!</h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '2rem' }}>{commitResult}</p>
        <button className="btn-primary" onClick={onBack}>Back to Dashboard</button>
      </div>
    );
  }

  return (
    <div className="glass-panel animate-fade-in" style={{ paddingBottom: '2rem' }}>
      
      {/* Top Bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h2 style={{ fontSize: '1.8rem', marginBottom: '0.5rem' }}>Analysis: {targetPlaylist.name}</h2>
          <p style={{ color: 'var(--text-secondary)', margin: 0, fontSize: '0.95rem' }}>
            Core Artists: {analysis.vibeProfile.topArtistNames.join(', ') || 'Mixed'} • Era: ~{Math.round(analysis.vibeProfile.avgYear)} • Length: {formatTime(analysis.vibeProfile.avgDuration)}
            {analysis.vibeProfile.avgBPM && ` • Avg BPM: ${Math.round(analysis.vibeProfile.avgBPM)} (±${analysis.vibeProfile.bpmFlexibility})`}
            {analysis.vibeProfile.dominantKey && ` • Key: ${analysis.vibeProfile.dominantKey}`}
          </p>
        </div>
        
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <button 
            className="btn-secondary" 
            onClick={() => setShowLibraryModal(true)}
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', backgroundColor: 'rgba(0, 212, 255, 0.15)', borderColor: '#00d4ff' }}
          >
            <Database size={16} color="#00d4ff" />
            Acoustic Library & DB
          </button>
          <button className="btn-secondary" onClick={onBack}>Back to Dashboard</button>
        </div>
      </div>

      {/* Vibe Profile Badges */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1.5rem' }}>
        {analysis.vibeProfile.avgEnergy !== null && (
          <div style={{ padding: '0.4rem 0.8rem', borderRadius: '8px', backgroundColor: 'rgba(255, 149, 0, 0.15)', border: '1px solid rgba(255, 149, 0, 0.3)', color: '#ff9500', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <Flame size={14} />
            Energy: {Math.round(analysis.vibeProfile.avgEnergy * 100)}% ({analysis.vibeProfile.avgEnergy > 0.7 ? 'High Energy' : analysis.vibeProfile.avgEnergy > 0.45 ? 'Moderate' : 'Mellow'})
          </div>
        )}

        {analysis.vibeProfile.avgValence !== null && (
          <div style={{ padding: '0.4rem 0.8rem', borderRadius: '8px', backgroundColor: 'rgba(52, 199, 89, 0.15)', border: '1px solid rgba(52, 199, 89, 0.3)', color: '#34c759', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <Smile size={14} />
            Mood / Valence: {Math.round(analysis.vibeProfile.avgValence * 100)}% ({analysis.vibeProfile.avgValence > 0.6 ? 'Uplifting' : analysis.vibeProfile.avgValence > 0.4 ? 'Neutral' : 'Moody'})
          </div>
        )}

        {analysis.vibeProfile.avgDanceability !== null && (
          <div style={{ padding: '0.4rem 0.8rem', borderRadius: '8px', backgroundColor: 'rgba(175, 82, 222, 0.15)', border: '1px solid rgba(175, 82, 222, 0.3)', color: '#af52de', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <Zap size={14} />
            Danceability: {Math.round(analysis.vibeProfile.avgDanceability * 100)}%
          </div>
        )}
      </div>

      {/* Diagnostics / Stats Bar */}
      <div style={{ 
        display: 'flex', 
        flexWrap: 'wrap', 
        gap: '1rem', 
        padding: '0.75rem 1.2rem', 
        backgroundColor: 'rgba(255,255,255,0.03)', 
        borderRadius: '12px', 
        marginBottom: '1.5rem',
        border: '1px solid var(--glass-border)',
        fontSize: '0.85rem',
        color: 'var(--text-secondary)',
        alignItems: 'center'
      }}>
        <span><strong style={{ color: '#fff' }}>Acoustic Engine:</strong></span>
        <span>💾 {analysis.lookupStats?.cached || 0} IndexedDB Cache (0ms)</span>
        <span>⚡ {analysis.lookupStats?.musicae || 0} Musicae.io API</span>
        {analysis.lookupStats?.missing > 0 && <span style={{ color: 'var(--accent-red)' }}>⚠️ {analysis.lookupStats.missing} Unresolved</span>}
      </div>

      {/* Rate limit notification */}
      {analysis.rateLimitHit && (
        <div className="glass-panel animate-fade-in" style={{ marginBottom: '2rem', padding: '1.2rem 1.5rem', border: '1px solid var(--accent-red)', backgroundColor: 'rgba(255, 59, 48, 0.08)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <h4 style={{ color: 'var(--accent-red)', margin: '0 0 0.4rem 0', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <AlertCircle size={18} /> Musicae API Quota Limit Reached
            </h4>
            <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
              Your RapidAPI plan daily/monthly quota for Musicae was reached. Any cached songs in your local IndexedDB database will continue to sort instantly!
            </p>
          </div>
          <button className="btn-secondary" onClick={onBack} style={{ borderColor: 'var(--accent-red)', color: '#fff' }}>
            Back to Dashboard
          </button>
        </div>
      )}

      {/* Outliers and Fits Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '2rem', marginBottom: '2rem' }}>
        
        {/* Outliers Section */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h3 style={{ color: 'var(--accent-red)', margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '1.2rem' }}>
              <X size={20} /> Outliers to Remove ({analysis.outliers.length})
            </h3>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxHeight: '560px', overflowY: 'auto', paddingRight: '0.5rem' }}>
            {analysis.outliers.map(o => {
              const isRemoved = removedTrackIds.has(o.track.id);
              const isKept = keptTrackIds.has(o.track.id);
              const isPlaying = activePreviewTrackId === o.track.id;

              return (
                <div 
                  key={o.track.id} 
                  className="track-card" 
                  style={{ 
                    padding: '0.85rem 1rem', 
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.6rem',
                    opacity: isRemoved ? 0.45 : isKept ? 0.85 : 1,
                    borderColor: isPlaying ? '#00d4ff' : isKept ? 'rgba(52, 199, 89, 0.4)' : undefined,
                    backgroundColor: isKept ? 'rgba(52, 199, 89, 0.05)' : undefined
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ overflow: 'hidden', flex: 1, marginRight: '0.5rem' }}>
                      <p style={{ margin: 0, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.track.name}</p>
                      <p style={{ margin: '0.2rem 0 0 0', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                        {o.track.artists?.[0]?.name} • {o.year} • {formatTime(o.duration)}
                        {o.track.bpm && ` • ${Math.round(o.track.bpm)} BPM`}
                        {o.track.camelot && ` • ${o.track.camelot}`}
                      </p>
                      {/* Outlier Reasons */}
                      {o.outlierReasons?.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginTop: '0.3rem' }}>
                          {o.outlierReasons.map((r, rIdx) => (
                            <span key={rIdx} style={{ fontSize: '0.7rem', padding: '1px 5px', borderRadius: '4px', backgroundColor: 'rgba(231, 76, 60, 0.15)', color: 'var(--accent-red)', border: '1px solid rgba(231, 76, 60, 0.3)' }}>
                              {r}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexShrink: 0 }}>
                      <button 
                        onClick={() => handleTogglePreview(o.track)}
                        style={{ background: isPlaying ? '#00d4ff' : 'rgba(255,255,255,0.08)', border: 'none', color: isPlaying ? '#000' : '#fff', padding: '6px', borderRadius: '50%', cursor: 'pointer' }}
                        title={isPlaying ? "Hide Preview Player" : "Preview Song"}
                      >
                        {isPlaying ? <Pause size={13} fill="#000" /> : <Play size={13} fill="currentColor" />}
                      </button>

                      {isRemoved ? (
                        <span style={{ fontSize: '0.75rem', color: 'var(--accent-red)', fontWeight: 'bold', padding: '3px 6px' }}>
                          Removed
                        </span>
                      ) : isKept ? (
                        <span style={{ fontSize: '0.75rem', color: 'var(--accent-green)', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.2rem', padding: '3px 6px' }}>
                          <ShieldCheck size={14} /> Kept
                        </span>
                      ) : (
                        <div style={{ display: 'flex', gap: '0.3rem' }}>
                          <button 
                            onClick={() => handleKeepOutlier(o.track)}
                            className="btn-secondary"
                            style={{ padding: '0.3rem 0.55rem', fontSize: '0.75rem', borderColor: 'rgba(52, 199, 89, 0.4)', color: 'var(--accent-green)' }}
                            title="Keep this song in the playlist (do not remove)"
                          >
                            Keep
                          </button>
                          <button 
                            onClick={() => handleDirectRemove(o.track)}
                            disabled={actionInProgressId === o.track.id}
                            className="btn-secondary"
                            style={{ padding: '0.3rem 0.55rem', fontSize: '0.75rem', borderColor: 'var(--accent-red)', color: 'var(--accent-red)' }}
                            title="Remove directly from this Spotify playlist"
                          >
                            {actionInProgressId === o.track.id ? '...' : 'Remove'}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Inline Spotify Player Embed */}
                  {isPlaying && (
                    <div style={{ marginTop: '0.3rem', borderRadius: '10px', overflow: 'hidden', backgroundColor: '#000' }}>
                      <iframe 
                        src={`https://open.spotify.com/embed/track/${o.track.id}?utm_source=generator&theme=0`} 
                        width="100%" 
                        height="80" 
                        frameBorder="0" 
                        allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" 
                        loading="lazy"
                        style={{ borderRadius: '8px' }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
            {analysis.outliers.length === 0 && <p style={{ color: 'var(--text-secondary)', fontStyle: 'italic' }}>No outliers found! Your playlist has great cohesion.</p>}
          </div>
        </div>

        {/* Fits Section */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem', flexWrap: 'wrap', gap: '0.5rem' }}>
            <h3 style={{ color: 'var(--accent-green)', margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '1.2rem' }}>
              <Check size={20} /> Suggested Fits ({displayedFits.length})
            </h3>
            
            {/* Sorting & Match Strictness Controls */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '0.75rem', color: 'var(--text-secondary)', flexWrap: 'wrap' }}>
              {dismissedFitTrackIds.size > 0 && (
                <button
                  onClick={handleUnhideAllFits}
                  style={{
                    background: 'rgba(0, 212, 255, 0.1)',
                    border: '1px solid rgba(0, 212, 255, 0.3)',
                    color: '#00d4ff',
                    padding: '2px 7px',
                    borderRadius: '6px',
                    fontSize: '0.72rem',
                    cursor: 'pointer'
                  }}
                  title="Restore hidden suggestions for this session"
                >
                  Unhide ({dismissedFitTrackIds.size})
                </button>
              )}

              {/* Filters Drawer Toggle Button */}
              <button
                onClick={() => setShowFilterDrawer(prev => !prev)}
                style={{
                  background: activeFilterCount > 0 ? 'rgba(0, 212, 255, 0.15)' : showFilterDrawer ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.08)',
                  border: `1px solid ${activeFilterCount > 0 ? '#00d4ff' : 'rgba(255, 255, 255, 0.15)'}`,
                  color: activeFilterCount > 0 ? '#00d4ff' : '#fff',
                  padding: '2px 8px',
                  borderRadius: '6px',
                  fontSize: '0.75rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.3rem',
                  cursor: 'pointer'
                }}
                title="Open sliding acoustic filters"
              >
                <Filter size={12} />
                <span>Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}</span>
              </button>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <Sliders size={13} />
                <span>Sort:</span>
                <select 
                  value={sortBy} 
                  onChange={e => setSortBy(e.target.value)}
                  style={{
                    background: 'rgba(255, 255, 255, 0.08)',
                    border: '1px solid rgba(255, 255, 255, 0.15)',
                    color: '#fff',
                    padding: '2px 6px',
                    borderRadius: '6px',
                    fontSize: '0.75rem',
                    cursor: 'pointer',
                    outline: 'none'
                  }}
                >
                  <option value="vibe" style={{ background: '#181820', color: '#fff' }}>Highest Vibe %</option>
                  <option value="composite" style={{ background: '#181820', color: '#fff' }}>Smart Weighted</option>
                </select>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <span>Pool: {maxSuggestions}</span>
                <input 
                  type="range" 
                  min="10" 
                  max="60" 
                  step="5" 
                  value={maxSuggestions} 
                  onChange={e => setMaxSuggestions(parseInt(e.target.value, 10))}
                  style={{ width: '60px', accentColor: 'var(--accent-green)', cursor: 'pointer' }}
                  title="Adjust number of candidate suggestions"
                />
              </div>
            </div>
          </div>

          {/* Sliding Filters Panel Drawer */}
          {showFilterDrawer && (
            <div style={{
              background: 'rgba(255, 255, 255, 0.04)',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              borderRadius: '10px',
              padding: '0.85rem 1rem',
              marginBottom: '0.75rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.85rem',
              fontSize: '0.75rem'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 600, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                  <Filter size={13} color="#00d4ff" /> Acoustic Range Filters
                </span>
                {activeFilterCount > 0 && (
                  <button
                    onClick={handleResetFilters}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#00d4ff',
                      fontSize: '0.72rem',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.25rem',
                      padding: '2px 4px'
                    }}
                  >
                    <RotateCcw size={11} /> Reset Filters
                  </button>
                )}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '1rem' }}>
                {/* Double-Ended Energy Filter */}
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.35rem', color: 'var(--text-secondary)' }}>
                    <span>⚡ Energy</span>
                    <span style={{ color: (minEnergy > 0 || maxEnergy < 100) ? '#ff9500' : '#fff', fontWeight: 600 }}>
                      {minEnergy === 0 && maxEnergy === 100 ? '0% – 100% (All)' : `${minEnergy}% – ${maxEnergy}%`}
                    </span>
                  </div>
                  <DualRangeSlider
                    min={0}
                    max={100}
                    step={5}
                    minValue={minEnergy}
                    maxValue={maxEnergy}
                    onChange={(min, max) => {
                      setMinEnergy(min);
                      setMaxEnergy(max);
                    }}
                    color="#ff9500"
                  />
                </div>

                {/* Double-Ended Mood / Valence Filter */}
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.35rem', color: 'var(--text-secondary)' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>🌊 Mood / Valence</span>
                    <span style={{ color: (minValence > 0 || maxValence < 100) ? '#00d4ff' : '#fff', fontWeight: 600 }}>
                      {minValence === 0 && maxValence === 100 ? '0% – 100% (All)' : `${minValence}% – ${maxValence}%`}
                    </span>
                  </div>
                  <DualRangeSlider
                    min={0}
                    max={100}
                    step={5}
                    minValue={minValence}
                    maxValue={maxValence}
                    onChange={(min, max) => {
                      setMinValence(min);
                      setMaxValence(max);
                    }}
                    color="#00d4ff"
                  />
                </div>

                {/* Double-Ended Danceability Filter */}
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.35rem', color: 'var(--text-secondary)' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>💃 Danceability</span>
                    <span style={{ color: (minDance > 0 || maxDance < 100) ? '#f43f5e' : '#fff', fontWeight: 600 }}>
                      {minDance === 0 && maxDance === 100 ? '0% – 100% (All)' : `${minDance}% – ${maxDance}%`}
                    </span>
                  </div>
                  <DualRangeSlider
                    min={0}
                    max={100}
                    step={5}
                    minValue={minDance}
                    maxValue={maxDance}
                    onChange={(min, max) => {
                      setMinDance(min);
                      setMaxDance(max);
                    }}
                    color="#f43f5e"
                  />
                </div>

                {/* Double-Ended BPM / Tempo Filter */}
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.35rem', color: 'var(--text-secondary)' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>🎵 Tempo / BPM</span>
                    <span style={{ color: (minBpm > 50 || maxBpm < 220) ? '#a78bfa' : '#fff', fontWeight: 600 }}>
                      {minBpm === 50 && maxBpm === 220 ? '50 – 220 BPM (All)' : `${minBpm} – ${maxBpm} BPM`}
                    </span>
                  </div>
                  <DualRangeSlider
                    min={50}
                    max={220}
                    step={5}
                    minValue={minBpm}
                    maxValue={maxBpm}
                    onChange={(min, max) => {
                      setMinBpm(min);
                      setMaxBpm(max);
                    }}
                    color="#a78bfa"
                  />
                </div>
              </div>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxHeight: '560px', overflowY: 'auto', paddingRight: '0.5rem' }}>
            {displayedFits.map(f => {
              const isAdded = addedTrackIds.has(f.track.id);
              const isPlaying = activePreviewTrackId === f.track.id;

              return (
                <div 
                  key={f.track.id} 
                  className="track-card" 
                  style={{ 
                    padding: '0.85rem 1rem', 
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.6rem',
                    borderColor: isPlaying ? '#00d4ff' : isAdded ? 'rgba(29, 185, 84, 0.4)' : undefined,
                    backgroundColor: isAdded ? 'rgba(29, 185, 84, 0.05)' : undefined
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ overflow: 'hidden', flex: 1, marginRight: '0.5rem' }}>
                      <p style={{ margin: 0, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.track.name}</p>
                      <p style={{ margin: '0.2rem 0 0 0', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                        {f.track.artists?.[0]?.name} • {f.year} • {formatTime(f.duration)}
                        {f.track.bpm && ` • ${Math.round(f.track.bpm)} BPM`}
                        {f.track.camelot && ` • ${f.track.camelot}`}
                      </p>

                      {/* Reasoning Breakdown Badges */}
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginTop: '0.35rem' }}>
                        {f.badges.map((b, bIdx) => (
                          <span key={bIdx} style={{ 
                            fontSize: '0.7rem', 
                            padding: '1px 6px', 
                            borderRadius: '4px', 
                            backgroundColor: 'rgba(255,255,255,0.06)', 
                            color: b.color || '#fff', 
                            border: `1px solid ${b.color ? b.color + '44' : 'var(--glass-border)'}` 
                          }}>
                            {b.label}
                          </span>
                        ))}
                      </div>
                    </div>

                    {/* Actions */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexShrink: 0 }}>
                      <button 
                        onClick={() => handleTogglePreview(f.track)}
                        style={{ background: isPlaying ? '#00d4ff' : 'rgba(255,255,255,0.08)', border: 'none', color: isPlaying ? '#000' : '#fff', padding: '6px', borderRadius: '50%', cursor: 'pointer' }}
                        title={isPlaying ? "Hide Preview Player" : "Preview Song"}
                      >
                        {isPlaying ? <Pause size={13} fill="#000" /> : <Play size={13} fill="currentColor" />}
                      </button>

                      {isAdded ? (
                        <span style={{ fontSize: '0.75rem', color: 'var(--accent-green)', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.2rem', padding: '4px 8px' }}>
                          <Check size={14} /> Added
                        </span>
                      ) : (
                        <button 
                          onClick={() => handleDirectAdd(f.track)}
                          disabled={actionInProgressId === f.track.id}
                          className="btn-primary"
                          style={{ padding: '0.35rem 0.75rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.2rem' }}
                          title="Add directly to your target playlist"
                        >
                          <Plus size={13} />
                          {actionInProgressId === f.track.id ? '...' : 'Add'}
                        </button>
                      )}

                      <button 
                        onClick={() => handleDismissFit(f.track)}
                        style={{ 
                          background: 'rgba(255,255,255,0.05)', 
                          border: 'none', 
                          color: 'var(--text-secondary)', 
                          padding: '6px', 
                          borderRadius: '50%', 
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center'
                        }}
                        title="Hide song from suggestions (this session only)"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  </div>

                  {/* Inline Spotify Player Embed */}
                  {isPlaying && (
                    <div style={{ marginTop: '0.3rem', borderRadius: '10px', overflow: 'hidden', backgroundColor: '#000' }}>
                      <iframe 
                        src={`https://open.spotify.com/embed/track/${f.track.id}?utm_source=generator&theme=0`} 
                        width="100%" 
                        height="80" 
                        frameBorder="0" 
                        allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" 
                        loading="lazy"
                        style={{ borderRadius: '8px' }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
            {displayedFits.length === 0 && <p style={{ color: 'var(--text-secondary)', fontStyle: 'italic' }}>No matching suggestions found in your master pools.</p>}
          </div>
        </div>
      </div>

      {/* Literal Duplicate Songs Alert */}
      {analysis.duplicateSets && analysis.duplicateSets.length > 0 && (
        <div className="glass-panel" style={{ marginTop: '1.5rem', padding: '1.2rem', border: '1px solid rgba(231, 76, 60, 0.4)', backgroundColor: 'rgba(231, 76, 60, 0.05)' }}>
          <h4 style={{ color: 'var(--accent-red)', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <AlertCircle size={18} /> Duplicate Songs Detected ({analysis.duplicateSets.length} {analysis.duplicateSets.length === 1 ? 'song has' : 'songs have'} multiple copies)
          </h4>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '1rem' }}>
            The following songs appear multiple times in this playlist (e.g. having both Single and Album releases). We recommend removing redundant copies on Spotify:
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '0.75rem', maxHeight: '180px', overflowY: 'auto' }}>
            {analysis.duplicateSets.map((set, idx) => (
              <div key={`dup-set-${idx}`} style={{ padding: '0.6rem 0.8rem', backgroundColor: 'rgba(0, 0, 0, 0.35)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.06)' }}>
                <p style={{ margin: 0, fontWeight: 'bold', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {set.name}
                </p>
                <p style={{ margin: '0.2rem 0 0.4rem 0', fontSize: '0.75rem', color: 'var(--accent-green)' }}>
                  {set.artist} • <span style={{ color: 'var(--accent-red)' }}>{set.count} copies found</span>
                </p>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  {set.tracks.map((t, tIdx) => (
                    <div key={`dup-ver-${t.id || tIdx}`} style={{ display: 'flex', justifyContent: 'space-between', opacity: 0.85 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '180px' }}>
                        • {t.album?.name || 'Single/Album Release'}
                      </span>
                      <span>{formatTime(t.duration_ms)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Batch Export Footer */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: '2rem', paddingTop: '1.5rem', borderTop: '1px solid var(--glass-border)' }}>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.8rem' }}>
          Prefer separate playlists? You can still export all unreviewed suggestions to Spotify at once:
        </p>
        <button 
          className="btn-secondary" 
          style={{ fontSize: '0.95rem', padding: '0.7rem 1.8rem' }}
          onClick={handleCommit}
          disabled={analysis.outliers.length === 0 && displayedFits.length === 0}
        >
          <Disc3 size={18} style={{ marginRight: '0.5rem' }} />
          Export Separate "Fits" & "Outliers" Playlists
        </button>
      </div>

      {/* Acoustic Library & Database Manager Modal */}
      <LibraryManagerModal 
        isOpen={showLibraryModal} 
        onClose={() => {
          setShowLibraryModal(false);
          performAnalysis();
        }} 
      />
    </div>
  );
}
