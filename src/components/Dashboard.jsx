import { useEffect, useState } from 'react';
import { getCurrentUserPlaylists } from '../lib/spotifyAPI';
import Analyzer from './Analyzer';
import { Target, CheckSquare, Square, Play } from 'lucide-react';

export default function Dashboard() {
  const [playlists, setPlaylists] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  
  const [targetPlaylist, setTargetPlaylist] = useState(null);
  const [masterPools, setMasterPools] = useState([]);
  const [analyzing, setAnalyzing] = useState(false);

  useEffect(() => {
    async function loadPlaylists() {
      try {
        const data = await getCurrentUserPlaylists();
        setPlaylists(data);
      } catch (err) {
        console.error(err);
        setError(`Failed to fetch playlists: ${err.message}`);
      } finally {
        setLoading(false);
      }
    }
    loadPlaylists();
  }, []);

  const toggleMasterPool = (playlist) => {
    if (masterPools.find(p => p.id === playlist.id)) {
      setMasterPools(masterPools.filter(p => p.id !== playlist.id));
    } else {
      setMasterPools([...masterPools, playlist]);
    }
  };

  if (analyzing && targetPlaylist) {
    return <Analyzer targetPlaylist={targetPlaylist} masterPools={masterPools} onBack={() => setAnalyzing(false)} />;
  }

  if (loading) {
    return <div className="glass-panel"><h3>Loading your playlists...</h3></div>;
  }

  if (error) {
    return <div className="glass-panel"><p style={{color: 'var(--accent-red)'}}>{error}</p></div>;
  }

  return (
    <div className="animate-fade-in">
      <div className="glass-panel" style={{ marginBottom: '2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2>Setup Analysis</h2>
          <p style={{ color: 'var(--text-secondary)' }}>
            1. Select one Target Playlist. <br/>
            2. (Optional) Select one or more Master Pools to draw suggestions from.
          </p>
        </div>
        <button 
          className="btn-primary" 
          onClick={() => setAnalyzing(true)}
          disabled={!targetPlaylist}
          style={{ opacity: targetPlaylist ? 1 : 0.5, cursor: targetPlaylist ? 'pointer' : 'not-allowed' }}
        >
          <Play size={20} />
          Start Analysis
        </button>
      </div>
      
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '1.5rem' }}>
        {playlists.map(p => p && (
          <div key={p.id || Math.random()} className="glass-panel" style={{ 
            padding: '1rem', 
            transition: 'all 0.2s',
            border: targetPlaylist?.id === p?.id ? '2px solid var(--accent-green)' : '1px solid var(--glass-border)'
          }}>
            {p?.images && p.images.length > 0 && p.images[0] ? (
              <img src={p.images[0].url} alt={p?.name || 'Playlist'} style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: '8px', marginBottom: '1rem' }} />
            ) : (
              <div style={{ width: '100%', aspectRatio: '1', backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: '8px', marginBottom: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                No Image
              </div>
            )}
            <h4 style={{ margin: '0 0 0.5rem 0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={p?.name}>{p?.name || 'Unnamed Playlist'}</h4>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>{p?.items?.total || p?.tracks?.total || 0} tracks</p>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <button 
                className="btn-secondary" 
                style={{ 
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                  backgroundColor: targetPlaylist?.id === p?.id ? 'var(--accent-green)' : 'transparent',
                  borderColor: targetPlaylist?.id === p?.id ? 'var(--accent-green)' : 'rgba(255,255,255,0.2)'
                }}
                onClick={() => setTargetPlaylist(p?.id === targetPlaylist?.id ? null : p)}
              >
                <Target size={16} />
                {targetPlaylist?.id === p?.id ? 'Target Selected' : 'Set as Target'}
              </button>
              
              <button 
                className="btn-secondary" 
                style={{ 
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                  backgroundColor: masterPools.find(pool => pool?.id === p?.id) ? 'var(--accent-purple)' : 'transparent',
                  borderColor: masterPools.find(pool => pool?.id === p?.id) ? 'var(--accent-purple)' : 'rgba(255,255,255,0.2)'
                }}
                onClick={() => toggleMasterPool(p)}
              >
                {masterPools.find(pool => pool?.id === p?.id) ? <CheckSquare size={16} /> : <Square size={16} />}
                Master Pool
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
