import { useEffect, useState } from 'react';
import { getPlaylistTracks, addTracksToPlaylist, getCurrentUser, createPlaylist } from '../lib/spotifyAPI';
import { Check, X, AlertCircle } from 'lucide-react';

export default function Analyzer({ targetPlaylist, masterPools, onBack }) {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("Initializing...");
  const [analysis, setAnalysis] = useState(null);
  const [error, setError] = useState(null);
  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState(null);

  useEffect(() => {
    async function performAnalysis() {
      try {
        setLoading(true);
        setStatus("Fetching target playlist tracks...");
        const targetTracksRaw = await getPlaylistTracks(targetPlaylist.id);
        const targetTracks = targetTracksRaw.filter(t => (t.item || t.track) && !t.is_local).map(t => t.item || t.track); 
        
        if (targetTracks.length === 0) {
           throw new Error("Target playlist is empty or contains no valid tracks.");
        }
        
        setStatus("Fetching master pool tracks...");
        let masterTracks = [];
        for (const pool of masterPools) {
          const poolTracksRaw = await getPlaylistTracks(pool.id);
          masterTracks = [...masterTracks, ...poolTracksRaw.filter(t => (t.item || t.track) && !t.is_local).map(t => t.item || t.track)];
        }

        // Deduplicate master tracks by normalized Name + Artist to avoid Remasters, Radio Edits, etc.
        const uniqueMasterTracksMap = new Map();
        for (const t of masterTracks) {
          if (t && t.id) {
            let dedupKey = t.id;
            if (t.name && t.artists && t.artists.length > 0) {
              const baseName = t.name.toLowerCase().split(/ - |\(/)[0].trim();
              const artistName = t.artists[0].name.toLowerCase();
              dedupKey = `${artistName}_${baseName}`;
            }
            
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

        setStatus("Calculating Vibe Profile (Era, Pacing & Artists)...");
        let totalYear = 0;
        let totalDuration = 0;
        let validYearCount = 0;
        const artistCounts = {};

        for (const t of targetTracks) {
          if (t.album && t.album.release_date) {
            const year = new Date(t.album.release_date).getFullYear();
            if (!isNaN(year)) {
              totalYear += year;
              validYearCount++;
            }
          }
          
          if (t.duration_ms) {
            totalDuration += t.duration_ms;
          }

          if (t.artists && t.artists.length > 0) {
            t.artists.forEach(a => {
              artistCounts[a.name] = (artistCounts[a.name] || 0) + 1;
            });
          }
        }

        const avgYear = validYearCount > 0 ? totalYear / validYearCount : new Date().getFullYear();
        const avgDuration = targetTracks.length > 0 ? totalDuration / targetTracks.length : 180000;
        
        const sortedArtists = Object.entries(artistCounts).sort((a, b) => b[1] - a[1]);
        // Consider artists that appear multiple times as "Core Artists", or just the top 10 if diverse
        const topArtists = new Set(sortedArtists.slice(0, 10).map(a => a[0]));

        const vibeProfile = {
          avgYear,
          avgDuration,
          topArtists,
          topArtistNames: Array.from(topArtists).slice(0, 3)
        };

        // Find Outliers
        const outliers = targetTracks.map(t => {
          const year = t.album && t.album.release_date ? new Date(t.album.release_date).getFullYear() : avgYear;
          const duration = t.duration_ms || avgDuration;
          return { track: t, year, duration };
        }).filter(t => {
          const yearDiff = Math.abs(t.year - avgYear);
          const durationDiff = Math.abs(t.duration - avgDuration);
          
          // An outlier is > 20 years away from average, OR length differs by > 2.5 minutes (150,000 ms)
          return yearDiff > 20 || durationDiff > 150000;
        });

        // Find Fits
        const targetIds = new Set(targetTracks.map(t => t.id));
        const targetDedupKeys = new Set(targetTracks.map(t => {
          if (!t.name || !t.artists || t.artists.length === 0) return t.id;
          const baseName = t.name.toLowerCase().split(/ - |\(/)[0].trim();
          const artistName = t.artists[0].name.toLowerCase();
          return `${artistName}_${baseName}`;
        }));

        const masterWithMeta = uniqueMasterTracks
          .filter(t => {
            if (targetIds.has(t.id)) return false;
            if (!t.name || !t.artists || t.artists.length === 0) return true;
            const baseName = t.name.toLowerCase().split(/ - |\(/)[0].trim();
            const artistName = t.artists[0].name.toLowerCase();
            const dedupKey = `${artistName}_${baseName}`;
            return !targetDedupKeys.has(dedupKey);
          })
          .map(t => {
            const year = t.album && t.album.release_date ? new Date(t.album.release_date).getFullYear() : avgYear;
            const duration = t.duration_ms || avgDuration;
            return { track: t, year, duration };
          });

        const MAX_SUGGESTIONS_PER_ARTIST = 5; // Cap at 5 per artist

        // First, find all potential fits
        const potentialFits = masterWithMeta.filter(t => {
          const yearDiff = Math.abs(t.year - avgYear);
          const durationDiff = Math.abs(t.duration - avgDuration);
          
          let hasOverlap = false;
          let matchedArtist = null;

          if (t.track.artists && t.track.artists.length > 0) {
            hasOverlap = t.track.artists.some(a => {
              if (topArtists.has(a.name)) {
                matchedArtist = a.name;
                return true;
              }
              return false;
            });
          }

          // Attach matchedArtist for grouping later
          if (hasOverlap && yearDiff <= 10 && durationDiff <= 90000) {
            t.matchedArtist = matchedArtist;
            return true;
          }
          return false;
        });

        // Group by matched artist
        const fitsByArtist = {};
        for (const fit of potentialFits) {
           if (!fitsByArtist[fit.matchedArtist]) {
             fitsByArtist[fit.matchedArtist] = [];
           }
           fitsByArtist[fit.matchedArtist].push(fit);
        }

        // Select 3 most popular and 2 random
        let fits = [];
        for (const artist in fitsByArtist) {
           let artistTracks = fitsByArtist[artist];
           
           // Sort by popularity descending
           artistTracks.sort((a, b) => {
             const popA = a.track.popularity || 0;
             const popB = b.track.popularity || 0;
             return popB - popA;
           });

           // Take top 3 most popular
           const topPopular = artistTracks.slice(0, 3);
           
           // Take the remaining tracks, randomize them, and pick up to 2
           let remaining = artistTracks.slice(3);
           remaining.sort(() => Math.random() - 0.5);
           const randomPicks = remaining.slice(0, 2);

           fits = [...fits, ...topPopular, ...randomPicks];
        }

        setAnalysis({
          vibeProfile,
          outliers,
          fits: fits.slice(0, 50)
        });

      } catch (err) {
        console.error(err);
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    performAnalysis();
  }, [targetPlaylist, masterPools]);

  const handleCommit = async () => {
    try {
      setCommitting(true);
      
      const tracksToRemove = analysis.outliers.map(o => o.track.uri);
      const tracksToAdd = analysis.fits.map(f => f.track.uri);

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

      setCommitResult(msg || "No playlists were created because there were no suggestions.");
    } catch (err) {
      console.error(err);
      setError(`Failed to create playlists on Spotify: ${err.message}`);
    } finally {
      setCommitting(false);
    }
  };

  function formatTime(ms) {
    const mins = Math.floor(ms / 60000);
    const secs = ((ms % 60000) / 1000).toFixed(0);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }

  if (loading || committing) {
    return (
      <div className="glass-panel" style={{ textAlign: 'center', padding: '3rem' }}>
        <h3>{committing ? "Creating Playlists on Spotify..." : "Analyzing Playlists"}</h3>
        <p style={{ color: 'var(--text-secondary)' }}>{status}</p>
        <div style={{ marginTop: '2rem', display: 'flex', justifyContent: 'center' }}>
          <div className="animate-fade-in" style={{
            width: '40px', height: '40px', border: '4px solid var(--glass-border)', 
            borderTop: '4px solid var(--accent-green)', borderRadius: '50%',
            animation: 'spin 1s linear infinite'
          }}></div>
        </div>
        <style>{`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (error) {
    return <div className="glass-panel"><p style={{color: 'var(--accent-red)'}}>{error}</p><button className="btn-secondary" onClick={onBack}>Go Back</button></div>;
  }

  if (commitResult) {
    return (
      <div className="glass-panel" style={{ textAlign: 'center', padding: '3rem' }}>
        <Check size={64} color="var(--accent-green)" style={{ marginBottom: '1rem' }} />
        <h2>Update Complete!</h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '2rem' }}>{commitResult}</p>
        <button className="btn-primary" onClick={onBack}>Back to Dashboard</button>
      </div>
    );
  }

  return (
    <div className="glass-panel animate-fade-in">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div>
          <h2>Analysis: {targetPlaylist.name}</h2>
          <p style={{ color: 'var(--text-secondary)' }}>
            Core Artists: {analysis.vibeProfile.topArtistNames.join(', ') || 'Mixed'} | Era: ~{Math.round(analysis.vibeProfile.avgYear)} | Avg Length: {formatTime(analysis.vibeProfile.avgDuration)}
          </p>
        </div>
        <button className="btn-secondary" onClick={onBack}>Back to Dashboard</button>
      </div>
      
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem', marginBottom: '2rem' }}>
        <div>
          <h3 style={{ color: 'var(--accent-red)', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <X size={20} /> Outliers to Remove ({analysis.outliers.length})
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxHeight: '400px', overflowY: 'auto', paddingRight: '0.5rem' }}>
            {analysis.outliers.map(o => (
              <div key={o.track.id} className="glass-panel" style={{ padding: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ overflow: 'hidden' }}>
                  <p style={{ margin: 0, fontWeight: 'bold', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.track.name}</p>
                  <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{o.track.artists[0].name} • {o.year} • {formatTime(o.duration)}</p>
                </div>
              </div>
            ))}
            {analysis.outliers.length === 0 && <p style={{ color: 'var(--text-secondary)' }}>No outliers found! Your playlist is cohesive.</p>}
          </div>
        </div>

        <div>
          <h3 style={{ color: 'var(--accent-green)', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Check size={20} /> Fits to Add ({analysis.fits.length})
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxHeight: '400px', overflowY: 'auto', paddingRight: '0.5rem' }}>
            {analysis.fits.map(f => (
              <div key={f.track.id} className="glass-panel" style={{ padding: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ overflow: 'hidden' }}>
                  <p style={{ margin: 0, fontWeight: 'bold', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.track.name}</p>
                  <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{f.track.artists[0].name} • {f.year} • {formatTime(f.duration)}</p>
                </div>
              </div>
            ))}
            {analysis.fits.length === 0 && <p style={{ color: 'var(--text-secondary)' }}>No suitable suggestions found in your master pools.</p>}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', marginTop: '2rem', paddingTop: '2rem', borderTop: '1px solid var(--glass-border)' }}>
        <button 
          className="btn-primary" 
          style={{ fontSize: '1.2rem', padding: '1rem 2rem' }}
          onClick={handleCommit}
          disabled={analysis.outliers.length === 0 && analysis.fits.length === 0}
        >
          <AlertCircle size={24} style={{ marginRight: '0.5rem' }} />
          Export to New Playlists
        </button>
      </div>
    </div>
  );
}
