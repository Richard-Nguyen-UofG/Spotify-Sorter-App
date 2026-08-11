import { useEffect, useState } from 'react';
import { redirectToAuthCodeFlow, getAccessToken, setToken, getToken, removeToken } from './lib/spotify';
import { Disc3, LogIn, LogOut } from 'lucide-react';
import './index.css';

import Dashboard from './components/Dashboard';

function App() {
  const [token, setTokenState] = useState(null);
  const [loading, setLoading] = useState(true);
  
  const clientId = import.meta.env.VITE_SPOTIFY_CLIENT_ID;

  useEffect(() => {
    const initializeAuth = async () => {
      // Check local storage for token first
      let currentToken = getToken();
      
      if (currentToken) {
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
        <div className="glass-panel animate-fade-in" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '3rem' }}>
          <Disc3 size={64} color="var(--accent-green)" style={{ marginBottom: '1.5rem' }} />
          <h1>Spotify Sorter</h1>
          <p>Analyze your playlists, find outliers, and curate your perfect vibe using advanced audio features.</p>
          <button onClick={handleLogin} className="btn-primary">
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
        <button className="btn-secondary" onClick={handleLogout} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <LogOut size={16} />
          Logout
        </button>
      </header>
      
      <main>
        <Dashboard />
      </main>

      <footer style={{ textAlign: 'center', padding: '2rem 0', opacity: 0.7, fontSize: '0.9rem' }}>
        Powered by <a href="https://getsongbpm.com/" target="_blank" rel="noreferrer" style={{ color: 'var(--accent-green)', textDecoration: 'none' }}>GetSongBPM</a>
      </footer>
    </div>
  );
}

export default App;
