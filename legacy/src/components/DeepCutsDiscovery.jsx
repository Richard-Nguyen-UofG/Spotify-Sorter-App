import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { 
  getPlaylistTracks, 
  getArtistTopTracks, 
  createPlaylist, 
  addTracksToPlaylist, 
  getCurrentUser 
} from '../lib/spotifyAPI';
import { 
  buildPoolLookupSets, 
  findUnderRepresentedArtists, 
  filterUnheardArtistTracks 
} from '../lib/musicMath';
import { 
  Sparkles, 
  Check, 
  X, 
  Search, 
  SlidersHorizontal, 
  Volume2, 
  VolumeX, 
  RefreshCw, 
  CheckCircle2, 
  AlertTriangle, 
  Compass, 
  Ban, 
  ListMusic, 
  ExternalLink, 
  Plus, 
  Music, 
  Trash2, 
  Layers, 
  Flame,
  Square,
  Shuffle,
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
  Play
} from 'lucide-react';

const EXCLUDED_ARTISTS_STORAGE_KEY = 'spotify_sorter_excluded_artists';
const POOL_STORAGE_KEY = 'spotify_sorter_discovery_pool_ids';

export default function DeepCutsDiscovery({ playlists = [], masterPools = [] }) {
  // Pool playlists selection (persisted in localStorage)
  const [selectedPoolIds, setSelectedPoolIds] = useState(() => {
    try {
      const saved = localStorage.getItem(POOL_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return new Set(parsed);
      }
    } catch {}
    if (masterPools.length > 0) return new Set(masterPools.map(p => p.id));
    return new Set(playlists.map(p => p.id));
  });

  // Threshold setting: Artists with <= maxThreshold songs in pool (1, 2, 3, 5)
  const [maxThreshold, setMaxThreshold] = useState(3);
  // Songs per artist to pull (1, 2, or 3)
  const [songsPerArtist, setSongsPerArtist] = useState(2);
  // Max artists to scan per run (to avoid Spotify rate limits and huge playlists)
  const [batchLimit, setBatchLimit] = useState(35);
  // Shuffle order so each run selects an eclectic mix of under-represented artists
  const [shuffleOrder, setShuffleOrder] = useState(true);

  // Blacklist / Excluded Artists state { [artistIdOrName]: { id, name, addedAt } }
  const [excludedArtists, setExcludedArtists] = useState(() => {
    try {
      const saved = localStorage.getItem(EXCLUDED_ARTISTS_STORAGE_KEY);
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  // Discovery engine state
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState({ current: 0, total: 0, artistName: '', tracksFound: 0, stage: '' });
  const [abortRequested, setAbortRequested] = useState(false);
  const abortRef = useRef(false);
  const [rateLimitWarning, setRateLimitWarning] = useState(null);

  // Discovered artists & tracks: Array of { artist: { id, name, count, sampleTracks }, tracks: [...] }
  const [discoveredResults, setDiscoveredResults] = useState([]);
  const [hasScanned, setHasScanned] = useState(false);
  const [lastScannedCandidatesCount, setLastScannedCandidatesCount] = useState(0);

  // Track selection state for export: Set of track IDs that are checked
  const [selectedTrackIds, setSelectedTrackIds] = useState(new Set());

  // Spotlight Artist Discovery State
  const [spotlightInput, setSpotlightInput] = useState('');
  const [isSpotlightScanning, setIsSpotlightScanning] = useState(false);
  const [spotlightStatus, setSpotlightStatus] = useState(null);

  // Eligible Candidates Drawer State
  const [showCandidatesDrawer, setShowCandidatesDrawer] = useState(false);
  const [candidatesSearch, setCandidatesSearch] = useState('');
  const [eligibleCandidatesList, setEligibleCandidatesList] = useState([]);

  // Pool Cache Ref
  const cachedPoolRef = useRef({
    poolKey: '',
    tracks: [],
    lookups: null,
    candidates: []
  });

  // UI state
  const [showPoolDrawer, setShowPoolDrawer] = useState(false);
  const [showBlacklistDrawer, setShowBlacklistDrawer] = useState(false);
  const [blacklistSearch, setBlacklistSearch] = useState('');
  const [manualExcludeInput, setManualExcludeInput] = useState('');
  const [resultsFilter, setResultsFilter] = useState('');
  const [activePreviewTrackId, setActivePreviewTrackId] = useState(null);

  // Flipper View Mode & Sticky Player States (SongMatcher-style workflow)
  const [viewMode, setViewMode] = useState('flipper'); // 'flipper' | 'list'
  const [activeArtistIndex, setActiveArtistIndex] = useState(0);
  const [activeStickyPlayerTrack, setActiveStickyPlayerTrack] = useState(null);
  const [showStickyPlayer, setShowStickyPlayer] = useState(true);
  const [stickyPlayerHeight, setStickyPlayerHeight] = useState(80); // 80 (compact) or 152 (expanded with full-width scrubber)
  const [selectedLibraryTrackIndex, setSelectedLibraryTrackIndex] = useState(0);

  // Auto-sync selectedPoolIds when playlists load
  useEffect(() => {
    if (selectedPoolIds.size === 0 && playlists && playlists.length > 0) {
      const defaultSet = masterPools && masterPools.length > 0 
        ? new Set(masterPools.map(p => p.id))
        : new Set(playlists.map(p => p.id));
      setSelectedPoolIds(defaultSet);
      try {
        localStorage.setItem(POOL_STORAGE_KEY, JSON.stringify(Array.from(defaultSet)));
      } catch {}
    }
  }, [playlists, masterPools, selectedPoolIds.size]);

  // Playlist Export state
  const [playlistTitle, setPlaylistTitle] = useState('Deep Cuts: Rediscover');
  const [playlistDesc, setPlaylistDesc] = useState('Hidden gems and unheard top tracks from under-represented artists in my library.');
  const [isExporting, setIsExporting] = useState(false);
  const [exportSuccess, setExportSuccess] = useState(null);
  const [exportError, setExportError] = useState(null);

  // Save excluded artists to localStorage
  const persistExcluded = useCallback((updated) => {
    setExcludedArtists(updated);
    try {
      localStorage.setItem(EXCLUDED_ARTISTS_STORAGE_KEY, JSON.stringify(updated));
    } catch (e) {
      console.warn('Failed to save excluded artists to localStorage', e);
    }
  }, []);

  // Save selected pool IDs to localStorage
  const updatePoolSelection = useCallback((newSet) => {
    setSelectedPoolIds(newSet);
    try {
      localStorage.setItem(POOL_STORAGE_KEY, JSON.stringify(Array.from(newSet)));
    } catch {}
  }, []);

  // Exclude an artist directly
  const excludeArtist = useCallback((artistId, artistName) => {
    if (!artistName) return;
    const key = artistId ? `id_${artistId}` : `name_${artistName.toLowerCase()}`;
    const updated = {
      ...excludedArtists,
      [key]: {
        id: artistId || null,
        name: artistName,
        addedAt: Date.now()
      }
    };
    persistExcluded(updated);

    // Remove them from current discovered results if present
    setDiscoveredResults(prev => prev.filter(item => {
      if (artistId && item.artist.id === artistId) return false;
      if (item.artist.name.toLowerCase() === artistName.toLowerCase()) return false;
      return true;
    }));
  }, [excludedArtists, persistExcluded]);

  // Remove artist from blacklist
  const unexcludeArtist = useCallback((key) => {
    const updated = { ...excludedArtists };
    delete updated[key];
    persistExcluded(updated);
  }, [excludedArtists, persistExcluded]);

  // Handle manual artist exclusion
  const handleManualExclude = (e) => {
    e.preventDefault();
    if (!manualExcludeInput.trim()) return;
    excludeArtist(null, manualExcludeInput.trim());
    setManualExcludeInput('');
  };

  // Toggle pool playlist selection
  const togglePoolPlaylist = (playlistId) => {
    const next = new Set(selectedPoolIds);
    if (next.has(playlistId)) {
      next.delete(playlistId);
    } else {
      next.add(playlistId);
    }
    updatePoolSelection(next);
  };

  const selectAllPool = () => {
    updatePoolSelection(new Set(playlists.map(p => p.id)));
  };

  const clearPool = () => {
    updatePoolSelection(new Set());
  };

  const useMasterPoolsForDiscovery = () => {
    if (masterPools.length > 0) {
      updatePoolSelection(new Set(masterPools.map(p => p.id)));
    }
  };

  const handleStopScan = useCallback(() => {
    abortRef.current = true;
    setAbortRequested(true);
  }, []);

  // Helper to load and cache pool tracks, lookup sets, and under-represented candidates
  const getOrLoadPoolData = useCallback(async (onProgressCallback) => {
    let effectivePoolIds = selectedPoolIds;
    if (!effectivePoolIds || effectivePoolIds.size === 0) {
      effectivePoolIds = masterPools && masterPools.length > 0 
        ? new Set(masterPools.map(p => p.id))
        : new Set(playlists.map(p => p.id));
      setSelectedPoolIds(effectivePoolIds);
    }

    let poolPlaylists = playlists.filter(p => effectivePoolIds.has(p.id));
    if (poolPlaylists.length === 0 && playlists.length > 0) {
      poolPlaylists = playlists;
      effectivePoolIds = new Set(playlists.map(p => p.id));
      setSelectedPoolIds(effectivePoolIds);
    }

    if (poolPlaylists.length === 0) {
      throw new Error('Please select at least one playlist in your Library Baseline Pool.');
    }

    const excludedKeys = Object.keys(excludedArtists).sort().join(',');
    const currentPoolKey = `${Array.from(effectivePoolIds).sort().join(',')}_th${maxThreshold}_ex${excludedKeys}`;

    if (cachedPoolRef.current.poolKey === currentPoolKey && cachedPoolRef.current.tracks.length > 0) {
      return cachedPoolRef.current;
    }

    let allPoolTracks = [];
    let playlistIndex = 0;

    for (const pl of poolPlaylists) {
      playlistIndex++;
      if (onProgressCallback) {
        onProgressCallback({
          current: playlistIndex,
          total: poolPlaylists.length,
          stage: `Loading library tracks from "${pl.name}" (${playlistIndex}/${poolPlaylists.length})...`,
          tracksFound: allPoolTracks.length
        });
      }

      const raw = await getPlaylistTracks(pl.id);
      const valid = (raw || [])
        .filter(t => t && !t.is_local && (t.item || t.track || t.id || t.name))
        .map(t => t.item || t.track || t);

      allPoolTracks = allPoolTracks.concat(valid);
    }

    const poolLookups = buildPoolLookupSets(allPoolTracks);

    const excludedSet = new Set();
    Object.entries(excludedArtists).forEach(([key, val]) => {
      excludedSet.add(key);
      if (val.id) excludedSet.add(val.id);
      if (val.name) excludedSet.add(val.name.toLowerCase());
    });

    const candidates = findUnderRepresentedArtists(allPoolTracks, maxThreshold, excludedSet);

    const result = {
      poolKey: currentPoolKey,
      tracks: allPoolTracks,
      lookups: poolLookups,
      candidates
    };

    cachedPoolRef.current = result;
    setEligibleCandidatesList(candidates);
    return result;
  }, [selectedPoolIds, masterPools, playlists, maxThreshold, excludedArtists]);

  // Pre-index pool data in the background so candidates and spotlight searches are instant
  useEffect(() => {
    if (playlists.length > 0 && selectedPoolIds.size > 0) {
      getOrLoadPoolData().catch(() => {});
    }
  }, [playlists.length, selectedPoolIds.size, maxThreshold, excludedArtists, getOrLoadPoolData]);

  // Targeted Single Artist Spotlight Scan
  const handleSpotlightScan = async (query) => {
    const artistName = (query || spotlightInput || '').trim();
    if (!artistName) return;

    setIsSpotlightScanning(true);
    setSpotlightStatus(null);

    try {
      setSpotlightStatus({
        type: 'info',
        text: `Checking library baseline for "${artistName}"...`
      });

      const poolData = await getOrLoadPoolData();

      // Blacklist check
      const isExcluded = Object.values(excludedArtists).some(ex => 
        (ex.name && ex.name.toLowerCase() === artistName.toLowerCase()) ||
        (ex.id && ex.id === artistName)
      );
      if (isExcluded) {
        setSpotlightStatus({
          type: 'warning',
          text: `"${artistName}" is currently in your Excluded Artists blacklist. Remove them from the blacklist to scan.`
        });
        setIsSpotlightScanning(false);
        return;
      }

      // Check how many songs the artist has in pool
      const candMatch = poolData.candidates.find(c => c.name.toLowerCase() === artistName.toLowerCase());
      
      let artistEntry = candMatch;
      if (!artistEntry) {
        const poolMatches = poolData.tracks.filter(t => {
          if (t.artists && Array.isArray(t.artists)) {
            return t.artists.some(a => (a.name || '').toLowerCase() === artistName.toLowerCase());
          }
          if (typeof t.artist === 'string') {
            return t.artist.toLowerCase().includes(artistName.toLowerCase());
          }
          return false;
        });
        artistEntry = {
          key: `name_${artistName.toLowerCase()}`,
          id: null,
          name: artistName,
          count: poolMatches.length,
          sampleTracks: poolMatches.slice(0, 3)
        };
      }

      setSpotlightStatus({
        type: 'info',
        text: `Scanning Spotify top tracks for "${artistName}" (${artistEntry.count} track${artistEntry.count === 1 ? '' : 's'} in your library)...`
      });

      const topTracks = await getArtistTopTracks(artistEntry.id, artistName);
      if (!topTracks || topTracks.length === 0) {
        setSpotlightStatus({
          type: 'warning',
          text: `Could not find any tracks for "${artistName}" on Spotify.`
        });
        setIsSpotlightScanning(false);
        return;
      }

      const unheard = filterUnheardArtistTracks(
        topTracks,
        poolData.lookups.ids,
        poolData.lookups.isrcs,
        poolData.lookups.normKeys
      );

      if (unheard.length === 0) {
        const sampleName = artistEntry.sampleTracks?.[0]?.name;
        setSpotlightStatus({
          type: 'info',
          text: `All ${topTracks.length} top tracks from "${artistName}" are already in your library${sampleName ? ` (including "${sampleName}")` : ''}.`
        });
        setIsSpotlightScanning(false);
        return;
      }

      const pickedTracks = unheard.slice(0, Math.max(3, songsPerArtist));

      // Prepend to discovered results
      setDiscoveredResults(prev => {
        const remaining = prev.filter(g => g.artist.name.toLowerCase() !== artistName.toLowerCase());
        return [{
          artist: artistEntry,
          tracks: pickedTracks
        }, ...remaining];
      });

      // Auto-select discovered tracks
      setSelectedTrackIds(prev => {
        const next = new Set(prev);
        pickedTracks.forEach(t => next.add(t.id));
        return next;
      });

      setHasScanned(true);
      setSpotlightStatus({
        type: 'success',
        text: `✨ Found ${pickedTracks.length} unheard tracks for "${artistName}"! (Library track count: ${artistEntry.count}). Added to discovered list below.`
      });
      setSpotlightInput('');
    } catch (err) {
      console.error('Spotlight scan error:', err);
      setSpotlightStatus({
        type: 'error',
        text: `Scan error: ${err.message}`
      });
    } finally {
      setIsSpotlightScanning(false);
    }
  };

  // Run the Discovery Engine
  const runDiscovery = async () => {
    setIsScanning(true);
    abortRef.current = false;
    setAbortRequested(false);
    setRateLimitWarning(null);
    setExportSuccess(null);
    setExportError(null);
    setDiscoveredResults([]);

    try {
      setScanProgress({
        current: 0,
        total: 1,
        artistName: '',
        tracksFound: 0,
        stage: 'Indexing library baseline and finding under-represented artists...'
      });

      const poolData = await getOrLoadPoolData((prog) => {
        setScanProgress({
          current: prog.current,
          total: prog.total,
          artistName: '',
          tracksFound: prog.tracksFound,
          stage: prog.stage
        });
      });

      let candidates = [...poolData.candidates];
      setLastScannedCandidatesCount(candidates.length);
      console.log(`[DeepCuts] Identified ${candidates.length} under-represented artists (count <= ${maxThreshold}).`);

      if (candidates.length === 0) {
        setIsScanning(false);
        setHasScanned(true);
        setDiscoveredResults([]);
        return;
      }

      // Shuffle candidate artists if enabled (gives an eclectic, fresh variety every run)
      if (shuffleOrder) {
        for (let i = candidates.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
        }
      }

      // Limit batch size to protect against rate limits and provide manageable discovery batches
      if (batchLimit && batchLimit > 0 && candidates.length > batchLimit) {
        candidates = candidates.slice(0, batchLimit);
      }

      // Step 4: Scan top tracks from Spotify for each candidate artist
      const results = [];
      let totalDiscoveredTracks = 0;
      const initialCheckedTrackIds = new Set();

      for (let i = 0; i < candidates.length; i++) {
        if (abortRef.current) break;

        const candidate = candidates[i];
        setScanProgress({
          current: i + 1,
          total: candidates.length,
          artistName: candidate.name,
          tracksFound: totalDiscoveredTracks,
          stage: `Scanning unheard tracks for ${candidate.name} (${i + 1}/${candidates.length})...`
        });

        try {
          const topTracks = await getArtistTopTracks(candidate.id, candidate.name);
          const unheard = filterUnheardArtistTracks(
            topTracks,
            poolData.lookups.ids,
            poolData.lookups.isrcs,
            poolData.lookups.normKeys
          );

          console.log(`[DeepCuts] "${candidate.name}" (${candidate.count} in pool): ${topTracks.length} top tracks from Spotify, ${unheard.length} unheard.`);

          if (unheard.length > 0) {
            const pickedTracks = unheard.slice(0, songsPerArtist);
            pickedTracks.forEach(t => initialCheckedTrackIds.add(t.id));
            totalDiscoveredTracks += pickedTracks.length;

            results.push({
              artist: candidate,
              tracks: pickedTracks
            });
          }
        } catch (err) {
          if (err.message?.includes('429') || err.message?.includes('Rate Limited')) {
            console.warn('Spotify rate limit reached during discovery:', err);
            setRateLimitWarning(`Spotify API rate limit reached after checking ${i + 1} artists. Scan paused gracefully and all ${totalDiscoveredTracks} discovered tracks were preserved.`);
            break;
          }
          console.warn(`Error fetching top tracks for ${candidate.name}:`, err);
        }

        // 40ms pause between requests to respect rate limits
        await new Promise(r => setTimeout(r, 40));
      }

      setSelectedTrackIds(initialCheckedTrackIds);
      setDiscoveredResults(results);
      setHasScanned(true);
    } catch (err) {
      console.error('Discovery scan failed:', err);
      alert(`Discovery scan error: ${err.message}`);
    } finally {
      setIsScanning(false);
    }
  };

  // Toggle individual track checkbox
  const toggleTrackCheck = (trackId) => {
    setSelectedTrackIds(prev => {
      const next = new Set(prev);
      if (next.has(trackId)) {
        next.delete(trackId);
      } else {
        next.add(trackId);
      }
      return next;
    });
  };

  // Remove individual track from candidate results
  const removeTrack = (artistKey, trackId) => {
    setDiscoveredResults(prev => {
      return prev.map(group => {
        if (group.artist.key !== artistKey) return group;
        return {
          ...group,
          tracks: group.tracks.filter(t => t.id !== trackId)
        };
      }).filter(group => group.tracks.length > 0);
    });

    setSelectedTrackIds(prev => {
      const next = new Set(prev);
      next.delete(trackId);
      return next;
    });
  };

  // Select all or deselect all discovered tracks
  const selectAllTracks = () => {
    const all = new Set();
    discoveredResults.forEach(group => {
      group.tracks.forEach(t => all.add(t.id));
    });
    setSelectedTrackIds(all);
  };

  const deselectAllTracks = () => {
    setSelectedTrackIds(new Set());
  };

  // Filter discovered results by search query
  const filteredDiscoveredResults = useMemo(() => {
    if (!resultsFilter.trim()) return discoveredResults;
    const q = resultsFilter.toLowerCase();
    return discoveredResults.filter(group => {
      if (group.artist.name.toLowerCase().includes(q)) return true;
      return group.tracks.some(t => t.name.toLowerCase().includes(q) || t.album?.name?.toLowerCase().includes(q));
    });
  }, [discoveredResults, resultsFilter]);

  // Total tracks currently selected for export
  const totalCheckedCount = useMemo(() => {
    let count = 0;
    discoveredResults.forEach(group => {
      group.tracks.forEach(t => {
        if (selectedTrackIds.has(t.id)) count++;
      });
    });
    return count;
  }, [discoveredResults, selectedTrackIds]);

  // Clamped active artist index for flipper mode
  const safeArtistIndex = useMemo(() => {
    if (filteredDiscoveredResults.length === 0) return 0;
    return Math.min(Math.max(0, activeArtistIndex), filteredDiscoveredResults.length - 1);
  }, [activeArtistIndex, filteredDiscoveredResults.length]);

  const currentArtistGroup = filteredDiscoveredResults[safeArtistIndex] || null;

  // Active library tracks for current artist in flipper mode
  const currentLibraryTracks = currentArtistGroup?.artist?.sampleTracks || [];
  const activeLibraryTrack = currentLibraryTracks[selectedLibraryTrackIndex || 0] || currentLibraryTracks[0] || null;
  const libraryTrackId = activeLibraryTrack?.id || activeLibraryTrack?.spotify_id || null;

  // Track currently cued in sticky player:
  // Defaults to the original library anchor track so the user can immediately hear what they know them from!
  const effectivePlayingTrack = useMemo(() => {
    if (!currentArtistGroup) return null;
    if (activeStickyPlayerTrack && (
      activeStickyPlayerTrack.isLibraryTrack ||
      currentArtistGroup.tracks?.some(t => t.id === activeStickyPlayerTrack.id)
    )) {
      return activeStickyPlayerTrack;
    }
    if (activeLibraryTrack) {
      return {
        id: libraryTrackId,
        name: activeLibraryTrack.name,
        artist: currentArtistGroup.artist.name,
        isLibraryTrack: true
      };
    }
    if (currentArtistGroup.tracks?.[0]) {
      return {
        id: currentArtistGroup.tracks[0].id,
        name: currentArtistGroup.tracks[0].name,
        artist: currentArtistGroup.artist.name,
        isLibraryTrack: false
      };
    }
    return null;
  }, [currentArtistGroup, activeStickyPlayerTrack, activeLibraryTrack, libraryTrackId]);

  const effectivePlayingTrackId = effectivePlayingTrack?.id || null;
  const isAuditioningLibraryTrack = Boolean(effectivePlayingTrack?.isLibraryTrack);

  // Reset library track index when switching artists
  useEffect(() => {
    setSelectedLibraryTrackIndex(0);
  }, [safeArtistIndex]);

  // Keyboard navigation for Flipper Mode (Left/Right Arrow keys)
  useEffect(() => {
    if (viewMode !== 'flipper' || filteredDiscoveredResults.length === 0) return;

    const handleKeyDown = (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setActiveArtistIndex(prev => Math.max(0, prev - 1));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setActiveArtistIndex(prev => Math.min(filteredDiscoveredResults.length - 1, prev + 1));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [viewMode, filteredDiscoveredResults.length]);

  // Create Playlist on Spotify
  const handleExportToSpotify = async () => {
    if (totalCheckedCount === 0) {
      alert('Please check at least one track to export to your new playlist.');
      return;
    }

    setIsExporting(true);
    setExportSuccess(null);
    setExportError(null);

    try {
      const user = await getCurrentUser();
      const newPlaylist = await createPlaylist(
        user.id,
        playlistTitle.trim() || 'Deep Cuts: Rediscover',
        playlistDesc.trim() || 'Unheard top tracks from under-represented artists discovered via Spotify Sorter.'
      );

      // Collect all selected URIs
      const uris = [];
      discoveredResults.forEach(group => {
        group.tracks.forEach(t => {
          if (selectedTrackIds.has(t.id) && t.uri) {
            uris.push(t.uri);
          }
        });
      });

      // Add to playlist in chunks of 100
      for (let i = 0; i < uris.length; i += 100) {
        const chunk = uris.slice(i, i + 100);
        await addTracksToPlaylist(newPlaylist.id, chunk);
      }

      setExportSuccess({
        id: newPlaylist.id,
        name: newPlaylist.name,
        count: uris.length,
        url: newPlaylist.external_urls?.spotify || `https://open.spotify.com/playlist/${newPlaylist.id}`
      });
    } catch (err) {
      console.error('Failed to export playlist:', err);
      setExportError(err.message || 'Failed to create playlist on Spotify.');
    } finally {
      setIsExporting(false);
    }
  };

  const excludedCount = Object.keys(excludedArtists).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Top Banner / Hero Controls */}
      <div className="glass-panel" style={{ padding: '1.75rem', position: 'relative', overflow: 'hidden' }}>
        <div style={{
          position: 'absolute',
          top: '-60px',
          right: '-40px',
          width: '240px',
          height: '240px',
          background: 'radial-gradient(circle, rgba(138, 43, 226, 0.22) 0%, transparent 70%)',
          pointerEvents: 'none'
        }} />

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.4rem' }}>
              <div style={{ 
                background: 'linear-gradient(135deg, #8A2BE2, #00d4ff)', 
                padding: '6px', 
                borderRadius: '8px', 
                display: 'flex', 
                alignItems: 'center', 
                justifyContent: 'center',
                boxShadow: '0 4px 12px rgba(138, 43, 226, 0.35)'
              }}>
                <Compass size={20} color="#fff" />
              </div>
              <h2 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 800 }}>Deep Cuts Discovery Engine</h2>
            </div>
            <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.88rem', maxWidth: '650px', lineHeight: '1.45' }}>
              Uncover gems from artists you like but barely listen to. Scans your library for under-represented artists, 
              finds their best tracks, filters out duplicates with 3-layer cross-release verification, and makes a ready-to-listen playlist.
            </p>
          </div>

          {/* Quick Drawer Toggles */}
          <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={() => setShowPoolDrawer(prev => !prev)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.45rem',
                padding: '0.5rem 0.9rem',
                borderRadius: '8px',
                background: showPoolDrawer ? 'rgba(0, 212, 255, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                border: showPoolDrawer ? '1px solid #00d4ff' : '1px solid var(--glass-border)',
                color: showPoolDrawer ? '#00d4ff' : 'var(--text-secondary)',
                fontSize: '0.82rem',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}
            >
              <Layers size={14} />
              Library Baseline ({selectedPoolIds.size} playlists)
            </button>

            <button
              onClick={() => setShowBlacklistDrawer(prev => !prev)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.45rem',
                padding: '0.5rem 0.9rem',
                borderRadius: '8px',
                background: showBlacklistDrawer ? 'rgba(231, 76, 60, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                border: showBlacklistDrawer ? '1px solid var(--accent-red)' : '1px solid var(--glass-border)',
                color: showBlacklistDrawer ? 'var(--accent-red)' : 'var(--text-secondary)',
                fontSize: '0.82rem',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}
            >
              <Ban size={14} />
              Excluded Artists ({excludedCount})
            </button>

            <button
              onClick={() => setShowCandidatesDrawer(prev => !prev)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.45rem',
                padding: '0.5rem 0.9rem',
                borderRadius: '8px',
                background: showCandidatesDrawer ? 'rgba(138, 43, 226, 0.18)' : 'rgba(255, 255, 255, 0.05)',
                border: showCandidatesDrawer ? '1px solid #8A2BE2' : '1px solid var(--glass-border)',
                color: showCandidatesDrawer ? '#c499ff' : 'var(--text-secondary)',
                fontSize: '0.82rem',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}
            >
              <Music size={14} />
              Eligible Artists ({eligibleCandidatesList.length > 0 ? eligibleCandidatesList.length : '...'})
            </button>
          </div>
        </div>

        {/* Configuration Bar */}
        <div style={{
          marginTop: '1.4rem',
          paddingTop: '1.2rem',
          borderTop: '1px solid var(--glass-border)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '1.25rem'
        }}>
          <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            {/* Threshold Setting */}
            <div>
              <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-secondary)', fontWeight: 700, letterSpacing: '0.5px', marginBottom: '0.35rem' }}>
                UNDER-REPRESENTED CRITERIA
              </label>
              <div style={{ display: 'flex', gap: '0.35rem', background: 'rgba(0,0,0,0.3)', padding: '3px', borderRadius: '8px', border: '1px solid var(--glass-border)' }}>
                {[1, 2, 3, 5].map(val => (
                  <button
                    key={val}
                    onClick={() => setMaxThreshold(val)}
                    style={{
                      padding: '0.35rem 0.75rem',
                      borderRadius: '6px',
                      border: 'none',
                      background: maxThreshold === val ? 'linear-gradient(135deg, #8A2BE2, #6c2bd9)' : 'transparent',
                      color: maxThreshold === val ? '#fff' : 'var(--text-secondary)',
                      fontSize: '0.8rem',
                      fontWeight: maxThreshold === val ? 700 : 500,
                      cursor: 'pointer'
                    }}
                  >
                    ≤ {val} {val === 1 ? 'song' : 'songs'}
                  </button>
                ))}
              </div>
            </div>

            {/* Songs per Artist */}
            <div>
              <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-secondary)', fontWeight: 700, letterSpacing: '0.5px', marginBottom: '0.35rem' }}>
                PULL PER ARTIST
              </label>
              <div style={{ display: 'flex', gap: '0.35rem', background: 'rgba(0,0,0,0.3)', padding: '3px', borderRadius: '8px', border: '1px solid var(--glass-border)' }}>
                {[1, 2, 3].map(val => (
                  <button
                    key={val}
                    onClick={() => setSongsPerArtist(val)}
                    style={{
                      padding: '0.35rem 0.75rem',
                      borderRadius: '6px',
                      border: 'none',
                      background: songsPerArtist === val ? 'linear-gradient(135deg, #00d4ff, #0099cc)' : 'transparent',
                      color: songsPerArtist === val ? '#000' : 'var(--text-secondary)',
                      fontSize: '0.8rem',
                      fontWeight: songsPerArtist === val ? 800 : 500,
                      cursor: 'pointer'
                    }}
                  >
                    Top {val}
                  </button>
                ))}
              </div>
            </div>

            {/* Batch Size */}
            <div>
              <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-secondary)', fontWeight: 700, letterSpacing: '0.5px', marginBottom: '0.35rem' }}>
                SCAN BATCH LIMIT
              </label>
              <div style={{ display: 'flex', gap: '0.35rem', background: 'rgba(0,0,0,0.3)', padding: '3px', borderRadius: '8px', border: '1px solid var(--glass-border)' }}>
                {[
                  { label: '25', val: 25 },
                  { label: '35 (Best)', val: 35 },
                  { label: '50', val: 50 },
                  { label: '100', val: 100 },
                  { label: 'All', val: 0 }
                ].map(opt => (
                  <button
                    key={opt.val}
                    onClick={() => setBatchLimit(opt.val)}
                    style={{
                      padding: '0.35rem 0.65rem',
                      borderRadius: '6px',
                      border: 'none',
                      background: batchLimit === opt.val ? '#1DB954' : 'transparent',
                      color: batchLimit === opt.val ? '#000' : 'var(--text-secondary)',
                      fontSize: '0.8rem',
                      fontWeight: batchLimit === opt.val ? 800 : 500,
                      cursor: 'pointer'
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {eligibleCandidatesList.length > 0 && batchLimit > 0 && batchLimit < eligibleCandidatesList.length && (
                <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.35rem' }}>
                  {shuffleOrder 
                    ? `🎲 Random ${batchLimit} of ${eligibleCandidatesList.length} artists` 
                    : `🔤 1st ${batchLimit} of ${eligibleCandidatesList.length} (A to Z)`
                  }
                </div>
              )}
            </div>

            {/* Shuffle Artists Toggle */}
            <div style={{ alignSelf: 'flex-end', paddingBottom: '2px' }}>
              <button
                onClick={() => setShuffleOrder(prev => !prev)}
                title={shuffleOrder ? "Randomizes artists so each run discovers a surprising, diverse variety" : "Scans artists alphabetically"}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  padding: '0.45rem 0.8rem',
                  borderRadius: '8px',
                  background: shuffleOrder ? 'rgba(138, 43, 226, 0.18)' : 'rgba(255,255,255,0.05)',
                  border: shuffleOrder ? '1px solid #8A2BE2' : '1px solid var(--glass-border)',
                  color: shuffleOrder ? '#c499ff' : 'var(--text-secondary)',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                <Shuffle size={13} />
                {shuffleOrder ? 'Shuffled' : 'Alphabetical'}
              </button>
            </div>
          </div>

          {/* Primary Action Button */}
          <div>
            <button
              onClick={runDiscovery}
              disabled={isScanning || selectedPoolIds.size === 0}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.6rem',
                padding: '0.75rem 1.6rem',
                borderRadius: '30px',
                background: isScanning ? 'rgba(255,255,255,0.1)' : 'linear-gradient(135deg, #1DB954, #1ed760)',
                color: isScanning ? 'var(--text-secondary)' : '#000',
                border: 'none',
                fontWeight: 800,
                fontSize: '0.95rem',
                cursor: isScanning ? 'not-allowed' : 'pointer',
                boxShadow: isScanning ? 'none' : '0 4px 18px rgba(29, 185, 84, 0.4)',
                transition: 'all 0.2s ease'
              }}
            >
              {isScanning ? (
                <>
                  <RefreshCw size={17} className="animate-spin" />
                  Scanning Library...
                </>
              ) : (
                <>
                  <Sparkles size={17} />
                  Discover Deep Cuts ({batchLimit > 0 ? `${batchLimit} Artists` : 'All'})
                </>
              )}
            </button>
          </div>
        </div>

        {/* Artist Spotlight: Instant Single Artist Discovery */}
        <div style={{
          marginTop: '1.25rem',
          padding: '0.85rem 1.15rem',
          background: 'linear-gradient(135deg, rgba(138, 43, 226, 0.09), rgba(0, 212, 255, 0.05))',
          borderRadius: '12px',
          border: '1px solid rgba(138, 43, 226, 0.25)',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.65rem'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Sparkles size={15} color="#c499ff" />
              <span style={{ fontSize: '0.84rem', fontWeight: 700, color: '#fff' }}>
                Artist Spotlight: Instant Discovery
              </span>
              <span style={{ fontSize: '0.74rem', color: 'var(--text-secondary)' }}>
                (Test or discover unheard tracks for any specific artist directly)
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', flex: 1, minWidth: '240px' }}>
              <Search size={14} color="var(--text-secondary)" style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }} />
              <input
                type="text"
                placeholder="Type an artist name to discover (e.g. BAD CHILD)..."
                value={spotlightInput}
                onChange={e => setSpotlightInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleSpotlightScan(spotlightInput);
                  }
                }}
                style={{
                  width: '100%',
                  padding: '0.55rem 0.85rem 0.55rem 2.2rem',
                  borderRadius: '8px',
                  border: '1px solid var(--glass-border)',
                  background: 'rgba(0,0,0,0.35)',
                  color: '#fff',
                  fontSize: '0.85rem',
                  outline: 'none',
                  boxSizing: 'border-box'
                }}
              />
              {spotlightInput && (
                <button
                  onClick={() => setSpotlightInput('')}
                  style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 0 }}
                >
                  <X size={13} />
                </button>
              )}
            </div>

            <button
              onClick={() => handleSpotlightScan(spotlightInput)}
              disabled={isSpotlightScanning || !spotlightInput.trim()}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.45rem',
                padding: '0.55rem 1.25rem',
                borderRadius: '8px',
                background: isSpotlightScanning || !spotlightInput.trim() ? 'rgba(255,255,255,0.08)' : 'linear-gradient(135deg, #8A2BE2, #00d4ff)',
                color: isSpotlightScanning || !spotlightInput.trim() ? 'var(--text-secondary)' : '#fff',
                border: 'none',
                fontSize: '0.84rem',
                fontWeight: 700,
                cursor: isSpotlightScanning || !spotlightInput.trim() ? 'not-allowed' : 'pointer',
                transition: 'all 0.2s',
                whiteSpace: 'nowrap'
              }}
            >
              {isSpotlightScanning ? (
                <>
                  <RefreshCw size={14} className="animate-spin" />
                  Scanning...
                </>
              ) : (
                <>
                  <Sparkles size={14} />
                  Discover for Artist
                </>
              )}
            </button>
          </div>

          {/* Quick matching suggestion chips */}
          {spotlightInput.trim().length >= 2 && eligibleCandidatesList.length > 0 && (
            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '0.15rem' }}>
              <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>Eligible in library:</span>
              {eligibleCandidatesList
                .filter(c => c.name.toLowerCase().includes(spotlightInput.trim().toLowerCase()))
                .slice(0, 5)
                .map(c => (
                  <button
                    key={c.key}
                    onClick={() => {
                      setSpotlightInput(c.name);
                      handleSpotlightScan(c.name);
                    }}
                    style={{
                      background: 'rgba(255,255,255,0.06)',
                      border: '1px solid rgba(255,255,255,0.12)',
                      borderRadius: '12px',
                      padding: '2px 8px',
                      color: '#00d4ff',
                      fontSize: '0.72rem',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.3rem'
                    }}
                  >
                    <span>{c.name}</span>
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.68rem' }}>({c.count} in pool)</span>
                  </button>
                ))}
            </div>
          )}

          {/* Spotlight Status message banner */}
          {spotlightStatus && (
            <div style={{
              padding: '0.45rem 0.8rem',
              borderRadius: '6px',
              fontSize: '0.8rem',
              background: spotlightStatus.type === 'success' ? 'rgba(29, 185, 84, 0.15)' :
                          spotlightStatus.type === 'error' ? 'rgba(231, 76, 60, 0.15)' :
                          spotlightStatus.type === 'warning' ? 'rgba(255, 149, 0, 0.15)' : 'rgba(0, 212, 255, 0.1)',
              border: `1px solid ${spotlightStatus.type === 'success' ? 'rgba(29, 185, 84, 0.3)' :
                                   spotlightStatus.type === 'error' ? 'rgba(231, 76, 60, 0.3)' :
                                   spotlightStatus.type === 'warning' ? 'rgba(255, 149, 0, 0.3)' : 'rgba(0, 212, 255, 0.25)'}`,
              color: spotlightStatus.type === 'success' ? '#2ecc71' :
                     spotlightStatus.type === 'error' ? '#ff857a' :
                     spotlightStatus.type === 'warning' ? '#ffb347' : '#00d4ff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '0.5rem'
            }}>
              <span>{spotlightStatus.text}</span>
              <button
                onClick={() => setSpotlightStatus(null)}
                style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0 }}
              >
                <X size={12} />
              </button>
            </div>
          )}
        </div>

        {/* Collapsible Library Baseline Pool Drawer */}
        {showPoolDrawer && (
          <div style={{
            marginTop: '1.25rem',
            paddingTop: '1.25rem',
            borderTop: '1px solid var(--glass-border)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <div>
                <h4 style={{ margin: 0, fontSize: '0.92rem' }}>Library Baseline Playlists</h4>
                <p style={{ margin: '0.15rem 0 0 0', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                  Artists and songs in these playlists represent your current library. Any songs in them will be excluded from recommendations.
                </p>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {masterPools && masterPools.length > 0 && (
                  <button
                    onClick={useMasterPoolsForDiscovery}
                    style={{ fontSize: '0.75rem', padding: '3px 8px', background: 'rgba(0, 212, 255, 0.12)', border: '1px solid rgba(0, 212, 255, 0.35)', color: '#00d4ff', borderRadius: '4px', cursor: 'pointer' }}
                  >
                    Use Master Pools ({masterPools.length})
                  </button>
                )}
                <button
                  onClick={selectAllPool}
                  style={{ fontSize: '0.75rem', padding: '3px 8px', background: 'rgba(255,255,255,0.06)', border: '1px solid var(--glass-border)', color: '#fff', borderRadius: '4px', cursor: 'pointer' }}
                >
                  Select All
                </button>
                <button
                  onClick={clearPool}
                  style={{ fontSize: '0.75rem', padding: '3px 8px', background: 'rgba(255,255,255,0.06)', border: '1px solid var(--glass-border)', color: 'var(--text-secondary)', borderRadius: '4px', cursor: 'pointer' }}
                >
                  Clear
                </button>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: '0.5rem', maxHeight: '180px', overflowY: 'auto', paddingRight: '0.5rem' }}>
              {playlists.map(p => {
                const isSelected = selectedPoolIds.has(p.id);
                return (
                  <div
                    key={p.id}
                    onClick={() => togglePoolPlaylist(p.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      padding: '0.45rem 0.65rem',
                      borderRadius: '8px',
                      background: isSelected ? 'rgba(0, 212, 255, 0.1)' : 'rgba(255, 255, 255, 0.02)',
                      border: isSelected ? '1px solid rgba(0, 212, 255, 0.4)' : '1px solid rgba(255, 255, 255, 0.05)',
                      cursor: 'pointer',
                      fontSize: '0.8rem',
                      userSelect: 'none'
                    }}
                  >
                    <div style={{
                      width: '14px',
                      height: '14px',
                      borderRadius: '3px',
                      border: isSelected ? 'none' : '1px solid var(--text-secondary)',
                      background: isSelected ? '#00d4ff' : 'transparent',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}>
                      {isSelected && <Check size={10} color="#000" strokeWidth={3} />}
                    </div>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      {p.name}
                    </span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                      {p.tracks?.total || 0}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Collapsible Excluded Artists Drawer */}
        {showBlacklistDrawer && (
          <div style={{
            marginTop: '1.25rem',
            paddingTop: '1.25rem',
            borderTop: '1px solid var(--glass-border)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
              <div>
                <h4 style={{ margin: 0, fontSize: '0.92rem' }}>Excluded Artists Blacklist</h4>
                <p style={{ margin: '0.15rem 0 0 0', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                  These artists will never be recommended. You can exclude artists directly from discovery cards or add them manually here.
                </p>
              </div>

              {/* Manual Add Input */}
              <form onSubmit={handleManualExclude} style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                <input
                  type="text"
                  placeholder="Exclude artist name..."
                  value={manualExcludeInput}
                  onChange={e => setManualExcludeInput(e.target.value)}
                  style={{
                    padding: '0.35rem 0.75rem',
                    borderRadius: '6px',
                    border: '1px solid var(--glass-border)',
                    background: 'rgba(0,0,0,0.3)',
                    color: '#fff',
                    fontSize: '0.8rem',
                    width: '180px'
                  }}
                />
                <button
                  type="submit"
                  disabled={!manualExcludeInput.trim()}
                  style={{
                    padding: '0.35rem 0.65rem',
                    borderRadius: '6px',
                    border: 'none',
                    background: 'var(--accent-red)',
                    color: '#fff',
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    cursor: 'pointer'
                  }}
                >
                  <Plus size={14} />
                </button>
              </form>
            </div>

            {excludedCount === 0 ? (
              <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', fontStyle: 'italic', margin: '0.5rem 0' }}>
                No artists currently excluded. When you mark an artist as "Exclude", they'll show up here.
              </p>
            ) : (
              <div>
                <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.6rem' }}>
                  <input
                    type="text"
                    placeholder="Filter excluded list..."
                    value={blacklistSearch}
                    onChange={e => setBlacklistSearch(e.target.value)}
                    style={{
                      padding: '0.3rem 0.6rem',
                      borderRadius: '6px',
                      border: '1px solid rgba(255,255,255,0.08)',
                      background: 'rgba(0,0,0,0.2)',
                      color: '#fff',
                      fontSize: '0.75rem',
                      width: '180px'
                    }}
                  />
                  {excludedCount > 0 && (
                    <button
                      onClick={() => persistExcluded({})}
                      style={{ fontSize: '0.72rem', padding: '2px 8px', background: 'transparent', border: '1px solid rgba(231,76,60,0.3)', color: 'var(--accent-red)', borderRadius: '4px', cursor: 'pointer' }}
                    >
                      Clear All ({excludedCount})
                    </button>
                  )}
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', maxHeight: '140px', overflowY: 'auto' }}>
                  {Object.entries(excludedArtists)
                    .filter(([key, val]) => !blacklistSearch || val.name.toLowerCase().includes(blacklistSearch.toLowerCase()))
                    .map(([key, val]) => (
                      <div
                        key={key}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.4rem',
                          padding: '0.25rem 0.6rem',
                          borderRadius: '16px',
                          background: 'rgba(231, 76, 60, 0.12)',
                          border: '1px solid rgba(231, 76, 60, 0.3)',
                          fontSize: '0.75rem',
                          color: '#ff857a'
                        }}
                      >
                        <span>{val.name}</span>
                        <button
                          onClick={() => unexcludeArtist(key)}
                          title="Remove from exclusion list"
                          style={{
                            background: 'none',
                            border: 'none',
                            color: '#ff857a',
                            cursor: 'pointer',
                            padding: 0,
                            display: 'flex',
                            alignItems: 'center'
                          }}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Collapsible Eligible Under-Represented Artists Drawer */}
        {showCandidatesDrawer && (
          <div style={{
            marginTop: '1.25rem',
            paddingTop: '1.25rem',
            borderTop: '1px solid var(--glass-border)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
              <div>
                <h4 style={{ margin: 0, fontSize: '0.92rem' }}>Eligible Under-Represented Artists ({eligibleCandidatesList.length})</h4>
                <p style={{ margin: '0.15rem 0 0 0', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                  Artists in your selected baseline with ≤ {maxThreshold} songs. Click "Discover" on any artist to scan their unheard top tracks instantly!
                </p>
              </div>

              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <input
                  type="text"
                  placeholder="Filter eligible artists (e.g. BAD CHILD)..."
                  value={candidatesSearch}
                  onChange={e => setCandidatesSearch(e.target.value)}
                  style={{
                    padding: '0.35rem 0.75rem',
                    borderRadius: '6px',
                    border: '1px solid var(--glass-border)',
                    background: 'rgba(0,0,0,0.3)',
                    color: '#fff',
                    fontSize: '0.8rem',
                    width: '220px'
                  }}
                />
                {candidatesSearch && (
                  <button
                    onClick={() => setCandidatesSearch('')}
                    style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '0 4px' }}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            </div>

            {eligibleCandidatesList.length === 0 ? (
              <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', fontStyle: 'italic', margin: '0.5rem 0' }}>
                Loading eligible artists from your baseline playlists...
              </p>
            ) : (
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                gap: '0.6rem',
                maxHeight: '260px',
                overflowY: 'auto',
                paddingRight: '0.5rem'
              }}>
                {eligibleCandidatesList
                  .filter(cand => !candidatesSearch || cand.name.toLowerCase().includes(candidatesSearch.toLowerCase().trim()))
                  .slice(0, 150)
                  .map(cand => (
                    <div
                      key={cand.key}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '0.55rem 0.8rem',
                        borderRadius: '8px',
                        background: 'rgba(255, 255, 255, 0.03)',
                        border: '1px solid rgba(255, 255, 255, 0.07)',
                        gap: '0.5rem'
                      }}
                    >
                      <div style={{ overflow: 'hidden', flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                          <span style={{ fontWeight: 700, fontSize: '0.84rem', color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {cand.name}
                          </span>
                          <span style={{
                            fontSize: '0.68rem',
                            padding: '1px 6px',
                            borderRadius: '10px',
                            background: cand.count === 1 ? 'rgba(0, 212, 255, 0.15)' : 'rgba(138, 43, 226, 0.15)',
                            color: cand.count === 1 ? '#00d4ff' : '#c499ff',
                            fontWeight: 600,
                            whiteSpace: 'nowrap'
                          }}>
                            {cand.count} {cand.count === 1 ? 'song' : 'songs'}
                          </span>
                        </div>
                        {cand.sampleTracks && cand.sampleTracks.length > 0 && (
                          <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '2px' }}>
                            In library: "{cand.sampleTracks[0].name}"
                          </div>
                        )}
                      </div>

                      <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                        <button
                          onClick={() => handleSpotlightScan(cand.name)}
                          disabled={isSpotlightScanning}
                          title={`Discover top unheard tracks for ${cand.name}`}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.3rem',
                            padding: '0.3rem 0.65rem',
                            borderRadius: '6px',
                            background: 'linear-gradient(135deg, #8A2BE2, #00d4ff)',
                            color: '#fff',
                            border: 'none',
                            fontSize: '0.74rem',
                            fontWeight: 700,
                            cursor: isSpotlightScanning ? 'not-allowed' : 'pointer',
                            whiteSpace: 'nowrap'
                          }}
                        >
                          <Sparkles size={11} />
                          Discover
                        </button>
                        <button
                          onClick={() => excludeArtist(cand.id, cand.name)}
                          title={`Exclude ${cand.name}`}
                          style={{
                            background: 'rgba(231, 76, 60, 0.12)',
                            border: '1px solid rgba(231, 76, 60, 0.3)',
                            color: '#ff857a',
                            borderRadius: '6px',
                            padding: '0.3rem 0.5rem',
                            fontSize: '0.72rem',
                            cursor: 'pointer'
                          }}
                        >
                          <Ban size={11} />
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Scanning Progress Bar Card */}
      {isScanning && (
        <div className="glass-panel animate-fade-in" style={{ padding: '1.75rem', textAlign: 'center' }}>
          <RefreshCw size={32} className="animate-spin" color="#1DB954" style={{ margin: '0 auto 0.75rem auto' }} />
          <h3 style={{ margin: '0 0 0.35rem 0', fontSize: '1.15rem' }}>{scanProgress.stage}</h3>
          <p style={{ margin: '0 0 1rem 0', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
            Cross-referencing Spotify top tracks against your library pool with ID, ISRC & Title verification.
          </p>

          {/* Progress Meter */}
          {scanProgress.total > 0 && (
            <div style={{ maxWidth: '420px', margin: '0 auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.35rem' }}>
                <span>{scanProgress.artistName || 'Scanning...'}</span>
                <span>{scanProgress.current} / {scanProgress.total}</span>
              </div>
              <div style={{ height: '6px', background: 'rgba(255,255,255,0.08)', borderRadius: '3px', overflow: 'hidden' }}>
                <div style={{
                  height: '100%',
                  width: `${Math.min(100, (scanProgress.current / scanProgress.total) * 100)}%`,
                  background: 'linear-gradient(90deg, #8A2BE2, #00d4ff)',
                  transition: 'width 0.15s ease'
                }} />
              </div>
              <div style={{ marginTop: '0.5rem', fontSize: '0.78rem', color: '#00d4ff' }}>
                ✨ {scanProgress.tracksFound} unheard deep cuts found so far
              </div>

              {/* Stop Scan & Keep Button */}
              <div style={{ marginTop: '1.25rem' }}>
                <button
                  onClick={handleStopScan}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.45rem',
                    padding: '0.5rem 1.2rem',
                    borderRadius: '8px',
                    background: 'rgba(231, 76, 60, 0.15)',
                    border: '1px solid var(--accent-red)',
                    color: '#ff857a',
                    fontSize: '0.85rem',
                    fontWeight: 700,
                    cursor: 'pointer',
                    transition: 'all 0.15s ease'
                  }}
                >
                  <Square size={13} fill="#ff857a" />
                  Stop Scan & Keep Discovered Songs ({scanProgress.tracksFound} found)
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Rate Limit Warning Banner */}
      {rateLimitWarning && (
        <div className="glass-panel animate-fade-in" style={{
          padding: '1rem 1.25rem',
          background: 'rgba(255, 149, 0, 0.12)',
          border: '1px solid rgba(255, 149, 0, 0.4)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '1rem'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
            <AlertTriangle size={18} color="#ff9500" />
            <span style={{ fontSize: '0.85rem', color: '#fff' }}>{rateLimitWarning}</span>
          </div>
          <button
            onClick={() => setRateLimitWarning(null)}
            style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 0 }}
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* Export Success Banner */}
      {exportSuccess && (
        <div className="glass-panel animate-fade-in" style={{
          padding: '1.5rem',
          background: 'rgba(29, 185, 84, 0.12)',
          border: '1px solid rgba(29, 185, 84, 0.4)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '1rem'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ background: '#1DB954', borderRadius: '50%', padding: '6px', display: 'flex' }}>
              <Check size={20} color="#000" strokeWidth={3} />
            </div>
            <div>
              <h4 style={{ margin: 0, fontSize: '1.05rem', color: '#fff' }}>
                Playlist Created: "{exportSuccess.name}"
              </h4>
              <p style={{ margin: '0.15rem 0 0 0', color: 'rgba(255,255,255,0.8)', fontSize: '0.85rem' }}>
                Successfully exported {exportSuccess.count} unheard deep cuts directly to your Spotify library!
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '0.6rem' }}>
            <a
              href={exportSuccess.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.55rem 1.1rem',
                borderRadius: '8px',
                background: '#1DB954',
                color: '#000',
                fontWeight: 700,
                fontSize: '0.85rem',
                textDecoration: 'none',
                boxShadow: '0 4px 12px rgba(29, 185, 84, 0.3)'
              }}
            >
              Open in Spotify <ExternalLink size={14} />
            </a>
            <button
              onClick={() => setExportSuccess(null)}
              style={{
                padding: '0.55rem',
                borderRadius: '8px',
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid var(--glass-border)',
                color: 'var(--text-secondary)',
                cursor: 'pointer'
              }}
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Export Error Banner */}
      {exportError && (
        <div className="glass-panel animate-fade-in" style={{
          padding: '1.25rem',
          background: 'rgba(231, 76, 60, 0.15)',
          border: '1px solid rgba(231, 76, 60, 0.4)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '1rem'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <AlertTriangle size={18} color="var(--accent-red)" />
            <span style={{ fontSize: '0.88rem', color: '#fff' }}>Export failed: {exportError}</span>
          </div>
          <button
            onClick={() => setExportError(null)}
            style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* Main Results or Empty / Explanatory State */}
      {!isScanning && !hasScanned && (
        <div className="glass-panel" style={{ textAlign: 'center', padding: '3.5rem 2rem' }}>
          <div style={{
            width: '64px',
            height: '64px',
            borderRadius: '50%',
            background: 'linear-gradient(135deg, rgba(138, 43, 226, 0.2), rgba(0, 212, 255, 0.2))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 1.25rem auto'
          }}>
            <Compass size={32} color="#00d4ff" />
          </div>
          <h3 style={{ margin: '0 0 0.6rem 0', fontSize: '1.25rem' }}>Ready to Rediscover Hidden Gems?</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', maxWidth: '520px', margin: '0 auto 1.75rem auto', lineHeight: '1.5' }}>
            Hit <strong>"Discover Deep Cuts"</strong> above. We'll scan your chosen library playlists ({selectedPoolIds.size}), 
            find artists who only appear {maxThreshold} times or fewer, pull their top tracks from Spotify, and filter out any songs you already have.
          </p>

          <button
            onClick={runDiscovery}
            disabled={selectedPoolIds.size === 0}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.55rem',
              padding: '0.75rem 1.6rem',
              borderRadius: '30px',
              background: 'linear-gradient(135deg, #1DB954, #1ed760)',
              color: '#000',
              border: 'none',
              fontWeight: 800,
              fontSize: '0.95rem',
              cursor: 'pointer',
              boxShadow: '0 4px 18px rgba(29, 185, 84, 0.35)'
            }}
          >
            <Sparkles size={17} />
            Start Deep Cuts Scan
          </button>
        </div>
      )}

      {!isScanning && hasScanned && discoveredResults.length === 0 && (
        <div className="glass-panel" style={{ textAlign: 'center', padding: '3.5rem 2rem' }}>
          <CheckCircle2 size={40} color="#1DB954" style={{ margin: '0 auto 1rem auto' }} />
          {lastScannedCandidatesCount > 0 ? (
            <>
              <h3 style={{ margin: '0 0 0.5rem 0' }}>All Scanned Top Tracks Are Already in Your Library!</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', maxWidth: '520px', margin: '0 auto 1.4rem auto', lineHeight: '1.45' }}>
                We checked <strong>{lastScannedCandidatesCount} under-represented artists</strong>, but you already own their top Spotify songs in your library pool! 
                Click below to scan another fresh shuffled batch of artists, or increase the threshold to discover more artists.
              </p>
              <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
                <button
                  onClick={runDiscovery}
                  style={{
                    padding: '0.6rem 1.3rem',
                    borderRadius: '8px',
                    background: '#1DB954',
                    color: '#000',
                    border: 'none',
                    fontWeight: 700,
                    fontSize: '0.88rem',
                    cursor: 'pointer'
                  }}
                >
                  🎲 Scan Next Shuffled Batch
                </button>
                <button
                  onClick={() => setMaxThreshold(5)}
                  style={{
                    padding: '0.6rem 1.1rem',
                    borderRadius: '8px',
                    background: 'rgba(255,255,255,0.08)',
                    border: '1px solid var(--glass-border)',
                    color: '#fff',
                    fontSize: '0.85rem',
                    cursor: 'pointer'
                  }}
                >
                  Increase Threshold to ≤ 5 songs
                </button>
              </div>
            </>
          ) : (
            <>
              <h3 style={{ margin: '0 0 0.5rem 0' }}>No Under-Represented Artists Found in Selected Playlists</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', maxWidth: '520px', margin: '0 auto 1.4rem auto', lineHeight: '1.45' }}>
                All artists in your chosen baseline playlists appear more than {maxThreshold} times, or are currently in your exclusion blacklist ({excludedCount} excluded).
              </p>
              <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
                <button
                  onClick={() => setMaxThreshold(5)}
                  style={{
                    padding: '0.55rem 1.2rem',
                    borderRadius: '8px',
                    background: 'rgba(255,255,255,0.08)',
                    border: '1px solid var(--glass-border)',
                    color: '#fff',
                    fontSize: '0.85rem',
                    cursor: 'pointer'
                  }}
                >
                  Increase Threshold to ≤ 5 songs
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Discovered Results View */}
      {!isScanning && discoveredResults.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {/* Results Action & Export Toolbar */}
          <div className="glass-panel" style={{ padding: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                  <span style={{ fontSize: '1.1rem', fontWeight: 800, color: '#fff' }}>
                    🎯 Found {discoveredResults.length} Under-Represented Artists
                  </span>
                  <span style={{
                    padding: '2px 8px',
                    borderRadius: '12px',
                    background: 'rgba(0, 212, 255, 0.15)',
                    color: '#00d4ff',
                    fontSize: '0.75rem',
                    fontWeight: 700
                  }}>
                    {totalCheckedCount} Deep Cuts Selected
                  </span>
                </div>
                <p style={{ margin: '0.2rem 0 0 0', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                  Review recommendations below, preview songs, or exclude any artists you've outgrown.
                </p>
              </div>

              {/* Search & Bulk Selection */}
              <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ position: 'relative' }}>
                  <Search size={14} color="var(--text-secondary)" style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)' }} />
                  <input
                    type="text"
                    placeholder="Search results..."
                    value={resultsFilter}
                    onChange={e => setResultsFilter(e.target.value)}
                    style={{
                      padding: '0.4rem 0.75rem 0.4rem 2rem',
                      borderRadius: '8px',
                      border: '1px solid var(--glass-border)',
                      background: 'rgba(0,0,0,0.3)',
                      color: '#fff',
                      fontSize: '0.8rem',
                      width: '180px'
                    }}
                  />
                  {resultsFilter && (
                    <button
                      onClick={() => setResultsFilter('')}
                      style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 0 }}
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>

                <button
                  onClick={selectAllTracks}
                  style={{ padding: '0.4rem 0.8rem', borderRadius: '8px', background: 'rgba(255,255,255,0.06)', border: '1px solid var(--glass-border)', color: '#fff', fontSize: '0.78rem', cursor: 'pointer' }}
                >
                  Select All
                </button>
                <button
                  onClick={deselectAllTracks}
                  style={{ padding: '0.4rem 0.8rem', borderRadius: '8px', background: 'rgba(255,255,255,0.06)', border: '1px solid var(--glass-border)', color: 'var(--text-secondary)', fontSize: '0.78rem', cursor: 'pointer' }}
                >
                  Deselect All
                </button>

                {/* View Mode Switcher */}
                <div style={{ display: 'flex', gap: '0.25rem', background: 'rgba(0,0,0,0.35)', padding: '3px', borderRadius: '8px', border: '1px solid var(--glass-border)' }}>
                  <button
                    onClick={() => setViewMode('flipper')}
                    title="Flip between artists one by one with a persistent sticky player (No scrolling needed!)"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                      padding: '0.35rem 0.75rem',
                      borderRadius: '6px',
                      border: 'none',
                      background: viewMode === 'flipper' ? 'linear-gradient(135deg, #8A2BE2, #6c2bd9)' : 'transparent',
                      color: viewMode === 'flipper' ? '#fff' : 'var(--text-secondary)',
                      fontSize: '0.78rem',
                      fontWeight: viewMode === 'flipper' ? 700 : 500,
                      cursor: 'pointer'
                    }}
                  >
                    <Compass size={13} />
                    Flipper Mode
                  </button>
                  <button
                    onClick={() => setViewMode('list')}
                    title="View all discovered artists at once in a list"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                      padding: '0.35rem 0.75rem',
                      borderRadius: '6px',
                      border: 'none',
                      background: viewMode === 'list' ? 'linear-gradient(135deg, #00d4ff, #0099cc)' : 'transparent',
                      color: viewMode === 'list' ? '#000' : 'var(--text-secondary)',
                      fontSize: '0.78rem',
                      fontWeight: viewMode === 'list' ? 700 : 500,
                      cursor: 'pointer'
                    }}
                  >
                    <LayoutGrid size={13} />
                    All Artists
                  </button>
                </div>
              </div>
            </div>

            {/* Sticky/Prominent Export Box */}
            <div style={{
              marginTop: '1rem',
              paddingTop: '1rem',
              borderTop: '1px solid var(--glass-border)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '1rem'
            }}>
              <div style={{ display: 'flex', gap: '0.75rem', flex: 1, minWidth: '280px', flexWrap: 'wrap' }}>
                <input
                  type="text"
                  value={playlistTitle}
                  onChange={e => setPlaylistTitle(e.target.value)}
                  placeholder="New Playlist Title"
                  style={{
                    padding: '0.5rem 0.85rem',
                    borderRadius: '8px',
                    border: '1px solid rgba(0, 212, 255, 0.4)',
                    background: 'rgba(0,0,0,0.4)',
                    color: '#fff',
                    fontSize: '0.88rem',
                    fontWeight: 600,
                    flex: 1,
                    minWidth: '200px'
                  }}
                />
                <input
                  type="text"
                  value={playlistDesc}
                  onChange={e => setPlaylistDesc(e.target.value)}
                  placeholder="Playlist description"
                  style={{
                    padding: '0.5rem 0.85rem',
                    borderRadius: '8px',
                    border: '1px solid var(--glass-border)',
                    background: 'rgba(0,0,0,0.3)',
                    color: 'var(--text-secondary)',
                    fontSize: '0.82rem',
                    flex: 2,
                    minWidth: '240px'
                  }}
                />
              </div>

              <button
                onClick={handleExportToSpotify}
                disabled={isExporting || totalCheckedCount === 0}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.55rem',
                  padding: '0.65rem 1.4rem',
                  borderRadius: '24px',
                  background: isExporting ? 'rgba(255,255,255,0.1)' : '#1DB954',
                  color: '#000',
                  border: 'none',
                  fontWeight: 800,
                  fontSize: '0.9rem',
                  cursor: isExporting || totalCheckedCount === 0 ? 'not-allowed' : 'pointer',
                  boxShadow: totalCheckedCount > 0 ? '0 4px 15px rgba(29, 185, 84, 0.4)' : 'none',
                  transition: 'all 0.2s'
                }}
              >
                {isExporting ? (
                  <>
                    <RefreshCw size={15} className="animate-spin" />
                    Creating on Spotify...
                  </>
                ) : (
                  <>
                    <ListMusic size={16} />
                    Create Playlist on Spotify ({totalCheckedCount} songs)
                  </>
                )}
              </button>
            </div>
          </div>

          {/* VIEW MODE 1: FLIPPER MODE (SongMatcher-style focused card with sticky player) */}
          {viewMode === 'flipper' ? (
            !currentArtistGroup ? (
              <div className="glass-panel" style={{ textAlign: 'center', padding: '3rem' }}>
                <p style={{ color: 'var(--text-secondary)' }}>No artists match the filter query.</p>
              </div>
            ) : (
              <div className="flipper-grid">
                
                {/* Left Column: Sticky Artist & Library Anchor Player */}
                <div className="glass-panel" style={{ position: 'sticky', top: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem', background: 'rgba(18, 18, 24, 0.95)', border: '1px solid rgba(255, 255, 255, 0.1)' }}>
                  
                  {/* 1. Artist Navigation Header */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', fontWeight: 700, letterSpacing: '0.5px' }}>
                      ARTIST {safeArtistIndex + 1} OF {filteredDiscoveredResults.length}
                    </span>
                    <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                      <button
                        disabled={safeArtistIndex === 0}
                        onClick={() => setActiveArtistIndex(prev => Math.max(0, prev - 1))}
                        style={{
                          padding: '4px 8px',
                          borderRadius: '6px',
                          background: 'rgba(255,255,255,0.06)',
                          border: '1px solid var(--glass-border)',
                          color: safeArtistIndex === 0 ? 'var(--text-secondary)' : '#fff',
                          cursor: safeArtistIndex === 0 ? 'default' : 'pointer',
                          display: 'flex',
                          alignItems: 'center'
                        }}
                        title="Previous Artist (Left Arrow Key)"
                      >
                        <ChevronLeft size={16} />
                      </button>
                      <button
                        disabled={safeArtistIndex >= filteredDiscoveredResults.length - 1}
                        onClick={() => setActiveArtistIndex(prev => Math.min(filteredDiscoveredResults.length - 1, prev + 1))}
                        style={{
                          padding: '4px 8px',
                          borderRadius: '6px',
                          background: 'rgba(255,255,255,0.06)',
                          border: '1px solid var(--glass-border)',
                          color: safeArtistIndex >= filteredDiscoveredResults.length - 1 ? 'var(--text-secondary)' : '#fff',
                          cursor: safeArtistIndex >= filteredDiscoveredResults.length - 1 ? 'default' : 'pointer',
                          display: 'flex',
                          alignItems: 'center'
                        }}
                        title="Next Artist (Right Arrow Key)"
                      >
                        <ChevronRight size={16} />
                      </button>
                      <button
                        onClick={() => {
                          excludeArtist(currentArtistGroup.artist.id, currentArtistGroup.artist.name);
                          if (safeArtistIndex >= filteredDiscoveredResults.length - 1) {
                            setActiveArtistIndex(Math.max(0, filteredDiscoveredResults.length - 2));
                          }
                        }}
                        style={{
                          padding: '4px 8px',
                          borderRadius: '6px',
                          background: 'rgba(231, 76, 60, 0.15)',
                          border: '1px solid rgba(231, 76, 60, 0.3)',
                          color: '#ff4d6d',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.25rem',
                          fontSize: '0.74rem',
                          fontWeight: 600
                        }}
                        title="Exclude this artist from future discovery"
                      >
                        <Ban size={13} />
                        Exclude
                      </button>
                    </div>
                  </div>

                  {/* 2. Artist Title & Quick Jump Selector */}
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem' }}>
                      <h2 style={{ margin: 0, fontSize: '1.35rem', fontWeight: 800, color: '#fff' }}>
                        {currentArtistGroup.artist.name}
                      </h2>
                      <span style={{
                        fontSize: '0.72rem',
                        padding: '2px 8px',
                        borderRadius: '10px',
                        background: 'rgba(138, 43, 226, 0.18)',
                        color: '#c499ff',
                        fontWeight: 700
                      }}>
                        {currentArtistGroup.artist.count} {currentArtistGroup.artist.count === 1 ? 'song' : 'songs'} in library
                      </span>
                    </div>

                    <div style={{ marginTop: '0.5rem' }}>
                      <select
                        value={safeArtistIndex}
                        onChange={e => setActiveArtistIndex(Number(e.target.value))}
                        style={{
                          width: '100%',
                          padding: '0.4rem 0.65rem',
                          borderRadius: '6px',
                          border: '1px solid var(--glass-border)',
                          background: 'rgba(0,0,0,0.4)',
                          color: 'var(--text-secondary)',
                          fontSize: '0.78rem',
                          outline: 'none',
                          cursor: 'pointer'
                        }}
                      >
                        {filteredDiscoveredResults.map((grp, idx) => (
                          <option key={grp.artist.key} value={idx} style={{ background: '#18181f', color: '#fff' }}>
                            {idx + 1}. {grp.artist.name} ({grp.tracks.length} deep cuts)
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* 3. Original Library Anchor Song Card ("How you know them") */}
                  <div style={{
                    padding: '0.85rem',
                    borderRadius: '10px',
                    background: 'rgba(0, 212, 255, 0.05)',
                    border: '1px solid rgba(0, 212, 255, 0.25)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.55rem'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <Compass size={13} color="#00d4ff" />
                        <span style={{ fontSize: '0.72rem', fontWeight: 800, color: '#00d4ff', letterSpacing: '0.5px' }}>
                          HOW YOU KNOW THEM (IN YOUR LIBRARY)
                        </span>
                      </div>
                      {currentLibraryTracks.length > 1 && (
                        <span style={{ fontSize: '0.68rem', color: 'var(--text-secondary)' }}>
                          {currentLibraryTracks.length} tracks in pool
                        </span>
                      )}
                    </div>

                    {/* If multiple library tracks, provide quick pill selector */}
                    {currentLibraryTracks.length > 1 && (
                      <div style={{ display: 'flex', gap: '0.35rem', overflowX: 'auto', paddingBottom: '2px' }}>
                        {currentLibraryTracks.map((lt, lIdx) => (
                          <button
                            key={lt.id || lt.spotify_id || lIdx}
                            onClick={() => setSelectedLibraryTrackIndex(lIdx)}
                            style={{
                              padding: '2px 7px',
                              borderRadius: '10px',
                              border: 'none',
                              background: (selectedLibraryTrackIndex || 0) === lIdx ? '#00d4ff' : 'rgba(255,255,255,0.07)',
                              color: (selectedLibraryTrackIndex || 0) === lIdx ? '#000' : 'var(--text-secondary)',
                              fontSize: '0.7rem',
                              fontWeight: (selectedLibraryTrackIndex || 0) === lIdx ? 700 : 500,
                              cursor: 'pointer',
                              whiteSpace: 'nowrap'
                            }}
                          >
                            Track {lIdx + 1}: "{lt.name}"
                          </button>
                        ))}
                      </div>
                    )}

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <div style={{
                        width: '42px',
                        height: '42px',
                        borderRadius: '6px',
                        background: 'rgba(0, 212, 255, 0.12)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0
                      }}>
                        <Music size={19} color="#00d4ff" />
                      </div>
                      <div style={{ overflow: 'hidden', flex: 1 }}>
                        <h4 style={{ margin: 0, fontSize: '0.92rem', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {activeLibraryTrack?.name || 'Library Track'}
                        </h4>
                        <p style={{ margin: '0.15rem 0 0 0', fontSize: '0.74rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {(() => {
                            const albumName = typeof activeLibraryTrack?.album === 'string'
                              ? activeLibraryTrack.album
                              : (activeLibraryTrack?.album?.name || '');
                            const releaseDate = activeLibraryTrack?.album?.release_date || activeLibraryTrack?.release_date;
                            const year = releaseDate && typeof releaseDate === 'string' ? ` (${releaseDate.substring(0, 4)})` : '';
                            return albumName ? `${albumName}${year}` : 'From your master baseline pool';
                          })()}
                        </p>
                      </div>
                    </div>

                    {/* Button to load library song into the sticky player */}
                    <button
                      onClick={() => {
                        if (activeLibraryTrack) {
                          setActiveStickyPlayerTrack({
                            id: activeLibraryTrack.id || activeLibraryTrack.spotify_id,
                            name: activeLibraryTrack.name,
                            artist: currentArtistGroup.artist.name,
                            isLibraryTrack: true
                          });
                        }
                      }}
                      style={{
                        width: '100%',
                        padding: '0.42rem',
                        borderRadius: '6px',
                        background: isAuditioningLibraryTrack ? 'rgba(0, 212, 255, 0.2)' : 'rgba(255,255,255,0.06)',
                        border: isAuditioningLibraryTrack ? '1px solid #00d4ff' : '1px solid var(--glass-border)',
                        color: isAuditioningLibraryTrack ? '#00d4ff' : '#fff',
                        fontSize: '0.76rem',
                        fontWeight: 700,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '0.4rem'
                      }}
                    >
                      <Volume2 size={13} />
                      {isAuditioningLibraryTrack ? 'Playing in Sticky Player' : 'Play Original Library Track'}
                    </button>
                  </div>

                  {/* 4. Sticky Spotify Embed Player Stage (Never moves or scrolls away!) */}
                  <div style={{ borderTop: '1px solid var(--glass-border)', paddingTop: '0.75rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.45rem', gap: '0.5rem' }}>
                      <span style={{ fontSize: '0.73rem', color: 'var(--text-secondary)', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                        {isAuditioningLibraryTrack ? '🎧 PLAYING: ORIGINAL LIBRARY SONG' : `✨ PLAYING: "${effectivePlayingTrack?.name || 'Deep Cut'}"`}
                      </span>
                      <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center', flexShrink: 0 }}>
                        {showStickyPlayer && (
                          <button
                            onClick={() => setStickyPlayerHeight(prev => prev === 80 ? 152 : 80)}
                            title={stickyPlayerHeight === 80 ? 'Switch to Expanded View for full-width time slider' : 'Switch to Compact View'}
                            style={{
                              background: stickyPlayerHeight === 152 ? 'rgba(0, 212, 255, 0.18)' : 'rgba(255, 255, 255, 0.06)',
                              border: stickyPlayerHeight === 152 ? '1px solid #00d4ff' : '1px solid var(--glass-border)',
                              color: stickyPlayerHeight === 152 ? '#00d4ff' : 'var(--text-secondary)',
                              fontSize: '0.7rem',
                              cursor: 'pointer',
                              padding: '2px 7px',
                              borderRadius: '4px',
                              fontWeight: 600
                            }}
                          >
                            {stickyPlayerHeight === 80 ? '↕ Expand Slider' : '↕ Compact'}
                          </button>
                        )}
                        <button
                          onClick={() => setShowStickyPlayer(prev => !prev)}
                          style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: '0.72rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.3rem' }}
                        >
                          {showStickyPlayer ? <VolumeX size={12} /> : <Volume2 size={12} />}
                          {showStickyPlayer ? 'Hide' : 'Show Player'}
                        </button>
                      </div>
                    </div>

                    {showStickyPlayer && effectivePlayingTrackId && (
                      <div style={{ borderRadius: '10px', overflow: 'hidden', height: `${stickyPlayerHeight}px`, transition: 'height 0.2s ease', background: '#000', width: '100%' }}>
                        <iframe
                          src={`https://open.spotify.com/embed/track/${effectivePlayingTrackId}?utm_source=generator&theme=0`}
                          width="100%"
                          height={stickyPlayerHeight}
                          frameBorder="0"
                          allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
                          loading="lazy"
                          style={{ borderRadius: '10px', display: 'block', width: '100%' }}
                        />
                      </div>
                    )}
                  </div>

                  {/* Artist Selection Quick Toggles */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--glass-border)', paddingTop: '0.75rem' }}>
                    <span style={{ fontSize: '0.74rem', color: 'var(--text-secondary)' }}>
                      {currentArtistGroup.tracks.filter(t => selectedTrackIds.has(t.id)).length} of {currentArtistGroup.tracks.length} deep cuts selected
                    </span>
                    <div style={{ display: 'flex', gap: '0.4rem' }}>
                      <button
                        onClick={() => {
                          setSelectedTrackIds(prev => new Set([...prev, ...currentArtistGroup.tracks.map(t => t.id)]));
                        }}
                        style={{ padding: '2px 7px', borderRadius: '4px', background: 'rgba(255,255,255,0.06)', border: '1px solid var(--glass-border)', color: '#fff', fontSize: '0.72rem', cursor: 'pointer' }}
                      >
                        Select All
                      </button>
                      <button
                        onClick={() => {
                          setSelectedTrackIds(prev => {
                            const next = new Set(prev);
                            currentArtistGroup.tracks.forEach(t => next.delete(t.id));
                            return next;
                          });
                        }}
                        style={{ padding: '2px 7px', borderRadius: '4px', background: 'rgba(255,255,255,0.06)', border: '1px solid var(--glass-border)', color: 'var(--text-secondary)', fontSize: '0.72rem', cursor: 'pointer' }}
                      >
                        Deselect
                      </button>
                    </div>
                  </div>
                </div>

                {/* Right Column: Unheard Deep Cuts For This Artist */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                    <div>
                      <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 800, color: '#fff' }}>
                        ✨ Discovered Top Tracks ({currentArtistGroup.tracks.length})
                      </h3>
                      <p style={{ margin: '0.15rem 0 0 0', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                        Unheard tracks from Spotify's catalogue. Checked songs will be exported to your new playlist.
                      </p>
                    </div>
                  </div>

                  {currentArtistGroup.tracks.map((track) => {
                    const isChecked = selectedTrackIds.has(track.id);
                    const isTrackInPlayer = effectivePlayingTrackId === track.id;
                    const albumImg = track.album?.images?.[0]?.url;
                    const releaseYear = track.album?.release_date ? track.album.release_date.substring(0, 4) : '';

                    return (
                      <div
                        key={track.id}
                        className="track-card"
                        style={{
                          padding: '0.85rem 1rem',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '1rem',
                          borderRadius: '12px',
                          border: isTrackInPlayer ? '1px solid #8A2BE2' : isChecked ? '1px solid rgba(0, 212, 255, 0.25)' : '1px solid rgba(255, 255, 255, 0.06)',
                          background: isTrackInPlayer ? 'rgba(138, 43, 226, 0.12)' : isChecked ? 'rgba(0, 212, 255, 0.03)' : 'rgba(255, 255, 255, 0.02)',
                          transition: 'all 0.15s ease'
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', flex: 1, minWidth: 0 }}>
                          {/* Checkbox */}
                          <div 
                            onClick={() => toggleTrackCheck(track.id)}
                            style={{
                              width: '20px',
                              height: '20px',
                              borderRadius: '5px',
                              border: isChecked ? 'none' : '1px solid var(--text-secondary)',
                              background: isChecked ? '#1DB954' : 'transparent',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              cursor: 'pointer',
                              flexShrink: 0
                            }}
                          >
                            {isChecked && <Check size={13} color="#000" strokeWidth={3} />}
                          </div>

                          {/* Album Artwork */}
                          {albumImg ? (
                            <img 
                              src={albumImg} 
                              alt={track.name} 
                              style={{ width: '48px', height: '48px', borderRadius: '8px', objectFit: 'cover', flexShrink: 0 }}
                            />
                          ) : (
                            <div style={{ width: '48px', height: '48px', borderRadius: '8px', background: 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                              <Music size={20} color="var(--text-secondary)" />
                            </div>
                          )}

                          {/* Track Info */}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                              <span style={{ fontWeight: 700, fontSize: '0.92rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={track.name}>
                                {track.name}
                              </span>
                              {track.popularity > 0 && (
                                <span 
                                  title={`Spotify Popularity: ${track.popularity}%`}
                                  style={{
                                    fontSize: '0.68rem',
                                    padding: '1px 6px',
                                    borderRadius: '8px',
                                    background: 'rgba(255, 149, 0, 0.15)',
                                    color: '#ff9500',
                                    fontWeight: 600,
                                    whiteSpace: 'nowrap'
                                  }}
                                >
                                  🔥 {track.popularity}%
                                </span>
                              )}
                            </div>

                            <p style={{ margin: '0.2rem 0 0 0', fontSize: '0.78rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {track.album?.name || 'Single / Release'} {releaseYear ? `(${releaseYear})` : ''}
                            </p>
                          </div>
                        </div>

                        {/* Action buttons */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <button
                            onClick={() => {
                              setActiveStickyPlayerTrack({
                                id: track.id,
                                name: track.name,
                                artist: currentArtistGroup.artist.name,
                                isLibraryTrack: false
                              });
                            }}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.35rem',
                              padding: '0.38rem 0.8rem',
                              borderRadius: '6px',
                              background: isTrackInPlayer ? 'linear-gradient(135deg, #8A2BE2, #6c2bd9)' : 'rgba(255,255,255,0.06)',
                              border: isTrackInPlayer ? 'none' : '1px solid var(--glass-border)',
                              color: '#fff',
                              fontSize: '0.78rem',
                              fontWeight: 600,
                              cursor: 'pointer',
                              whiteSpace: 'nowrap'
                            }}
                          >
                            {isTrackInPlayer ? <Volume2 size={13} /> : <Play size={13} fill="#fff" />}
                            {isTrackInPlayer ? 'In Player' : 'Audition'}
                          </button>

                          <button
                            onClick={() => removeTrack(currentArtistGroup.artist.key, track.id)}
                            title="Discard this track from discovery"
                            style={{
                              background: 'none',
                              border: 'none',
                              color: 'rgba(255,255,255,0.3)',
                              cursor: 'pointer',
                              padding: '4px',
                              display: 'flex',
                              alignItems: 'center'
                            }}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    );
                  })}

                  {/* Navigation Footer */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid var(--glass-border)' }}>
                    <button
                      disabled={safeArtistIndex === 0}
                      onClick={() => setActiveArtistIndex(prev => Math.max(0, prev - 1))}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.4rem',
                        padding: '0.55rem 1.1rem',
                        borderRadius: '8px',
                        background: 'rgba(255,255,255,0.06)',
                        border: '1px solid var(--glass-border)',
                        color: safeArtistIndex === 0 ? 'var(--text-secondary)' : '#fff',
                        fontSize: '0.84rem',
                        fontWeight: 600,
                        cursor: safeArtistIndex === 0 ? 'default' : 'pointer'
                      }}
                    >
                      <ChevronLeft size={16} />
                      Previous Artist
                    </button>

                    {safeArtistIndex < filteredDiscoveredResults.length - 1 ? (
                      <button
                        onClick={() => setActiveArtistIndex(prev => prev + 1)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.4rem',
                          padding: '0.55rem 1.3rem',
                          borderRadius: '8px',
                          background: 'linear-gradient(135deg, #8A2BE2, #00d4ff)',
                          border: 'none',
                          color: '#fff',
                          fontSize: '0.84rem',
                          fontWeight: 700,
                          cursor: 'pointer'
                        }}
                      >
                        Next Artist ({filteredDiscoveredResults[safeArtistIndex + 1]?.artist?.name})
                        <ChevronRight size={16} />
                      </button>
                    ) : (
                      <button
                        onClick={handleExportToSpotify}
                        disabled={isExporting || totalCheckedCount === 0}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.4rem',
                          padding: '0.55rem 1.4rem',
                          borderRadius: '8px',
                          background: '#1DB954',
                          border: 'none',
                          color: '#000',
                          fontSize: '0.84rem',
                          fontWeight: 800,
                          cursor: isExporting || totalCheckedCount === 0 ? 'not-allowed' : 'pointer'
                        }}
                      >
                        <Check size={16} />
                        Export All {totalCheckedCount} Tracks to Spotify
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          ) : (
            /* VIEW MODE 2: FULL ALL ARTISTS LIST */
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {filteredDiscoveredResults.map(group => {
                const { artist, tracks } = group;
                const sampleTrack = artist.sampleTracks?.[0] || null;
                const sampleTrackTitle = sampleTrack?.name || 'Library Track';
                const sampleTrackId = sampleTrack?.id || sampleTrack?.spotify_id || null;
                const isPlayingSample = activePreviewTrackId === `sample_${artist.key}`;

                return (
                  <div 
                    key={artist.key} 
                    className="glass-panel"
                    style={{
                      padding: '1.25rem',
                      background: 'rgba(18, 18, 24, 0.85)',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      borderRadius: '14px'
                    }}
                  >
                    {/* Artist Header */}
                    <div style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: '0.9rem',
                      paddingBottom: '0.75rem',
                      borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
                      flexWrap: 'wrap',
                      gap: '0.5rem'
                    }}>
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                          <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 800 }}>
                            {artist.name}
                          </h3>
                          <span style={{
                            fontSize: '0.72rem',
                            padding: '2px 7px',
                            borderRadius: '10px',
                            background: 'rgba(138, 43, 226, 0.15)',
                            color: '#b388ff',
                            fontWeight: 600
                          }}>
                            {artist.count} {artist.count === 1 ? 'song' : 'songs'} in library
                          </span>
                        </div>

                        {/* Anchor Library Song with Preview Player Button */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.35rem', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                            In your library: <strong style={{ color: '#00d4ff' }}>"{sampleTrackTitle}"</strong>
                          </span>
                          {sampleTrackId && (
                            <button
                              onClick={() => setActivePreviewTrackId(isPlayingSample ? null : `sample_${artist.key}`)}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '0.25rem',
                                padding: '2px 6px',
                                borderRadius: '4px',
                                background: isPlayingSample ? 'rgba(0, 212, 255, 0.2)' : 'rgba(255,255,255,0.06)',
                                border: isPlayingSample ? '1px solid #00d4ff' : '1px solid var(--glass-border)',
                                color: isPlayingSample ? '#00d4ff' : 'var(--text-secondary)',
                                fontSize: '0.7rem',
                                fontWeight: 600,
                                cursor: 'pointer'
                              }}
                            >
                              <Volume2 size={11} />
                              {isPlayingSample ? 'Hide Library Song' : 'Preview Library Song'}
                            </button>
                          )}
                        </div>

                        {/* Library Track Embed Player in List Mode */}
                        {isPlayingSample && sampleTrackId && (
                          <div style={{ marginTop: '0.5rem', borderRadius: '8px', overflow: 'hidden', height: '80px', maxWidth: '420px' }}>
                            <iframe
                              src={`https://open.spotify.com/embed/track/${sampleTrackId}?utm_source=generator&theme=0`}
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

                      {/* Exclude Artist Button */}
                      <button
                        onClick={() => excludeArtist(artist.id, artist.name)}
                        title="Exclude this artist from future discovery"
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.35rem',
                          padding: '0.35rem 0.75rem',
                          borderRadius: '6px',
                          background: 'rgba(231, 76, 60, 0.08)',
                          border: '1px solid rgba(231, 76, 60, 0.25)',
                          color: '#ff857a',
                          fontSize: '0.75rem',
                          fontWeight: 600,
                          cursor: 'pointer',
                          transition: 'all 0.15s'
                        }}
                      >
                        <Ban size={12} />
                        Exclude Artist
                      </button>
                    </div>

                    {/* Candidate Tracks for this Artist */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      {tracks.map(track => {
                        const isChecked = selectedTrackIds.has(track.id);
                        const isPlayingPreview = activePreviewTrackId === track.id;
                        const albumImg = track.album?.images?.[0]?.url;
                        const releaseYear = track.album?.release_date ? track.album.release_date.substring(0, 4) : '';

                        return (
                          <div 
                            key={track.id}
                            className="track-card"
                            style={{
                              padding: '0.65rem 0.85rem',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '0.5rem',
                              border: isChecked ? '1px solid rgba(0, 212, 255, 0.25)' : '1px solid rgba(255, 255, 255, 0.05)',
                              background: isChecked ? 'rgba(0, 212, 255, 0.03)' : 'rgba(255, 255, 255, 0.02)'
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
                              {/* Checkbox */}
                              <div 
                                onClick={() => toggleTrackCheck(track.id)}
                                style={{
                                  width: '18px',
                                  height: '18px',
                                  borderRadius: '4px',
                                  border: isChecked ? 'none' : '1px solid var(--text-secondary)',
                                  background: isChecked ? '#1DB954' : 'transparent',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  cursor: 'pointer',
                                  flexShrink: 0
                                }}
                              >
                                {isChecked && <Check size={12} color="#000" strokeWidth={3} />}
                              </div>

                              {/* Album Artwork */}
                              {albumImg ? (
                                <img 
                                  src={albumImg} 
                                  alt={track.name} 
                                  style={{ width: '42px', height: '42px', borderRadius: '6px', objectFit: 'cover', flexShrink: 0 }}
                                />
                              ) : (
                                <div style={{ width: '42px', height: '42px', borderRadius: '6px', background: 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                  <Music size={18} color="var(--text-secondary)" />
                                </div>
                              )}

                              {/* Track Info */}
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                  <span style={{ fontWeight: 700, fontSize: '0.88rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={track.name}>
                                    {track.name}
                                  </span>
                                  {track.popularity > 0 && (
                                    <span 
                                      title={`Spotify Popularity: ${track.popularity}%`}
                                      style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: '2px',
                                        fontSize: '0.7rem',
                                        color: '#ff9500',
                                        background: 'rgba(255, 149, 0, 0.1)',
                                        padding: '1px 5px',
                                        borderRadius: '4px',
                                        flexShrink: 0
                                      }}
                                    >
                                      <Flame size={10} />
                                      {track.popularity}
                                    </span>
                                  )}
                                </div>

                                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '2px' }}>
                                  <span>{track.album?.name || 'Album'}</span>
                                  {releaseYear && <span> • {releaseYear}</span>}
                                </div>
                              </div>

                              {/* Actions: Preview & Remove */}
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexShrink: 0 }}>
                                <button
                                  onClick={() => setActivePreviewTrackId(isPlayingPreview ? null : track.id)}
                                  title={isPlayingPreview ? "Close preview" : "Listen with Spotify Player"}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.3rem',
                                    padding: '0.35rem 0.6rem',
                                    borderRadius: '6px',
                                    background: isPlayingPreview ? 'rgba(29, 185, 84, 0.2)' : 'rgba(255,255,255,0.06)',
                                    border: isPlayingPreview ? '1px solid #1DB954' : '1px solid var(--glass-border)',
                                    color: isPlayingPreview ? '#1DB954' : 'var(--text-secondary)',
                                    fontSize: '0.75rem',
                                    cursor: 'pointer'
                                  }}
                                >
                                  {isPlayingPreview ? <VolumeX size={13} /> : <Volume2 size={13} />}
                                  {isPlayingPreview ? 'Hide' : 'Preview'}
                                </button>

                                <button
                                  onClick={() => removeTrack(artist.key, track.id)}
                                  title="Remove track from suggestions"
                                  style={{
                                    padding: '0.35rem',
                                    borderRadius: '6px',
                                    background: 'transparent',
                                    border: 'none',
                                    color: 'var(--text-secondary)',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center'
                                  }}
                                >
                                  <X size={14} />
                                </button>
                              </div>
                            </div>

                            {/* Spotify Embed Player Preview */}
                            {isPlayingPreview && (
                              <div style={{ marginTop: '0.4rem', borderRadius: '8px', overflow: 'hidden', height: '80px' }}>
                                <iframe
                                  src={`https://open.spotify.com/embed/track/${track.id}?utm_source=generator&theme=0`}
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
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

