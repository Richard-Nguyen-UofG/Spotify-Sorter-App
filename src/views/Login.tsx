import { useState } from 'react';
import { api, errorText, type Status } from '../api';

export default function Login({ status, onChanged }: { status: Status; onChanged: () => Promise<void> }) {
  const [clientId, setClientId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saveClientId = async () => {
    setError(null);
    try {
      await api.setClientId(clientId);
      await onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const login = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.login();
      await onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-card">
        <h1>Spotify Sorter</h1>
        <p className="muted">File your finished Liked Songs into the right playlists, then unlike them in one go.</p>

        {!status.hasClientId ? (
          <>
            <label className="field">
              <span>Spotify Client ID</span>
              <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="From developer.spotify.com/dashboard" />
            </label>
            <button onClick={saveClientId} disabled={!clientId.trim()}>Save</button>
          </>
        ) : (
          <>
            <ol className="steps">
              <li>
                In your app on the Spotify Developer Dashboard (developer.spotify.com/dashboard),
                add this Redirect URI: <code>{status.redirectUri}</code>
              </li>
              <li>Click Connect. Your browser opens Spotify's login; approve it and come back here.</li>
            </ol>
            {busy ? (
              <div className="login-wait">
                <span className="muted">Waiting for you to approve in the browser…</span>
                <button className="ghost" onClick={() => api.cancelLogin()}>Cancel</button>
              </div>
            ) : (
              <button onClick={login}>Connect with Spotify</button>
            )}
            <p className="muted small">
              If Spotify shows <strong>redirect_uri: Not matching configuration</strong>, the Redirect URI above isn't
              saved in your dashboard yet. Add it exactly as shown, click Save at the bottom of the settings page,
              then try again.
            </p>
          </>
        )}
        {error && <p className="error-text">{error}</p>}
      </div>
    </div>
  );
}
