import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api, errorText, isLoginError, onMlProgress, onSyncProgress,
  type Playlist, type QueueItem, type Status, type SyncProgress,
} from './api';
import Login from './views/Login';
import Sort from './views/Sort';
import Playlists from './views/Playlists';
import Explore from './views/Explore';

type Tab = 'sort' | 'explore' | 'playlists';

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [tab, setTab] = useState<Tab>('sort');
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mlRunning, setMlRunning] = useState(false);
  const [mlProgress, setMlProgress] = useState<SyncProgress | null>(null);
  const [mlVersion, setMlVersion] = useState(0);
  const [deferred, setDeferred] = useState<{ count: number; requests: number } | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.status());
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  const loadData = useCallback(async () => {
    const [p, q] = await Promise.all([api.playlists(), api.queue()]);
    setPlaylists(p);
    setQueue(q);
  }, []);

  const reportError = useCallback((e: unknown) => {
    setError(errorText(e).replace(/^NOT_LOGGED_IN: /, ''));
    if (isLoginError(e)) void refreshStatus();
  }, [refreshStatus]);

  // Audio/lyrics analysis of new songs; runs after each sync when ml/ is set up.
  // A change made while an analysis is running gets its own run once that one finishes.
  const mlRerun = useRef(false);
  const runMlRef = useRef<() => Promise<void>>(async () => {});
  const runMl = useCallback(async () => {
    const s = await api.status().catch(() => null);
    if (!s?.mlAvailable) return;
    if (s.mlRunning) {
      mlRerun.current = true;
      return;
    }
    setMlRunning(true);
    try {
      await api.runMl();
      setMlVersion((v) => v + 1);
    } catch (e) {
      reportError(e);
    } finally {
      setMlRunning(false);
      setMlProgress(null);
      void refreshStatus();
      if (mlRerun.current) {
        mlRerun.current = false;
        setTimeout(() => void runMlRef.current(), 1000);
      }
    }
  }, [refreshStatus, reportError]);
  runMlRef.current = runMl;

  // Category edits come in bursts; recompute sound-alike scores once, shortly after the last one.
  const categoryTimer = useRef<number | null>(null);
  const onCategoriesChanged = useCallback(() => {
    if (categoryTimer.current) clearTimeout(categoryTimer.current);
    categoryTimer.current = window.setTimeout(() => {
      categoryTimer.current = null;
      void runMlRef.current();
    }, 4000);
  }, []);

  const syncRunning = useRef(false);
  const sync = useCallback(async (force = false, allowLarge = false) => {
    if (syncRunning.current) return;
    syncRunning.current = true;
    setSyncing(true);
    setError(null);
    try {
      const s = await api.sync(force, allowLarge);
      await loadData();
      const full = s.playlistsDownloaded - s.playlistsToppedUp;
      setNotice(
        `Synced: ${full} playlist${full === 1 ? '' : 's'} downloaded` +
        (s.playlistsToppedUp ? `, ${s.playlistsToppedUp} topped up with new songs` : '') +
        `, ${s.liked} liked songs, ${s.apiCalls} API calls.`,
      );
      setDeferred(s.playlistsDeferred ? { count: s.playlistsDeferred, requests: s.deferredRequests } : null);
      void runMl();
    } catch (e) {
      reportError(e);
      await loadData().catch(() => {});
    } finally {
      syncRunning.current = false;
      setSyncing(false);
      setProgress(null);
      void refreshStatus();
    }
  }, [loadData, refreshStatus, reportError, runMl]);

  useEffect(() => {
    void refreshStatus();
    const unlistenSync = onSyncProgress(setProgress);
    const unlistenMl = onMlProgress(setMlProgress);
    return () => {
      void unlistenSync.then((f) => f());
      void unlistenMl.then((f) => f());
    };
  }, [refreshStatus]);

  const ready = !!status?.loggedIn && !!status.hasClientId;
  useEffect(() => {
    if (!ready) return;
    // Show what's cached right away, then catch up with Spotify (unless it asked for a pause:
    // a request during the pause would restart its timer).
    void loadData().catch(reportError).then(async () => {
      const s = await api.status().catch(() => null);
      if (s?.cooldownSecs) {
        setNotice(`Spotify asked for a pause; syncing is held for another ${s.cooldownSecs} s.`);
        return;
      }
      await sync(false);
    });
  }, [ready, loadData, sync, reportError]);

  const unsortedCount = useMemo(
    () => playlists.filter((p) => p.owned && p.kind === 'unsorted').length,
    [playlists],
  );
  const pendingQueue = queue.filter((q) => !q.staged).length;

  if (!status) return <div className="splash">Loading…</div>;
  if (!ready) return <Login status={status} onChanged={refreshStatus} />;

  const logout = async () => {
    await api.logout();
    await refreshStatus();
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>≡</span> Spotify Sorter
        </div>
        <nav className="tabs">
          <button className={tab === 'sort' ? 'active' : ''} onClick={() => setTab('sort')}>
            Weekly sort <span className="count">{pendingQueue}</span>
          </button>
          <button className={tab === 'explore' ? 'active' : ''} onClick={() => setTab('explore')}>
            Explore
          </button>
          <button className={tab === 'playlists' ? 'active' : ''} onClick={() => setTab('playlists')}>
            Playlists {unsortedCount > 0 && <span className="count warn">{unsortedCount}</span>}
          </button>
        </nav>
        <div className="topbar-right">
          {status.mlAvailable && (
            mlRunning ? (
              <span className="muted small ml-status" title="Analysing audio and lyrics of new songs">
                {mlProgress?.message ?? 'Analysing audio…'}
              </span>
            ) : (
              <button className="ghost small" onClick={() => void runMl()}
                title={status.mlTrainedAt
                  ? `Audio model last trained ${new Date(status.mlTrainedAt).toLocaleString()}. Click to analyse new songs and retrain.`
                  : 'Analyse your songs’ audio and lyrics to improve suggestions'}>
                Analyse audio
              </button>
            )
          )}
          <span className="muted small" title="Spotify Web API requests made by this app today">
            {status.apiCallsToday} API calls today
          </span>
          <button className="ghost" onClick={() => sync(false)} disabled={syncing}
            title="Check Spotify for changes (only changed playlists are downloaded)">
            {syncing ? 'Syncing…' : 'Sync'}
          </button>
          <span className="muted small">{status.displayName}</span>
          <button className="ghost" onClick={logout}>Log out</button>
        </div>
      </header>

      {syncing && progress && (
        <div className="progress">
          <div className="progress-bar" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 5}%` }} />
          <span>{progress.message}{progress.total > 1 ? ` (${progress.done + 1}/${progress.total})` : ''}</span>
        </div>
      )}
      {error && (
        <div className="banner error">
          <span>{error}</span>
          <button className="ghost small" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}
      {notice && !error && (
        <div className="banner info">
          <span>{notice}</span>
          <button className="ghost small" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}
      {deferred && !syncing && (
        <div className="banner warn">
          <span>
            {deferred.count} changed playlist{deferred.count === 1 ? ' was' : 's were'} left for later to keep this sync
            small (about {deferred.requests} more Spotify requests). The next syncs will catch up, or download them now.
          </span>
          <button className="small" onClick={() => void sync(false, true)}>Download now</button>
        </div>
      )}
      {status.missingScopes.length > 0 && (
        <div className="banner warn">
          <span>
            Spotify hasn't granted all the permissions this version needs ({status.missingScopes.join(', ')}).
            Reconnect once to approve them; your data stays as it is.
          </span>
          <button className="small" onClick={logout}>Reconnect</button>
        </div>
      )}
      {tab === 'sort' && unsortedCount > 0 && (
        <div className="banner warn">
          <span>
            {unsortedCount} playlist{unsortedCount === 1 ? ' has' : 's have'} no category yet. Spotify doesn't share
            folders, so tell the app which are vibe, exercise or idea playlists once and suggestions get much better.
          </span>
          <button className="small" onClick={() => setTab('playlists')}>Set up playlists</button>
        </div>
      )}

      <main className="content">
        {tab === 'sort' ? (
          <Sort
            playlists={playlists}
            queue={queue}
            canRevert={status.canRevert}
            stats={status.suggestionStats}
            refreshKey={mlVersion}
            onChanged={async () => { await loadData(); await refreshStatus(); }}
            onError={reportError}
            onNotice={setNotice}
          />
        ) : tab === 'explore' ? (
          <Explore
            playlists={playlists}
            analysed={status.mlSongs > 0}
            onChanged={async () => { await loadData(); await refreshStatus(); }}
            onError={reportError}
            onNotice={setNotice}
          />
        ) : (
          <Playlists playlists={playlists} onSaved={setPlaylists} onError={reportError}
            onCategoriesChanged={onCategoriesChanged} />
        )}
      </main>
    </div>
  );
}
