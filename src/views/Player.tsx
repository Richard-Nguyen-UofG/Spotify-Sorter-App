import { useEffect, useState } from 'react';
import { api, onSpotifyWebLogin } from '../api';

// The app's browser engine starts signed out of Spotify, so embeds play 30 s previews with a
// "Get Spotify" banner until the user signs in once (Spotify keeps that sign-in in the app).
const SIGNED_IN_KEY = 'spotifyWebSignedIn';

function signedIn(): boolean {
  try {
    return localStorage.getItem(SIGNED_IN_KEY) === '1';
  } catch {
    return false;
  }
}

/** Spotify's track player, with a one-time offer to sign in for full-length playback. */
export default function Player({ trackId, onError }: { trackId: string; onError: (e: unknown) => void }) {
  const [hint, setHint] = useState(!signedIn());
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const unlisten = onSpotifyWebLogin(() => {
      try {
        localStorage.setItem(SIGNED_IN_KEY, '1');
      } catch { /* the hint just shows again next time */ }
      setHint(false);
      setReload((n) => n + 1); // reload the embed so it picks up the sign-in
    });
    return () => void unlisten.then((f) => f());
  }, []);

  return (
    <>
      <iframe key={reload} className="player" title="Spotify player" src={`https://open.spotify.com/embed/track/${trackId}?theme=0`}
        allow="encrypted-media; clipboard-write" loading="lazy" />
      {hint && (
        <div className="player-hint small muted">
          Only hearing 30 s previews?{' '}
          <button className="link" onClick={() => api.spotifyWebLogin().catch(onError)}>Sign in to Spotify in the app</button>
          {' '}once for full songs.
        </div>
      )}
    </>
  );
}
