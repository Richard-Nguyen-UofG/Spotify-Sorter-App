import { useEffect, useState } from 'react';
import { redirectToAuthCodeFlow, getAccessToken, setToken, getToken, isTokenExpired, refreshAccessToken, removeToken } from './lib/spotify';
import { getAllTracks, onDatabaseChange, initDatabase } from './lib/acousticDatabase';
import LibraryManagerModal from './components/LibraryManagerModal';
import { Disc3, LogIn, LogOut, Database } from 'lucide-react';
import './index.css';

import Dashboard from './components/Dashboard';

function App() {
  const [token, setTokenState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showLibraryModal, setShowLibraryModal] = useState(false);
  const [storedTrackCount, setStoredTrackCount] = useState(0);
  
  const clientId = import.meta.env.VITE_SPOTIFY_CLIENT_ID;

  useEffect(() => {
    // Initialize database and subscribe to count changes
    const updateCount = () => {
      setStoredTrackCount(getAllTracks().length);
    };

    initDatabase().then(updateCount);

    const unsubscribe = onDatabaseChange(updateCount);
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const initializeAuth = async () => {
      // If the configured client ID changed, invalidate old tokens so a fresh token is acquired
      const previousClientId = localStorage.getItem('spotify_client_id_used');
      if (previousClientId && previousClientId !== clientId) {
        removeToken();
        localStorage.removeItem('spotify_cached_user_playlists');
      }
      localStorage.setItem('spotify_client_id_used', clientId);

      // Check local storage for token first
      let currentToken = getToken();
      
      if (currentToken) {
        if (isTokenExpired()) {
          try {
            currentToken = await refreshAccessToken(clientId) || currentToken;
          } catch (e) {
            console.warn("Silent token refresh failed on startup:", e);
          }
        }
        setTokenState(currentToken);
        setLoading(false);
        return;
      }

      // If no token in local storage, check URL for code
      const params = new URLSearchParams(window.location.search);
      const code = params.get("code");

      if (code) {
        try {
          const accessToken = await getAccessToken(clientId, code);
          if (accessToken) {
            setToken(accessToken);
            setTokenState(accessToken);
          }
        } catch (e) {
          console.error("Error fetching access token", e);
        }
        // Clean URL
        window.history.replaceState({}, document.title, "/");
      }
      setLoading(false);
    };

    initializeAuth();
  }, [clientId]);

  const handleLogin = () => {
    redirectToAuthCodeFlow(clientId);
  };

  const handleLogout = () => {
    removeToken();
    setTokenState(null);
  };

  if (loading) {
    return <div className="login-screen"><h2>Loading...</h2></div>;
  }

  if (!token) {
    return (
      <div className="login-screen">
        <div className="glass-panel animate-fade-in" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '3rem', maxWidth: '480px', textAlign: 'center' }}>
          <Disc3 size={64} color="var(--accent-green)" style={{ marginBottom: '1.5rem' }} />
          <h1>Spotify Sorter</h1>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '2rem' }}>
            Harmonically mix, analyze vibe profiles, and organize your Spotify library with Camelot keys, BPM, energy metrics, and IndexedDB local storage.
          </p>
          <button onClick={handleLogin} className="btn-primary" style={{ padding: '0.8rem 1.8rem', fontSize: '1rem' }}>
            <LogIn size={20} />
            Connect with Spotify
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container animate-fade-in">
      <header className="app-header">
        <div className="logo-container">
          <Disc3 size={32} color="var(--accent-green)" />
          <span>Spotify Sorter</span>
        </div>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button 
            className="btn-secondary" 
            onClick={() => setShowLibraryModal(true)}
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', backgroundColor: 'rgba(0, 212, 255, 0.12)', borderColor: 'rgba(0, 212, 255, 0.4)' }}
          >
            <Database size={16} color="#00d4ff" />
            <span>Acoustic Library</span>
            {storedTrackCount > 0 && (
              <span style={{ 
                backgroundColor: '#00d4ff', 
                color: '#000', 
                borderRadius: '10px', 
                padding: '1px 6px', 
                fontSize: '0.75rem', 
                fontWeight: 'bold' 
              }}>
                {storedTrackCount}
              </span>
            )}
          </button>

          <button className="btn-secondary" onClick={handleLogout} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <LogOut size={16} />
            Logout
          </button>
        </div>
      </header>
      
      <main>
        <Dashboard onOpenLibrary={() => setShowLibraryModal(true)} />
      </main>

      <footer style={{ textAlign: 'center', padding: '2rem 0', opacity: 0.7, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
        Acoustic Analysis Powered by <a href="https://rapidapi.com/musicae-musicae-default/api/spotify-extended-audio-features-api" target="_blank" rel="noreferrer" style={{ color: '#00d4ff', textDecoration: 'none' }}>Musicae.io</a> • Local IndexedDB Database
      </footer>

      {/* Acoustic Library Manager Modal */}
      <LibraryManagerModal 
        isOpen={showLibraryModal} 
        onClose={() => setShowLibraryModal(false)} 
      />
    </div>
  );
}

export default App;
