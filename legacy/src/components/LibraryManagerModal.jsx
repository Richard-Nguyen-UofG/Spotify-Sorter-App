import { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { 
  getAllTracks, 
  deleteTrack, 
  clearDatabase, 
  downloadJsonFile, 
  importFromJson,
  onDatabaseChange
} from '../lib/acousticDatabase.js';
import { fetchAcousticFeaturesForTracks } from '../lib/audioFeatureEngine.js';
import { 
  X, 
  Download, 
  Upload, 
  Trash2, 
  Search, 
  RefreshCw, 
  Database, 
  Sparkles,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';

const PAGE_SIZE = 40;

export default function LibraryManagerModal({ isOpen, onClose }) {
  const [tracks, setTracks] = useState([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all'); // all, resolved, missing
  const [currentPage, setCurrentPage] = useState(1);
  
  const [importStatus, setImportStatus] = useState(null);
  const [fetchingMissing, setFetchingMissing] = useState(false);
  const [fetchProgress, setFetchProgress] = useState('');
  const fileInputRef = useRef(null);

  // Reload tracks safely from IndexedDB in-memory cache
  const reloadData = () => {
    try {
      const data = getAllTracks() || [];
      setTracks(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error("Failed to load tracks in modal:", e);
      setTracks([]);
    }
  };

  useEffect(() => {
    if (isOpen) {
      reloadData();
      setCurrentPage(1);
    }
    const unsubscribe = onDatabaseChange(() => {
      if (isOpen) {
        reloadData();
      }
    });
    return () => unsubscribe();
  }, [isOpen]);

  // Statistics
  const stats = useMemo(() => {
    const list = Array.isArray(tracks) ? tracks : [];
    const total = list.length;
    const resolved = list.filter(t => t && t.bpm).length;
    const missing = list.filter(t => t && !t.bpm).length;
    return { total, resolved, missing };
  }, [tracks]);

  // Filtered tracks
  const filteredTracks = useMemo(() => {
    const list = Array.isArray(tracks) ? tracks : [];
    return list.filter(t => {
      if (!t) return false;
      if (statusFilter === 'resolved' && !t.bpm) return false;
      if (statusFilter === 'missing' && t.bpm) return false;

      if (search.trim()) {
        const q = search.toLowerCase();
        const nameMatch = String(t.name || '').toLowerCase().includes(q);
        const artistMatch = String(t.artist || '').toLowerCase().includes(q);
        const isrcMatch = String(t.isrc || '').toLowerCase().includes(q);
        const keyMatch = String(t.key || '').toLowerCase().includes(q) || String(t.camelot || '').toLowerCase().includes(q);
        return nameMatch || artistMatch || isrcMatch || keyMatch;
      }
      return true;
    });
  }, [tracks, statusFilter, search]);

  useEffect(() => {
    setCurrentPage(1);
  }, [search, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredTracks.length / PAGE_SIZE));
  const paginatedTracks = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return filteredTracks.slice(start, start + PAGE_SIZE);
  }, [filteredTracks, currentPage]);

  const handleDelete = async (track) => {
    const id = track.id || track.isrc || track.lookup_key;
    if (confirm(`Remove "${track.name}" from your local cache?`)) {
      await deleteTrack(id);
    }
  };

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const text = event.target?.result;
        if (typeof text !== 'string') throw new Error("Could not read file text.");
        
        const res = await importFromJson(text);
        setImportStatus({
          success: true,
          message: `Imported successfully: ${res.added} added, ${res.updated} updated.`
        });
      } catch (err) {
        setImportStatus({
          success: false,
          message: `JSON Import Error: ${err.message}`
        });
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    };
    reader.readAsText(file);
  };

  const handleAutoFetchMissing = async () => {
    const missing = tracks.filter(t => t && !t.bpm);
    if (missing.length === 0) return;

    try {
      setFetchingMissing(true);
      setFetchProgress(`Starting Musicae lookup for ${missing.length} unresolved tracks...`);

      const res = await fetchAcousticFeaturesForTracks(missing, (prog) => {
        setFetchProgress(prog.message);
      }, true); // forceQuery = true to allow manual retry from library manager

      setImportStatus({
        success: true,
        message: `Lookup completed: ${res.stats.musicae} resolved via Musicae.io.`
      });
    } catch (err) {
      setImportStatus({
        success: false,
        message: `Fetch error: ${err.message}`
      });
    } finally {
      setFetchingMissing(false);
      setFetchProgress('');
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.82)',
      backdropFilter: 'blur(8px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000,
      padding: '1.5rem'
    }}>
      <div className="glass-panel animate-fade-in" style={{
        width: '100%',
        maxWidth: '1080px',
        height: '90vh',
        maxHeight: '850px',
        display: 'flex',
        flexDirection: 'column',
        padding: '1.5rem',
        overflow: 'hidden',
        boxShadow: '0 20px 50px rgba(0,0,0,0.7)',
        border: '1px solid var(--glass-border)',
        borderRadius: '16px'
      }}>
        
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', paddingBottom: '0.8rem', borderBottom: '1px solid var(--glass-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem' }}>
            <Database size={24} color="#00d4ff" />
            <div>
              <h2 style={{ fontSize: '1.3rem', margin: 0, color: 'var(--text-primary)' }}>Acoustic Library & Cache</h2>
              <p style={{ margin: '0.2rem 0 0 0', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                Offline IndexedDB Storage • Instant 0ms Lookups • Zero API Quota Used on Re-runs
              </p>
            </div>
          </div>
          <button 
            onClick={onClose} 
            style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '0.4rem' }}
          >
            <X size={22} />
          </button>
        </div>

        {/* Stats Summary Bar */}
        <div style={{ 
          display: 'grid', 
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', 
          gap: '0.75rem', 
          marginBottom: '1rem' 
        }}>
          <div style={{ padding: '0.6rem 0.8rem', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: '10px', border: '1px solid var(--glass-border)' }}>
            <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Total Cached Songs</span>
            <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: 'var(--text-primary)' }}>{stats.total}</div>
          </div>
          <div style={{ padding: '0.6rem 0.8rem', backgroundColor: 'rgba(29, 185, 84, 0.08)', borderRadius: '10px', border: '1px solid rgba(29, 185, 84, 0.2)' }}>
            <span style={{ fontSize: '0.7rem', color: 'var(--accent-green)' }}>Resolved BPM & Key</span>
            <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: 'var(--accent-green)' }}>{stats.resolved}</div>
          </div>
          <div style={{ padding: '0.6rem 0.8rem', backgroundColor: 'rgba(231, 76, 60, 0.08)', borderRadius: '10px', border: '1px solid rgba(231, 76, 60, 0.2)' }}>
            <span style={{ fontSize: '0.7rem', color: 'var(--accent-red)' }}>Unresolved Songs</span>
            <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: 'var(--accent-red)' }}>{stats.missing}</div>
          </div>
        </div>

        {/* Search, Filter & Action Bar */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.8rem', marginBottom: '0.8rem', flexWrap: 'wrap' }}>
          
          {/* Left: Search and Filters */}
          <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flex: 1, minWidth: '300px' }}>
            <div style={{ position: 'relative', flex: 1, maxWidth: '280px' }}>
              <Search size={15} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
              <input 
                type="text" 
                placeholder="Search song, artist, key, ISRC..." 
                value={search}
                onChange={e => setSearch(e.target.value)}
                style={{
                  width: '100%',
                  padding: '0.45rem 0.8rem 0.45rem 2rem',
                  borderRadius: '20px',
                  backgroundColor: 'rgba(255, 255, 255, 0.06)',
                  border: '1px solid var(--glass-border)',
                  color: '#fff',
                  fontSize: '0.85rem'
                }}
              />
              {search && (
                <button onClick={() => setSearch('')} style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                  <X size={13} />
                </button>
              )}
            </div>

            {/* Filter Pills */}
            <div style={{ display: 'flex', gap: '0.3rem' }}>
              {[
                { id: 'all', label: 'All' },
                { id: 'resolved', label: 'Resolved' },
                { id: 'missing', label: 'Unresolved' }
              ].map(f => (
                <button
                  key={f.id}
                  onClick={() => setStatusFilter(f.id)}
                  style={{
                    padding: '0.35rem 0.7rem',
                    borderRadius: '16px',
                    fontSize: '0.75rem',
                    border: '1px solid',
                    cursor: 'pointer',
                    backgroundColor: statusFilter === f.id ? 'var(--accent-green)' : 'rgba(255,255,255,0.04)',
                    color: statusFilter === f.id ? '#000' : 'var(--text-secondary)',
                    borderColor: statusFilter === f.id ? 'var(--accent-green)' : 'var(--glass-border)',
                    fontWeight: statusFilter === f.id ? 'bold' : 'normal'
                  }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {/* Right: Backup Actions */}
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button 
              className="btn-secondary" 
              onClick={() => fileInputRef.current?.click()}
              style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', padding: '0.45rem 0.8rem' }}
              title="Import JSON Backup file from computer"
            >
              <Upload size={15} /> Import Backup
            </button>
            <input 
              type="file" 
              ref={fileInputRef} 
              onChange={handleFileUpload} 
              accept=".json" 
              style={{ display: 'none' }} 
            />

            <button 
              className="btn-primary" 
              onClick={() => downloadJsonFile()}
              style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', padding: '0.45rem 1rem' }}
              title="Download entire library as JSON backup"
            >
              <Download size={15} /> Export Backup
            </button>

            <button 
              className="btn-secondary" 
              onClick={handleAutoFetchMissing}
              disabled={fetchingMissing || stats.missing === 0}
              style={{ 
                display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', padding: '0.45rem 0.8rem',
                opacity: (fetchingMissing || stats.missing === 0) ? 0.5 : 1
              }}
              title="Fetch missing acoustic info via Musicae.io"
            >
              <RefreshCw size={15} className={fetchingMissing ? "animate-spin" : ""} />
              {fetchingMissing ? 'Fetching...' : 'Fetch Unresolved'}
            </button>
          </div>
        </div>

        {/* Status / Alert Banner */}
        {importStatus && (
          <div style={{
            padding: '0.6rem 0.9rem',
            borderRadius: '8px',
            marginBottom: '0.8rem',
            backgroundColor: importStatus.success ? 'rgba(29, 185, 84, 0.15)' : 'rgba(231, 76, 60, 0.15)',
            border: `1px solid ${importStatus.success ? 'var(--accent-green)' : 'var(--accent-red)'}`,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontSize: '0.85rem'
          }}>
            <span>{importStatus.message}</span>
            <button onClick={() => setImportStatus(null)} style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer' }}><X size={15} /></button>
          </div>
        )}

        {fetchingMissing && fetchProgress && (
          <div style={{
            padding: '0.6rem 0.9rem',
            borderRadius: '8px',
            marginBottom: '0.8rem',
            backgroundColor: 'rgba(0, 212, 255, 0.15)',
            border: '1px solid #00d4ff',
            color: '#fff',
            fontSize: '0.85rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem'
          }}>
            <Sparkles size={15} color="#00d4ff" />
            <span>{fetchProgress}</span>
          </div>
        )}

        {/* Tracks Table */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', border: '1px solid var(--glass-border)', borderRadius: '12px', backgroundColor: 'rgba(0,0,0,0.3)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--glass-border)', backgroundColor: 'rgba(255,255,255,0.04)', position: 'sticky', top: 0, zIndex: 10 }}>
                <th style={{ padding: '0.6rem 0.8rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Track & Artist</th>
                <th style={{ padding: '0.6rem 0.8rem', color: 'var(--text-secondary)', fontWeight: 600, width: '90px' }}>BPM</th>
                <th style={{ padding: '0.6rem 0.8rem', color: 'var(--text-secondary)', fontWeight: 600, width: '130px' }}>Key / Camelot</th>
                <th style={{ padding: '0.6rem 0.8rem', color: 'var(--text-secondary)', fontWeight: 600, width: '150px' }}>Audio Metrics</th>
                <th style={{ padding: '0.6rem 0.8rem', color: 'var(--text-secondary)', fontWeight: 600, width: '110px' }}>Source</th>
                <th style={{ padding: '0.6rem 0.8rem', color: 'var(--text-secondary)', fontWeight: 600, width: '70px', textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {paginatedTracks.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: '2.5rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
                    {search ? 'No tracks match your search query.' : 'No tracks found in library.'}
                  </td>
                </tr>
              ) : (
                paginatedTracks.map((t, idx) => {
                  const id = t.id || t.spotify_id || t.isrc || t.lookup_key || `track-${idx}`;

                  return (
                    <tr key={id} style={{ 
                      borderBottom: '1px solid rgba(255,255,255,0.04)',
                      transition: 'background 0.2s'
                    }}>
                      {/* Track & Artist */}
                      <td style={{ padding: '0.6rem 0.8rem' }}>
                        <div style={{ fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '300px' }} title={String(t.name || '')}>
                          {String(t.name || 'Untitled')}
                        </div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                          {String(t.artist || 'Unknown Artist')} {t.year && ` (${t.year})`}
                        </div>
                      </td>

                      {/* BPM */}
                      <td style={{ padding: '0.6rem 0.8rem' }}>
                        <span style={{ 
                          fontWeight: t.bpm ? 'bold' : 'normal',
                          color: t.bpm ? 'var(--text-primary)' : 'var(--accent-red)'
                        }}>
                          {t.bpm ? `${Math.round(t.bpm * 10) / 10}` : '—'}
                        </span>
                      </td>

                      {/* Key & Camelot */}
                      <td style={{ padding: '0.6rem 0.8rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                          {t.camelot && (
                            <span style={{
                              backgroundColor: 'rgba(0, 212, 255, 0.2)',
                              color: '#00d4ff',
                              border: '1px solid rgba(0, 212, 255, 0.4)',
                              padding: '1px 5px',
                              borderRadius: '4px',
                              fontSize: '0.7rem',
                              fontWeight: 'bold'
                            }}>
                              {String(t.camelot)}
                            </span>
                          )}
                          <span style={{ color: t.key ? 'var(--text-secondary)' : 'rgba(255,255,255,0.3)', fontSize: '0.8rem' }}>
                            {t.key ? String(t.key) : '—'}
                          </span>
                        </div>
                      </td>

                      {/* Audio Metrics */}
                      <td style={{ padding: '0.6rem 0.8rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                        {t.energy !== null && t.energy !== undefined && <div>Energy: {Math.round(t.energy * 100)}%</div>}
                        {t.valence !== null && t.valence !== undefined && <div>Mood: {Math.round(t.valence * 100)}%</div>}
                        {(t.energy === null && t.valence === null && t.danceability === null) && <span style={{ opacity: 0.5 }}>—</span>}
                      </td>

                      {/* Source */}
                      <td style={{ padding: '0.6rem 0.8rem' }}>
                        <span style={{
                          fontSize: '0.7rem',
                          padding: '2px 6px',
                          borderRadius: '10px',
                          backgroundColor: t.source === 'musicae' ? 'rgba(0, 212, 255, 0.15)' : 'rgba(255, 255, 255, 0.08)',
                          color: t.source === 'musicae' ? '#00d4ff' : 'var(--text-secondary)',
                          border: `1px solid ${t.source === 'musicae' ? 'rgba(0, 212, 255, 0.3)' : 'rgba(255, 255, 255, 0.1)'}`
                        }}>
                          {t.source === 'musicae' ? 'Musicae.io' : (t.source || 'IndexedDB')}
                        </span>
                      </td>

                      {/* Actions */}
                      <td style={{ padding: '0.6rem 0.8rem', textAlign: 'right' }}>
                        <button 
                          onClick={() => handleDelete(t)} 
                          style={{ background: 'transparent', border: 'none', color: 'var(--accent-red)', cursor: 'pointer', padding: '3px', opacity: 0.7 }}
                          title="Delete cached row"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Footer info, Pagination & Clear database */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.8rem', paddingTop: '0.6rem', borderTop: '1px solid var(--glass-border)', flexWrap: 'wrap', gap: '0.5rem' }}>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            Showing {filteredTracks.length > 0 ? (currentPage - 1) * PAGE_SIZE + 1 : 0}–{Math.min(currentPage * PAGE_SIZE, filteredTracks.length)} of {filteredTracks.length} tracks
          </span>

          {/* Pagination Controls */}
          {totalPages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <button 
                className="btn-secondary" 
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                style={{ padding: '0.25rem 0.5rem', opacity: currentPage === 1 ? 0.4 : 1, display: 'flex', alignItems: 'center' }}
              >
                <ChevronLeft size={14} />
              </button>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-primary)' }}>
                Page {currentPage} of {totalPages}
              </span>
              <button 
                className="btn-secondary" 
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                style={{ padding: '0.25rem 0.5rem', opacity: currentPage === totalPages ? 0.4 : 1, display: 'flex', alignItems: 'center' }}
              >
                <ChevronRight size={14} />
              </button>
            </div>
          )}

          <button 
            onClick={() => {
              if (confirm("Are you sure you want to clear your local IndexedDB cache? This cannot be undone unless you exported a JSON backup.")) {
                clearDatabase();
              }
            }}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.75rem', textDecoration: 'underline' }}
          >
            Clear Library Cache
          </button>
        </div>

      </div>
    </div>,
    document.body
  );
}
