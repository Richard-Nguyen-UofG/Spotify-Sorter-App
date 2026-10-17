import { useState, useEffect, useMemo, useCallback } from 'react';
import { 
  getRecentlyPlayedTracks, 
  getUserSavedTracks, 
  searchSpotifyTracks, 
  getPlaylistTracks, 
  addTracksToPlaylist 
} from '../lib/spotifyAPI';
import { 
  getCachedPlaylistProfile, 
  saveCachedPlaylistProfile 
} from '../lib/acousticDatabase';
import { fetchAcousticFeaturesForTracks } from '../lib/audioFeatureEngine';
import { computePlaylistProfile, matchSongToPlaylists, getNormalizedSongKey } from '../lib/musicMath';
import { redirectToAuthCodeFlow, removeToken } from '../lib/spotify';
import { 
  Sparkles, 
  Check, 
  Plus, 
  ChevronLeft, 
  ChevronRight, 
  X, 
  Search, 
  Heart, 
  Clock, 
  ListMusic, 
  SlidersHorizontal, 
  Volume2, 
  VolumeX, 
  RefreshCw,
  CheckCircle2,
  HelpCircle,
  FolderPlus,
  AlertTriangle,
  Filter
} from 'lucide-react';

const DISMISSED_STORAGE_KEY = 'spotify_sorter_inbox_dismissed_ids';
const DESTINATIONS_STORAGE_KEY = 'spotify_sorter_destination_playlist_ids';

export default function SongMatcher({ playlists, masterPools = [] }) {
  // Source selection: 'recent', 'liked', 'search', 'playlist'
  const [sourceType, setSourceType] = useState('recent');
  const [selectedInboxPlaylistId, setSelectedInboxPlaylistId] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);

  // Queue of songs from chosen source
  const [queueTracks, setQueueTracks] = useState([]);
  const [loadingQueue, setLoadingQueue] = useState(false);
  const [sourceError, setSourceError] = useState(null);
  const [currentIndex, setCurrentIndex] = useState(0);

  // Dismissed / Handled tracks set (persisted in localStorage)
  const [dismissedIds, setDismissedIds] = useState(() => {
    try {
      const saved = localStorage.getItem(DISMISSED_STORAGE_KEY);
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });

  // Selected destination playlist IDs (persisted in localStorage)
  const [destinationIds, setDestinationIds] = useState(() => {
    try {
      const saved = localStorage.getItem(DESTINATIONS_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return new Set(parsed);
      }
    } catch {}
    // Default to all master pools or first 8 playlists
    if (masterPools.length > 0) return new Set(masterPools.map(p => p.id));
    return new Set(playlists.slice(0, 8).map(p => p.id));
  });

  // Drawer / configuration states
  const [showDestinationsDrawer, setShowDestinationsDrawer] = useState(false);
  const [showPreviewPlayer, setShowPreviewPlayer] = useState(true);
  const [playerHeight, setPlayerHeight] = useState(80); // 80 (compact) or 152 (expanded with full-width scrubber)

  // Cached destination profiles { [playlistId]: profile }
  const [profiles, setProfiles] = useState({});
  const [profilingStatus, setProfilingStatus] = useState('');
  const [isProfiling, setIsProfiling] = useState(false);

  // Acoustic features cache for active queue songs { [trackId]: featureObject }
  const [queueAcoustics, setQueueAcoustics] = useState({});
  const [loadingSongAcoustic, setLoadingSongAcoustic] = useState(false);

  // Filter & Sort state for playlist match compatibility
  const [matchSortBy, setMatchSortBy] = useState('match'); // 'match' | 'energy' | 'bpm' | 'name' | 'size_desc' | 'size_asc'
  const [hideAlreadyAdded, setHideAlreadyAdded] = useState(true);
  const [minScoreFilter, setMinScoreFilter] = useState(0); // 0, 70, 85
  const [playlistSearch, setPlaylistSearch] = useState('');
  const [harmonicOnlyFilter, setHarmonicOnlyFilter] = useState(false);

  // Action status state { [playlistId]: 'idle' | 'adding' | 'added' }
  const [actionStatus, setActionStatus] = useState({});
  const [lastAddedFeedback, setLastAddedFeedback] = useState(null);

  // Filtered queue (excluding dismissed songs)
  const activeQueue = useMemo(() => {
    return queueTracks.filter(t => t && t.id && !dismissedIds.has(t.id));
  }, [queueTracks, dismissedIds]);

  const currentSong = activeQueue[currentIndex] || null;

  // Save dismissed tracks to localStorage
  const dismissTrack = useCallback((trackId) => {
    if (!trackId) return;
    setDismissedIds(prev => {
      const next = new Set(prev).add(trackId);
      try {
        localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch {}
      return next;
    });
  }, []);

  const resetDismissed = useCallback(() => {
    setDismissedIds(new Set());
    try {
      localStorage.removeItem(DISMISSED_STORAGE_KEY);
    } catch {}
  }, []);

  // Save destination playlist selections to localStorage
  const toggleDestination = useCallback((playlistId) => {
    setDestinationIds(prev => {
      const next = new Set(prev);
      if (next.has(playlistId)) {
        next.delete(playlistId);
      } else {
        next.add(playlistId);
      }
      try {
        localStorage.setItem(DESTINATIONS_STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch {}
      return next;
    });
  }, []);

  const selectAllDestinations = useCallback(() => {
    const all = new Set(playlists.map(p => p.id));
    setDestinationIds(all);
    try {
      localStorage.setItem(DESTINATIONS_STORAGE_KEY, JSON.stringify(Array.from(all)));
    } catch {}
  }, [playlists]);

  const clearAllDestinations = useCallback(() => {
    setDestinationIds(new Set());
    try {
      localStorage.removeItem(DESTINATIONS_STORAGE_KEY);
    } catch {}
  }, []);

  const selectMasterPoolsDestinations = useCallback(() => {
    if (!masterPools || masterPools.length === 0) return;
    const poolSet = new Set(masterPools.map(p => p.id));
    setDestinationIds(poolSet);
    try {
      localStorage.setItem(DESTINATIONS_STORAGE_KEY, JSON.stringify(Array.from(poolSet)));
    } catch {}
  }, [masterPools]);

  // Load songs from selected source
  const loadSourceTracks = useCallback(async () => {
    try {
      setLoadingQueue(true);
      setSourceError(null);
      setCurrentIndex(0);
      let tracks = [];

      if (sourceType === 'recent') {
        tracks = await getRecentlyPlayedTracks(50);
      } else if (sourceType === 'liked') {
        tracks = await getUserSavedTracks(50);
      } else if (sourceType === 'playlist') {
        if (!selectedInboxPlaylistId) {
          setQueueTracks([]);
          setLoadingQueue(false);
          return;
        }
        const raw = await getPlaylistTracks(selectedInboxPlaylistId);
        tracks = raw
          .filter(t => (t.item || t.track) && !t.is_local)
          .map(t => t.item || t.track);
      }
      setQueueTracks(tracks);
    } catch (err) {
      console.error("Failed to load source tracks:", err);
      setSourceError(err.message || String(err));
      setQueueTracks([]);
    } finally {
      setLoadingQueue(false);
    }
  }, [sourceType, selectedInboxPlaylistId]);

  const handleReconnect = () => {
    const clientId = import.meta.env.VITE_SPOTIFY_CLIENT_ID;
    removeToken();
    redirectToAuthCodeFlow(clientId);
  };

  // Handle Search Execution
  const handleSearch = async (e) => {
    if (e) e.preventDefault();
    if (!searchQuery.trim()) return;
    try {
      setIsSearching(true);
      setLoadingQueue(true);
      setCurrentIndex(0);
      const results = await searchSpotifyTracks(searchQuery, 25);
      setQueueTracks(results);
    } catch (err) {
      console.error("Search failed:", err);
    } finally {
      setIsSearching(false);
      setLoadingQueue(false);
    }
  };

  useEffect(() => {
    if (sourceType !== 'search') {
      loadSourceTracks();
    }
  }, [sourceType, selectedInboxPlaylistId, loadSourceTracks]);

  // Ensure current index is within bounds of activeQueue
  useEffect(() => {
    if (currentIndex >= activeQueue.length && activeQueue.length > 0) {
      setCurrentIndex(activeQueue.length - 1);
    }
  }, [activeQueue.length, currentIndex]);

  // Fetch acoustic features for the currently displayed song
  useEffect(() => {
    if (!currentSong) return;

    if (queueAcoustics[currentSong.id]) return;

    let isMounted = true;
    const resolveAcoustic = async () => {
      try {
        setLoadingSongAcoustic(true);
        const { tracksWithFeatures } = await fetchAcousticFeaturesForTracks([currentSong]);
        if (isMounted && tracksWithFeatures && tracksWithFeatures[0]) {
          setQueueAcoustics(prev => ({
            ...prev,
            [currentSong.id]: tracksWithFeatures[0]
          }));
        }
      } catch (err) {
        console.warn("Could not fetch acoustic features for song:", err);
      } finally {
        if (isMounted) setLoadingSongAcoustic(false);
      }
    };

    resolveAcoustic();
    return () => { isMounted = false; };
  }, [currentSong, queueAcoustics]);

  // Precompute / retrieve profiles for active destination playlists
  useEffect(() => {
    const activeDestPlaylists = playlists.filter(p => destinationIds.has(p.id));
    if (activeDestPlaylists.length === 0) return;

    let isMounted = true;
    const buildProfiles = async () => {
      setIsProfiling(true);
      const newProfiles = { ...profiles };

      for (let i = 0; i < activeDestPlaylists.length; i++) {
        const pl = activeDestPlaylists[i];
        if (newProfiles[pl.id] && newProfiles[pl.id].snapshot_id === pl.snapshot_id) {
          continue;
        }

        setProfilingStatus(`Profiling "${pl.name}" (${i + 1}/${activeDestPlaylists.length})...`);

        // Check IndexedDB profile cache
        const cached = await getCachedPlaylistProfile(pl.id, pl.snapshot_id);
        if (cached) {
          newProfiles[pl.id] = cached;
          continue;
        }

        // Fetch tracks and acoustic data
        try {
          const rawTracks = await getPlaylistTracks(pl.id, false, null, pl.snapshot_id);
          const cleanTracks = rawTracks
            .filter(t => (t.item || t.track) && !t.is_local)
            .map(t => t.item || t.track);

          const { tracksWithFeatures } = await fetchAcousticFeaturesForTracks(cleanTracks);
          const profile = computePlaylistProfile(pl.id, pl.name, pl.snapshot_id, tracksWithFeatures);

          await saveCachedPlaylistProfile(profile);
          newProfiles[pl.id] = profile;
        } catch (err) {
          console.warn(`Failed to profile playlist "${pl.name}":`, err);
        }
      }

      if (isMounted) {
        setProfiles(newProfiles);
        setIsProfiling(false);
        setProfilingStatus('');
      }
    };

    buildProfiles();
    return () => { isMounted = false; };
  }, [destinationIds, playlists]);

  // Full enriched song object (combining Spotify track info with acoustic features)
  const enrichedCurrentSong = useMemo(() => {
    if (!currentSong) return null;
    const acoustic = queueAcoustics[currentSong.id] || {};
    return {
      ...currentSong,
      ...acoustic
    };
  }, [currentSong, queueAcoustics]);

  // Ranked destination matches for the active song
  const matchResults = useMemo(() => {
    if (!enrichedCurrentSong) return [];
    const activeProfiles = Array.from(destinationIds)
      .map(id => profiles[id])
      .filter(Boolean);

    return matchSongToPlaylists(enrichedCurrentSong, activeProfiles);
  }, [enrichedCurrentSong, destinationIds, profiles]);

  // Filtered and sorted destination matches
  const displayedMatches = useMemo(() => {
    let list = [...matchResults];

    // 1. Search by playlist name
    if (playlistSearch.trim()) {
      const q = playlistSearch.toLowerCase();
      list = list.filter(m => m.playlistName.toLowerCase().includes(q));
    }

    // 2. Hide already added
    if (hideAlreadyAdded) {
      list = list.filter(m => !m.isAlreadyIn);
    }

    // 3. Minimum match %
    if (minScoreFilter > 0) {
      list = list.filter(m => m.score >= minScoreFilter);
    }

    // 4. Harmonic Key fits only
    if (harmonicOnlyFilter) {
      list = list.filter(m => m.harmonicMatch);
    }

    // 5. Sorting
    if (matchSortBy === 'match') {
      list.sort((a, b) => b.score - a.score);
    } else if (matchSortBy === 'energy') {
      list.sort((a, b) => a.energyDiff - b.energyDiff || b.score - a.score);
    } else if (matchSortBy === 'bpm') {
      list.sort((a, b) => a.bpmDiff - b.bpmDiff || b.score - a.score);
    } else if (matchSortBy === 'name') {
      list.sort((a, b) => a.playlistName.localeCompare(b.playlistName));
    } else if (matchSortBy === 'size_desc') {
      list.sort((a, b) => (b.trackCount || 0) - (a.trackCount || 0));
    } else if (matchSortBy === 'size_asc') {
      list.sort((a, b) => (a.trackCount || 0) - (b.trackCount || 0));
    }

    return list;
  }, [matchResults, playlistSearch, hideAlreadyAdded, minScoreFilter, harmonicOnlyFilter, matchSortBy]);

  // Handle adding song to playlist
  const handleAddToPlaylist = async (playlistId, playlistName) => {
    if (!currentSong || !currentSong.uri) return;

    try {
      setActionStatus(prev => ({ ...prev, [playlistId]: 'adding' }));
      await addTracksToPlaylist(playlistId, [currentSong.uri]);

      // Update local profile immediately so isAlreadyIn flips to true
      setProfiles(prev => {
        const existing = prev[playlistId];
        if (!existing) return prev;
        const normKey = getNormalizedSongKey(currentSong);
        const isrc = currentSong.external_ids?.isrc || currentSong.isrc;
        return {
          ...prev,
          [playlistId]: {
            ...existing,
            trackIds: [...(existing.trackIds || []), currentSong.id],
            trackIsrcs: isrc ? [...(existing.trackIsrcs || []), isrc] : (existing.trackIsrcs || []),
            trackNormalizedKeys: normKey ? [...(existing.trackNormalizedKeys || []), normKey] : (existing.trackNormalizedKeys || []),
            track_count: (existing.track_count || 0) + 1
          }
        };
      });

      setActionStatus(prev => ({ ...prev, [playlistId]: 'added' }));
      setLastAddedFeedback(`✓ Added "${currentSong.name}" to ${playlistName}!`);

      setTimeout(() => {
        setActionStatus(prev => ({ ...prev, [playlistId]: 'idle' }));
      }, 3000);
    } catch (err) {
      console.error("Failed to add track to playlist:", err);
      setActionStatus(prev => ({ ...prev, [playlistId]: 'error' }));
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      
      {/* Top Controls & Mode Switcher */}
      <div className="glass-panel" style={{ padding: '1.25rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
          
          {/* Source Tabs */}
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginRight: '0.25rem', fontWeight: 600 }}>
              Source:
            </span>
            <button
              onClick={() => setSourceType('recent')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.45rem 0.85rem',
                borderRadius: '8px',
                border: sourceType === 'recent' ? '1px solid #1DB954' : '1px solid var(--glass-border)',
                background: sourceType === 'recent' ? 'rgba(29, 185, 84, 0.15)' : 'rgba(255, 255, 255, 0.03)',
                color: sourceType === 'recent' ? '#1DB954' : 'var(--text-primary)',
                fontSize: '0.85rem',
                cursor: 'pointer',
                fontWeight: 600,
                transition: 'all 0.2s'
              }}
            >
              <Clock size={15} /> Recently Played
            </button>

            <button
              onClick={() => setSourceType('liked')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.45rem 0.85rem',
                borderRadius: '8px',
                border: sourceType === 'liked' ? '1px solid #ff4d6d' : '1px solid var(--glass-border)',
                background: sourceType === 'liked' ? 'rgba(255, 77, 109, 0.15)' : 'rgba(255, 255, 255, 0.03)',
                color: sourceType === 'liked' ? '#ff4d6d' : 'var(--text-primary)',
                fontSize: '0.85rem',
                cursor: 'pointer',
                fontWeight: 600,
                transition: 'all 0.2s'
              }}
            >
              <Heart size={15} /> Liked Songs
            </button>

            <button
              onClick={() => setSourceType('search')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.45rem 0.85rem',
                borderRadius: '8px',
                border: sourceType === 'search' ? '1px solid #00d4ff' : '1px solid var(--glass-border)',
                background: sourceType === 'search' ? 'rgba(0, 212, 255, 0.15)' : 'rgba(255, 255, 255, 0.03)',
                color: sourceType === 'search' ? '#00d4ff' : 'var(--text-primary)',
                fontSize: '0.85rem',
                cursor: 'pointer',
                fontWeight: 600,
                transition: 'all 0.2s'
              }}
            >
              <Search size={15} /> Search Any Song
            </button>

            <button
              onClick={() => setSourceType('playlist')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.45rem 0.85rem',
                borderRadius: '8px',
                border: sourceType === 'playlist' ? '1px solid #a78bfa' : '1px solid var(--glass-border)',
                background: sourceType === 'playlist' ? 'rgba(167, 139, 250, 0.15)' : 'rgba(255, 255, 255, 0.03)',
                color: sourceType === 'playlist' ? '#a78bfa' : 'var(--text-primary)',
                fontSize: '0.85rem',
                cursor: 'pointer',
                fontWeight: 600,
                transition: 'all 0.2s'
              }}
            >
              <ListMusic size={15} /> Custom Inbox
            </button>
          </div>

          {/* Destinations Configuration Button */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <button
              onClick={() => setShowDestinationsDrawer(prev => !prev)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.45rem 0.85rem',
                borderRadius: '8px',
                border: '1px solid var(--glass-border)',
                background: showDestinationsDrawer ? 'rgba(255, 255, 255, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                color: 'var(--text-primary)',
                fontSize: '0.85rem',
                cursor: 'pointer',
                fontWeight: 600
              }}
            >
              <SlidersHorizontal size={14} /> Destinations ({destinationIds.size} active)
            </button>
          </div>
        </div>

        {/* Search Input Bar (when Search mode active) */}
        {sourceType === 'search' && (
          <form onSubmit={handleSearch} style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <Search size={16} color="var(--text-secondary)" style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }} />
              <input
                type="text"
                placeholder="Search song title or artist name..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{
                  width: '100%',
                  padding: '0.55rem 1rem 0.55rem 2.4rem',
                  borderRadius: '8px',
                  background: 'rgba(0,0,0,0.35)',
                  border: '1px solid var(--glass-border)',
                  color: '#fff',
                  fontSize: '0.9rem',
                  outline: 'none'
                }}
              />
            </div>
            <button
              type="submit"
              disabled={isSearching || !searchQuery.trim()}
              style={{
                padding: '0.55rem 1.25rem',
                borderRadius: '8px',
                background: '#00d4ff',
                color: '#000',
                border: 'none',
                fontWeight: 600,
                cursor: searchQuery.trim() ? 'pointer' : 'default',
                opacity: searchQuery.trim() ? 1 : 0.6
              }}
            >
              {isSearching ? 'Searching...' : 'Search'}
            </button>
          </form>
        )}

        {/* Custom Inbox Playlist Selector */}
        {sourceType === 'playlist' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '1rem' }}>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Select Inbox:</span>
            <select
              value={selectedInboxPlaylistId}
              onChange={(e) => setSelectedInboxPlaylistId(e.target.value)}
              style={{
                padding: '0.45rem 0.75rem',
                borderRadius: '8px',
                background: 'rgba(0,0,0,0.4)',
                border: '1px solid var(--glass-border)',
                color: '#fff',
                fontSize: '0.85rem'
              }}
            >
              <option value="">-- Choose a playlist to sort from --</option>
              {playlists.map(p => (
                <option key={p.id} value={p.id}>{p.name} ({p.tracks?.total || 0} songs)</option>
              ))}
            </select>
          </div>
        )}

        {/* Destination Playlists Selection Drawer */}
        {showDestinationsDrawer && (
          <div style={{
            marginTop: '1.25rem',
            paddingTop: '1.25rem',
            borderTop: '1px solid var(--glass-border)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <div>
                <h4 style={{ margin: 0, fontSize: '0.95rem' }}>Active Destination Playlists</h4>
                <p style={{ margin: '0.15rem 0 0 0', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                  New songs will be compared against these playlists to find the best match.
                </p>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {masterPools && masterPools.length > 0 && (
                  <button
                    onClick={selectMasterPoolsDestinations}
                    style={{ fontSize: '0.75rem', padding: '3px 8px', background: 'rgba(0, 212, 255, 0.12)', border: '1px solid rgba(0, 212, 255, 0.35)', color: '#00d4ff', borderRadius: '4px', cursor: 'pointer' }}
                  >
                    Use Master Pools ({masterPools.length})
                  </button>
                )}
                <button
                  onClick={selectAllDestinations}
                  style={{ fontSize: '0.75rem', padding: '3px 8px', background: 'rgba(255,255,255,0.06)', border: '1px solid var(--glass-border)', color: '#fff', borderRadius: '4px', cursor: 'pointer' }}
                >
                  Select All
                </button>
                <button
                  onClick={clearAllDestinations}
                  style={{ fontSize: '0.75rem', padding: '3px 8px', background: 'rgba(255,255,255,0.06)', border: '1px solid var(--glass-border)', color: 'var(--text-secondary)', borderRadius: '4px', cursor: 'pointer' }}
                >
                  Clear
                </button>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: '0.5rem', maxHeight: '200px', overflowY: 'auto', paddingRight: '0.5rem' }}>
              {playlists.map(p => {
                const isSelected = destinationIds.has(p.id);
                return (
                  <div
                    key={p.id}
                    onClick={() => toggleDestination(p.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      padding: '0.45rem 0.65rem',
                      borderRadius: '8px',
                      background: isSelected ? 'rgba(29, 185, 84, 0.12)' : 'rgba(255, 255, 255, 0.03)',
                      border: isSelected ? '1px solid rgba(29, 185, 84, 0.4)' : '1px solid rgba(255, 255, 255, 0.06)',
                      cursor: 'pointer',
                      fontSize: '0.82rem',
                      userSelect: 'none'
                    }}
                  >
                    <div style={{
                      width: '14px',
                      height: '14px',
                      borderRadius: '3px',
                      border: isSelected ? '1px solid #1DB954' : '1px solid var(--text-secondary)',
                      background: isSelected ? '#1DB954' : 'transparent',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}>
                      {isSelected && <Check size={10} color="#000" strokeWidth={3} />}
                    </div>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: isSelected ? 600 : 400 }}>
                      {p.name}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Profiling status indicator */}
      {isProfiling && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          padding: '0.5rem 1rem',
          borderRadius: '8px',
          background: 'rgba(0, 212, 255, 0.1)',
          border: '1px solid rgba(0, 212, 255, 0.3)',
          color: '#00d4ff',
          fontSize: '0.85rem'
        }}>
          <RefreshCw size={14} className="animate-spin" />
          <span>{profilingStatus || 'Analyzing playlist profiles...'}</span>
        </div>
      )}

      {/* Main Matching Stage: Current Song + Compatibility Cards */}
      {loadingQueue ? (
        <div className="glass-panel" style={{ textAlign: 'center', padding: '3rem' }}>
          <RefreshCw size={28} className="animate-spin" style={{ margin: '0 auto 1rem auto', color: '#1DB954' }} />
          <p style={{ color: 'var(--text-secondary)' }}>
            Loading songs from {sourceType === 'recent' ? 'recently played' : sourceType === 'liked' ? 'liked songs' : sourceType}...
          </p>
        </div>
      ) : sourceError ? (
        <div className="glass-panel" style={{ textAlign: 'center', padding: '3rem', border: '1px solid rgba(255, 149, 0, 0.4)' }}>
          <AlertTriangle size={42} color="#ff9500" style={{ margin: '0 auto 1rem auto' }} />
          <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1.25rem' }}>Spotify Permission Update Needed</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.92rem', maxWidth: '520px', margin: '0.5rem auto 1.5rem auto', lineHeight: '1.5' }}>
            Reading your <b>Recently Played</b> or <b>Liked Songs</b> requires granting updated Spotify permissions. Because you logged in before these features were added, a quick 1-click reconnect is required.
          </p>
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={handleReconnect}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.65rem 1.4rem',
                borderRadius: '8px',
                background: '#1DB954',
                color: '#000',
                border: 'none',
                fontWeight: 700,
                fontSize: '0.9rem',
                cursor: 'pointer',
                boxShadow: '0 4px 15px rgba(29, 185, 84, 0.35)'
              }}
            >
              <RefreshCw size={16} /> Reconnect with Spotify (1-Click)
            </button>

            <button
              onClick={() => setSourceType('playlist')}
              style={{
                padding: '0.65rem 1.2rem',
                borderRadius: '8px',
                background: 'rgba(255, 255, 255, 0.08)',
                color: '#fff',
                border: '1px solid var(--glass-border)',
                fontWeight: 600,
                fontSize: '0.9rem',
                cursor: 'pointer'
              }}
            >
              Use Custom Inbox Playlist Instead
            </button>
          </div>
        </div>
      ) : activeQueue.length === 0 ? (
        <div className="glass-panel" style={{ textAlign: 'center', padding: '3rem' }}>
          <CheckCircle2 size={40} color="#1DB954" style={{ margin: '0 auto 1rem auto' }} />
          <h3 style={{ margin: '0 0 0.5rem 0' }}>Your Queue is All Clear!</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', maxWidth: '440px', margin: '0 auto 1.25rem auto', lineHeight: '1.4' }}>
            {sourceType === 'playlist' && !selectedInboxPlaylistId
              ? 'Please select an inbox playlist above to start sorting.'
              : sourceType === 'recent'
              ? 'No recent songs detected in your Spotify playback history. Listen to a track in Spotify or select Liked Songs / Custom Inbox.'
              : 'No unhandled songs found in this source. All songs have been sorted or dismissed.'}
          </p>
          {dismissedIds.size > 0 && (
            <button
              onClick={resetDismissed}
              style={{
                padding: '0.45rem 1rem',
                borderRadius: '8px',
                background: 'rgba(255,255,255,0.08)',
                border: '1px solid var(--glass-border)',
                color: '#fff',
                fontSize: '0.85rem',
                cursor: 'pointer'
              }}
            >
              Reset Dismissed History ({dismissedIds.size} tracks)
            </button>
          )}
        </div>
      ) : (
        <div className="flipper-grid">
          
          {/* Left Column: Active Song Card */}
          <div className="glass-panel" style={{ position: 'sticky', top: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            
            {/* Queue navigation header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                SONG {currentIndex + 1} OF {activeQueue.length}
              </span>
              <div style={{ display: 'flex', gap: '0.35rem' }}>
                <button
                  disabled={currentIndex === 0}
                  onClick={() => setCurrentIndex(prev => Math.max(0, prev - 1))}
                  style={{
                    padding: '4px 8px',
                    borderRadius: '6px',
                    background: 'rgba(255,255,255,0.06)',
                    border: '1px solid var(--glass-border)',
                    color: currentIndex === 0 ? 'var(--text-secondary)' : '#fff',
                    cursor: currentIndex === 0 ? 'default' : 'pointer'
                  }}
                  title="Previous Song"
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  disabled={currentIndex >= activeQueue.length - 1}
                  onClick={() => setCurrentIndex(prev => Math.min(activeQueue.length - 1, prev + 1))}
                  style={{
                    padding: '4px 8px',
                    borderRadius: '6px',
                    background: 'rgba(255,255,255,0.06)',
                    border: '1px solid var(--glass-border)',
                    color: currentIndex >= activeQueue.length - 1 ? 'var(--text-secondary)' : '#fff',
                    cursor: currentIndex >= activeQueue.length - 1 ? 'default' : 'pointer'
                  }}
                  title="Next Song"
                >
                  <ChevronRight size={16} />
                </button>
                <button
                  onClick={() => dismissTrack(currentSong.id)}
                  style={{
                    padding: '4px 8px',
                    borderRadius: '6px',
                    background: 'rgba(231, 76, 60, 0.15)',
                    border: '1px solid rgba(231, 76, 60, 0.3)',
                    color: '#ff4d6d',
                    cursor: 'pointer'
                  }}
                  title="Dismiss / Skip this song"
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            {/* Album Art & Titles */}
            <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
              {currentSong.album?.images?.[0]?.url ? (
                <img 
                  src={currentSong.album.images[0].url} 
                  alt={currentSong.name} 
                  style={{ width: '84px', height: '84px', borderRadius: '10px', objectFit: 'cover', boxShadow: '0 4px 15px rgba(0,0,0,0.5)' }} 
                />
              ) : (
                <div style={{ width: '84px', height: '84px', borderRadius: '10px', background: 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Volume2 size={32} color="var(--text-secondary)" />
                </div>
              )}
              <div style={{ overflow: 'hidden', flex: 1 }}>
                <h3 style={{ margin: 0, fontSize: '1.1rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={currentSong.name}>
                  {currentSong.name}
                </h3>
                <p style={{ margin: '0.2rem 0', color: 'var(--text-secondary)', fontSize: '0.85rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {currentSong.artists?.map(a => a.name).join(', ') || 'Unknown Artist'}
                </p>
                {currentSong.album?.name && (
                  <p style={{ margin: 0, color: 'rgba(255,255,255,0.4)', fontSize: '0.75rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {currentSong.album.name}
                  </p>
                )}
              </div>
            </div>

            {/* Audio Preview / Embed Toggle */}
            <div>
              <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                <button
                  onClick={() => setShowPreviewPlayer(prev => !prev)}
                  style={{
                    flex: 1,
                    padding: '0.45rem',
                    borderRadius: '8px',
                    background: showPreviewPlayer ? 'rgba(29, 185, 84, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                    border: showPreviewPlayer ? '1px solid #1DB954' : '1px solid var(--glass-border)',
                    color: showPreviewPlayer ? '#1DB954' : '#fff',
                    fontSize: '0.8rem',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '0.4rem',
                    fontWeight: 600
                  }}
                >
                  {showPreviewPlayer ? <VolumeX size={14} /> : <Volume2 size={14} />}
                  {showPreviewPlayer ? 'Hide Player' : 'Preview Song (Spotify Player)'}
                </button>

                {showPreviewPlayer && (
                  <button
                    onClick={() => setPlayerHeight(prev => prev === 80 ? 152 : 80)}
                    title={playerHeight === 80 ? 'Switch to Expanded View for full-width time slider' : 'Switch to Compact Bar View'}
                    style={{
                      padding: '0.45rem 0.65rem',
                      borderRadius: '8px',
                      background: playerHeight === 152 ? 'rgba(0, 212, 255, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                      border: playerHeight === 152 ? '1px solid #00d4ff' : '1px solid var(--glass-border)',
                      color: playerHeight === 152 ? '#00d4ff' : 'var(--text-secondary)',
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                      fontWeight: 600,
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {playerHeight === 80 ? '↕ Expand Slider' : '↕ Compact'}
                  </button>
                )}
              </div>

              {showPreviewPlayer && currentSong.id && (
                <div style={{ marginTop: '0.75rem', borderRadius: '10px', overflow: 'hidden', height: `${playerHeight}px`, transition: 'height 0.2s ease', background: '#000', width: '100%' }}>
                  <iframe
                    src={`https://open.spotify.com/embed/track/${currentSong.id}?utm_source=generator&theme=0`}
                    width="100%"
                    height={playerHeight}
                    frameBorder="0"
                    allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
                    loading="lazy"
                    style={{ borderRadius: '10px', display: 'block', width: '100%' }}
                  />
                </div>
              )}
            </div>

            {/* Acoustic Data Tags */}
            <div style={{ borderTop: '1px solid var(--glass-border)', paddingTop: '0.75rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>ACOUSTIC PROFILE</span>
                {loadingSongAcoustic && (
                  <span style={{ fontSize: '0.72rem', color: '#00d4ff', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                    <RefreshCw size={11} className="animate-spin" /> Resolving...
                  </span>
                )}
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                {enrichedCurrentSong.bpm ? (
                  <span style={{ fontSize: '0.75rem', padding: '3px 7px', borderRadius: '4px', background: 'rgba(167, 139, 250, 0.15)', color: '#a78bfa', border: '1px solid rgba(167, 139, 250, 0.3)' }}>
                    🎵 {Math.round(enrichedCurrentSong.bpm)} BPM
                  </span>
                ) : null}

                {enrichedCurrentSong.camelot || enrichedCurrentSong.key ? (
                  <span style={{ fontSize: '0.75rem', padding: '3px 7px', borderRadius: '4px', background: 'rgba(52, 199, 89, 0.15)', color: '#34c759', border: '1px solid rgba(52, 199, 89, 0.3)' }}>
                    🔑 {enrichedCurrentSong.camelot || enrichedCurrentSong.key}
                  </span>
                ) : null}

                {enrichedCurrentSong.energy !== null && enrichedCurrentSong.energy !== undefined ? (
                  <span style={{ fontSize: '0.75rem', padding: '3px 7px', borderRadius: '4px', background: 'rgba(255, 149, 0, 0.15)', color: '#ff9500', border: '1px solid rgba(255, 149, 0, 0.3)' }}>
                    ⚡ {Math.round(enrichedCurrentSong.energy * 100)}% Energy
                  </span>
                ) : null}

                {enrichedCurrentSong.valence !== null && enrichedCurrentSong.valence !== undefined ? (
                  <span style={{ fontSize: '0.75rem', padding: '3px 7px', borderRadius: '4px', background: 'rgba(0, 212, 255, 0.15)', color: '#00d4ff', border: '1px solid rgba(0, 212, 255, 0.3)' }}>
                    🌊 {Math.round(enrichedCurrentSong.valence * 100)}% Mood
                  </span>
                ) : null}

                {enrichedCurrentSong.danceability !== null && enrichedCurrentSong.danceability !== undefined ? (
                  <span style={{ fontSize: '0.75rem', padding: '3px 7px', borderRadius: '4px', background: 'rgba(244, 63, 94, 0.15)', color: '#f43f5e', border: '1px solid rgba(244, 63, 94, 0.3)' }}>
                    💃 {Math.round(enrichedCurrentSong.danceability * 100)}% Dance
                  </span>
                ) : null}
              </div>
            </div>

            {/* Quick action feedback notification */}
            {lastAddedFeedback && (
              <div style={{
                padding: '0.5rem',
                borderRadius: '8px',
                background: 'rgba(29, 185, 84, 0.15)',
                border: '1px solid rgba(29, 185, 84, 0.3)',
                color: '#1DB954',
                fontSize: '0.78rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between'
              }}>
                <span>{lastAddedFeedback}</span>
                <button
                  onClick={() => setCurrentIndex(prev => Math.min(activeQueue.length - 1, prev + 1))}
                  style={{ background: 'transparent', border: 'none', color: '#fff', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}
                >
                  Next Song →
                </button>
              </div>
            )}
          </div>

          {/* Right Column: Ranked Compatibility Match List */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: '1.05rem' }}>Playlist Match Compatibility</h3>
                <p style={{ margin: '0.15rem 0 0 0', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  Ranked by 5D acoustic similarity (Energy, Mood, Tempo, and Camelot Key).
                </p>
              </div>
            </div>

            {/* Filter & Sort Bar */}
            {destinationIds.size > 0 && matchResults.length > 0 && (
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0.6rem',
                background: 'rgba(255, 255, 255, 0.02)',
                border: '1px solid var(--glass-border)',
                borderRadius: '10px',
                padding: '0.75rem'
              }}>
                <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' }}>
                  
                  {/* Playlist Search Filter */}
                  <div style={{ position: 'relative', minWidth: '180px', flex: 1 }}>
                    <Search size={14} color="var(--text-secondary)" style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)' }} />
                    <input
                      type="text"
                      placeholder="Filter playlists by name..."
                      value={playlistSearch}
                      onChange={(e) => setPlaylistSearch(e.target.value)}
                      style={{
                        width: '100%',
                        padding: '0.35rem 0.6rem 0.35rem 2rem',
                        borderRadius: '6px',
                        background: 'rgba(0,0,0,0.3)',
                        border: '1px solid var(--glass-border)',
                        color: '#fff',
                        fontSize: '0.8rem',
                        outline: 'none'
                      }}
                    />
                  </div>

                  {/* Sort Dropdown */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>Sort:</span>
                    <select
                      value={matchSortBy}
                      onChange={(e) => setMatchSortBy(e.target.value)}
                      style={{
                        padding: '0.35rem 0.6rem',
                        borderRadius: '6px',
                        background: 'rgba(0,0,0,0.4)',
                        border: '1px solid var(--glass-border)',
                        color: '#fff',
                        fontSize: '0.8rem',
                        outline: 'none',
                        cursor: 'pointer'
                      }}
                    >
                      <option value="match">Highest Match %</option>
                      <option value="energy">Closest Energy</option>
                      <option value="bpm">Closest BPM / Tempo</option>
                      <option value="name">Playlist Name (A – Z)</option>
                      <option value="size_desc">Largest Playlist (Song Count)</option>
                      <option value="size_asc">Smallest Playlist</option>
                    </select>
                  </div>
                </div>

                {/* Filter Chips Toolbar */}
                <div style={{ display: 'flex', gap: '0.45rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  {/* Hide already added toggle */}
                  <button
                    onClick={() => setHideAlreadyAdded(prev => !prev)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                      padding: '3px 8px',
                      borderRadius: '5px',
                      border: hideAlreadyAdded ? '1px solid #1DB954' : '1px solid var(--glass-border)',
                      background: hideAlreadyAdded ? 'rgba(29, 185, 84, 0.15)' : 'rgba(255,255,255,0.03)',
                      color: hideAlreadyAdded ? '#1DB954' : 'var(--text-secondary)',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      cursor: 'pointer'
                    }}
                  >
                    <Check size={12} strokeWidth={hideAlreadyAdded ? 3 : 2} /> Hide Already Added
                  </button>

                  {/* Min score chips */}
                  <button
                    onClick={() => setMinScoreFilter(prev => prev === 70 ? 0 : 70)}
                    style={{
                      padding: '3px 8px',
                      borderRadius: '5px',
                      border: minScoreFilter === 70 ? '1px solid #00d4ff' : '1px solid var(--glass-border)',
                      background: minScoreFilter === 70 ? 'rgba(0, 212, 255, 0.15)' : 'rgba(255,255,255,0.03)',
                      color: minScoreFilter === 70 ? '#00d4ff' : 'var(--text-secondary)',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      cursor: 'pointer'
                    }}
                  >
                    ✨ 70%+ Fits Only
                  </button>

                  <button
                    onClick={() => setMinScoreFilter(prev => prev === 85 ? 0 : 85)}
                    style={{
                      padding: '3px 8px',
                      borderRadius: '5px',
                      border: minScoreFilter === 85 ? '1px solid #a78bfa' : '1px solid var(--glass-border)',
                      background: minScoreFilter === 85 ? 'rgba(167, 139, 250, 0.15)' : 'rgba(255,255,255,0.03)',
                      color: minScoreFilter === 85 ? '#a78bfa' : 'var(--text-secondary)',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      cursor: 'pointer'
                    }}
                  >
                    💫 85%+ Twins Only
                  </button>

                  {/* Harmonic key only filter */}
                  <button
                    onClick={() => setHarmonicOnlyFilter(prev => !prev)}
                    style={{
                      padding: '3px 8px',
                      borderRadius: '5px',
                      border: harmonicOnlyFilter ? '1px solid #34c759' : '1px solid var(--glass-border)',
                      background: harmonicOnlyFilter ? 'rgba(52, 199, 89, 0.15)' : 'rgba(255,255,255,0.03)',
                      color: harmonicOnlyFilter ? '#34c759' : 'var(--text-secondary)',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      cursor: 'pointer'
                    }}
                  >
                    🔑 Harmonic Fit Only
                  </button>

                  {/* Reset all filters */}
                  {(hideAlreadyAdded || minScoreFilter > 0 || harmonicOnlyFilter || playlistSearch.trim()) && (
                    <button
                      onClick={() => {
                        setHideAlreadyAdded(false);
                        setMinScoreFilter(0);
                        setHarmonicOnlyFilter(false);
                        setPlaylistSearch('');
                      }}
                      style={{
                        padding: '3px 8px',
                        borderRadius: '5px',
                        background: 'transparent',
                        border: 'none',
                        color: '#ff4d6d',
                        fontSize: '0.75rem',
                        cursor: 'pointer',
                        textDecoration: 'underline'
                      }}
                    >
                      Reset Filters
                    </button>
                  )}

                  <span style={{ marginLeft: 'auto', fontSize: '0.74rem', color: 'var(--text-secondary)' }}>
                    Showing {displayedMatches.length} of {matchResults.length}
                  </span>
                </div>
              </div>
            )}

            {destinationIds.size === 0 ? (
              <div className="glass-panel" style={{ textAlign: 'center', padding: '2rem' }}>
                <HelpCircle size={32} color="var(--text-secondary)" style={{ margin: '0 auto 0.75rem auto' }} />
                <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                  No destination playlists selected. Click <b>"Destinations"</b> above to choose playlists to match against.
                </p>
              </div>
            ) : matchResults.length === 0 ? (
              <div className="glass-panel" style={{ textAlign: 'center', padding: '2rem' }}>
                <RefreshCw size={24} className="animate-spin" style={{ margin: '0 auto 0.75rem auto', color: '#00d4ff' }} />
                <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                  Analyzing acoustic compatibility...
                </p>
              </div>
            ) : displayedMatches.length === 0 ? (
              <div className="glass-panel" style={{ textAlign: 'center', padding: '2rem' }}>
                <Filter size={32} color="var(--text-secondary)" style={{ margin: '0 auto 0.75rem auto' }} />
                <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                  No playlists matched your active filters.
                </p>
                <button
                  onClick={() => {
                    setHideAlreadyAdded(false);
                    setMinScoreFilter(0);
                    setHarmonicOnlyFilter(false);
                    setPlaylistSearch('');
                  }}
                  style={{
                    marginTop: '0.75rem',
                    padding: '4px 10px',
                    borderRadius: '6px',
                    background: 'rgba(255,255,255,0.08)',
                    border: '1px solid var(--glass-border)',
                    color: '#fff',
                    fontSize: '0.8rem',
                    cursor: 'pointer'
                  }}
                >
                  Clear Filters
                </button>
              </div>
            ) : (
              displayedMatches.map((match, idx) => {
                const isBestFit = idx === 0 && match.score >= 80;
                const status = actionStatus[match.playlistId] || 'idle';

                // Compatibility bar color
                const barColor = match.score >= 85 ? '#00d4ff' : match.score >= 70 ? '#1DB954' : match.score >= 55 ? '#ffb703' : 'rgba(255,255,255,0.3)';

                return (
                  <div
                    key={match.playlistId}
                    className="track-card"
                    style={{
                      padding: '1rem',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.6rem',
                      border: isBestFit ? '1px solid rgba(0, 212, 255, 0.45)' : '1px solid rgba(255,255,255,0.08)',
                      background: isBestFit ? 'rgba(0, 212, 255, 0.04)' : 'rgba(255, 255, 255, 0.02)'
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
                      
                      {/* Left: Playlist Info & Match % */}
                      <div style={{ flex: 1, overflow: 'hidden' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.2rem' }}>
                          <h4 style={{ margin: 0, fontSize: '0.98rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {match.playlistName}
                          </h4>
                          {isBestFit && (
                            <span style={{ fontSize: '0.7rem', padding: '2px 6px', borderRadius: '4px', background: 'rgba(0, 212, 255, 0.2)', color: '#00d4ff', fontWeight: 600 }}>
                              Best Fit
                            </span>
                          )}
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                            • {match.trackCount || 0} songs
                          </span>
                        </div>

                        {/* Match Progress Bar */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                          <div style={{ flex: 1, height: '6px', borderRadius: '3px', background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                            <div style={{ width: `${match.score}%`, height: '100%', background: barColor, borderRadius: '3px', transition: 'width 0.3s ease' }} />
                          </div>
                          <span style={{ fontSize: '0.82rem', fontWeight: 700, color: barColor, minWidth: '40px', textAlign: 'right' }}>
                            {match.score}%
                          </span>
                        </div>
                      </div>

                      {/* Right: Add to Playlist Action */}
                      <div>
                        {match.isAlreadyIn ? (
                          <span style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.35rem',
                            padding: '0.45rem 0.85rem',
                            borderRadius: '8px',
                            background: 'rgba(255, 255, 255, 0.05)',
                            color: 'var(--text-secondary)',
                            fontSize: '0.8rem',
                            fontWeight: 500
                          }}>
                            <Check size={14} /> Already on playlist
                          </span>
                        ) : (
                          <button
                            onClick={() => handleAddToPlaylist(match.playlistId, match.playlistName)}
                            disabled={status === 'adding' || status === 'added'}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.4rem',
                              padding: '0.45rem 0.95rem',
                              borderRadius: '8px',
                              border: 'none',
                              background: status === 'added' ? '#1DB954' : '#1DB954',
                              color: '#000',
                              fontSize: '0.85rem',
                              fontWeight: 600,
                              cursor: status === 'adding' || status === 'added' ? 'default' : 'pointer',
                              opacity: status === 'adding' ? 0.7 : 1,
                              boxShadow: '0 2px 10px rgba(29, 185, 84, 0.3)',
                              transition: 'all 0.2s'
                            }}
                          >
                            {status === 'adding' ? (
                              <>
                                <RefreshCw size={14} className="animate-spin" /> Adding...
                              </>
                            ) : status === 'added' ? (
                              <>
                                <Check size={14} /> Added!
                              </>
                            ) : (
                              <>
                                <Plus size={14} strokeWidth={3} /> Add to Playlist
                              </>
                            )}
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Reasoning Badges */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                      {match.badges.map((b, bIdx) => (
                        <span
                          key={bIdx}
                          style={{
                            fontSize: '0.72rem',
                            padding: '2px 6px',
                            borderRadius: '4px',
                            background: 'rgba(255,255,255,0.04)',
                            border: '1px solid rgba(255,255,255,0.06)',
                            color: b.color || 'var(--text-secondary)'
                          }}
                        >
                          {b.label}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
