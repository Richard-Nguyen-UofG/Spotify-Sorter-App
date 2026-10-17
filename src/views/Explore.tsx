import { useEffect, useMemo, useState } from 'react';
import { api, errorText, type Match, type Playlist, type Track } from '../api';

type Mode = 'grow' | 'misfits' | 'seeds';

interface Props {
  playlists: Playlist[];
  /** Whether the audio analysis has run at least once. */
  analysed: boolean;
  onChanged: () => Promise<void>;
  onError: (e: unknown) => void;
  onNotice: (text: string) => void;
}

const MODES: { value: Mode; label: string; help: string }[] = [
  { value: 'grow', label: 'Grow a playlist', help: 'Songs you already have that sound like this playlist but aren’t in it.' },
  { value: 'misfits', label: 'Find misfits', help: 'Songs in this playlist that sound least like the rest of it.' },
  { value: 'seeds', label: 'From a few songs', help: 'Pick a few songs and find more of yours like them, e.g. to start a new Random Idea.' },
];

const GROUP_TITLES: Record<Match['group'], { title: string; note: string }> = {
  artist: { title: 'By artists already in it', note: 'the most reliable picks' },
  sound: { title: 'Sounds like it', note: 'other artists, by audio and lyrics; hit-and-miss, treat as ideas' },
  misfit: { title: 'Least like the rest', note: 'worst fit first; give them a listen before removing' },
};

const TARGET_KINDS = new Set(['vibe', 'pool', 'exercise', 'idea', 'gold', 'gold_all']);
const KIND_ORDER = ['vibe', 'idea', 'exercise', 'pool', 'gold_all', 'gold'];

const artistsOf = (t: Track) => t.artists.map((a) => a.name).join(', ');

export default function Explore({ playlists, analysed, onChanged, onError, onNotice }: Props) {
  const [mode, setMode] = useState<Mode>('grow');
  const [playlistId, setPlaylistId] = useState('');
  const [includeInternal, setIncludeInternal] = useState(false);
  const [results, setResults] = useState<Match[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  // "From a few songs"
  const [seeds, setSeeds] = useState<Track[]>([]);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<Track[]>([]);
  const [targetId, setTargetId] = useState('');
  const [newName, setNewName] = useState('');

  const targets = useMemo(
    () => playlists
      .filter((p) => p.owned && TARGET_KINDS.has(p.kind))
      .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name)),
    [playlists],
  );
  const byId = useMemo(() => new Map(playlists.map((p) => [p.id, p])), [playlists]);

  useEffect(() => {
    setResults(null);
    setSelected(new Set());
    setConfirmRemove(false);
  }, [mode, playlistId]);

  useEffect(() => {
    if (mode !== 'seeds' || !query.trim()) {
      setFound([]);
      return;
    }
    const handle = setTimeout(() => {
      api.searchLibrary(query).then(setFound).catch(onError);
    }, 200);
    return () => clearTimeout(handle);
  }, [query, mode, onError]);

  const run = async () => {
    setLoading(true);
    setSelected(new Set());
    setConfirmRemove(false);
    try {
      if (mode === 'grow') setResults(await api.exploreGrow(playlistId, includeInternal));
      else if (mode === 'misfits') setResults(await api.exploreMisfits(playlistId));
      else setResults(await api.exploreSimilar(seeds.map((s) => s.id), includeInternal));
    } catch (e) {
      onError(e);
      setResults(null);
    } finally {
      setLoading(false);
    }
  };

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const afterChange = async (message: string, removed: Set<string>) => {
    onNotice(message);
    setResults((r) => r?.filter((m) => !removed.has(m.track.id)) ?? null);
    setSelected(new Set());
    await onChanged();
  };

  const addTo = async (id: string) => {
    const ids = [...selected];
    setBusy(true);
    try {
      const n = await api.addTracks(id, ids);
      await afterChange(`Added ${n} song${n === 1 ? '' : 's'} to ${byId.get(id)?.name ?? 'the playlist'}.`, new Set(ids));
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    const ids = [...selected];
    setBusy(true);
    try {
      const n = await api.removeTracks(playlistId, ids);
      await afterChange(`Removed ${n} song${n === 1 ? '' : 's'} from ${byId.get(playlistId)?.name}.`, new Set(ids));
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
      setConfirmRemove(false);
    }
  };

  const create = async () => {
    const ids = [...seeds.map((s) => s.id), ...selected];
    setBusy(true);
    try {
      await api.createPlaylist(newName, ids);
      onNotice(`Created “${newName.trim()}” with ${ids.length} songs. It's under Random Ideas; recategorise it on the Playlists tab if needed.`);
      setNewName('');
      setSelected(new Set());
      await onChanged();
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const canRun = mode === 'seeds' ? seeds.length > 0 : !!playlistId;
  const current = MODES.find((m) => m.value === mode)!;
  const groups = (['artist', 'sound', 'misfit'] as const)
    .map((g) => ({ group: g, items: results?.filter((m) => m.group === g) ?? [] }))
    .filter((g) => g.items.length > 0);

  if (!analysed) {
    return (
      <div className="empty">
        <h2>Explore needs the audio analysis</h2>
        <p className="muted">Click <strong>Analyse audio</strong> in the top bar once; after that these tools work instantly.</p>
      </div>
    );
  }

  return (
    <div className="explore">
      <div className="explore-head">
        <div className="segmented">
          {MODES.map((m) => (
            <button key={m.value} className={mode === m.value ? 'active' : ''} onClick={() => setMode(m.value)}>
              {m.label}
            </button>
          ))}
        </div>
        <p className="muted small">{current.help}</p>

        <div className="explore-controls">
          {mode !== 'seeds' ? (
            <select value={playlistId} onChange={(e) => setPlaylistId(e.target.value)}>
              <option value="">Choose a playlist…</option>
              {targets.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.total})</option>)}
            </select>
          ) : (
            <div className="seed-picker">
              <input placeholder="Search your library by title or artist" value={query} onChange={(e) => setQuery(e.target.value)} />
              {found.length > 0 && (
                <ul className="seed-results">
                  {found.map((t) => (
                    <li key={t.id}>
                      <button className="link" onClick={() => {
                        setSeeds((s) => (s.some((x) => x.id === t.id) ? s : [...s, t]));
                        setQuery('');
                      }}>
                        {t.name} <span className="muted">– {artistsOf(t)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {mode !== 'misfits' && (
            <label className="check small" title="Also search songs that only made it into Internal (ones you didn't keep)">
              <input type="checkbox" checked={includeInternal} onChange={(e) => setIncludeInternal(e.target.checked)} />
              Include Internal-only songs
            </label>
          )}
          <button onClick={run} disabled={!canRun || loading}>{loading ? 'Searching…' : 'Find'}</button>
        </div>

        {mode === 'seeds' && seeds.length > 0 && (
          <div className="chips">
            {seeds.map((s) => (
              <button key={s.id} className="chip on" onClick={() => setSeeds((list) => list.filter((x) => x.id !== s.id))}
                title="Remove">
                {s.name} <span className="chip-note">×</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="explore-results">
        {results && results.length === 0 && <p className="muted">Nothing found.</p>}
        {groups.map(({ group, items }) => {
          const scores = items.map((m) => m.score);
          const [lo, hi] = [Math.min(...scores), Math.max(...scores)];
          return (
            <section key={group} className="result-group">
              <h3>
                {GROUP_TITLES[group].title}{' '}
                <span className="muted small">{GROUP_TITLES[group].note}</span>
              </h3>
              {items.map((m) => (
                <div key={m.track.id} className={`result${selected.has(m.track.id) ? ' selected' : ''}`}>
                  <div className="result-row">
                    <input type="checkbox" checked={selected.has(m.track.id)} onChange={() => toggle(m.track.id)} />
                    {m.track.imageUrl ? <img src={m.track.imageUrl} alt="" /> : <div className="art-blank" />}
                    <div className="result-text">
                      <span className="ellipsis">{m.track.name}</span>
                      <span className="ellipsis muted small">{artistsOf(m.track)}</span>
                    </div>
                    <div className="fit" title={group === 'misfit' ? 'Shorter = fits the playlist less' : 'Longer = stronger match'}>
                      <div className="fit-bar" style={{ width: `${hi > lo ? 15 + ((m.score - lo) / (hi - lo)) * 85 : 100}%` }} />
                    </div>
                    <span className="ellipsis muted small reason" title={m.reason}>{m.reason}</span>
                    <button className="ghost small" onClick={() => setPreview(preview === m.track.id ? null : m.track.id)}>
                      {preview === m.track.id ? 'Hide' : 'Play'}
                    </button>
                    <button className="ghost small" onClick={() => api.openInSpotify(m.track.uri).catch(onError)}>Spotify</button>
                  </div>
                  {preview === m.track.id && (
                    <iframe className="player" title="Spotify player" src={`https://open.spotify.com/embed/track/${m.track.id}?theme=0`}
                      allow="encrypted-media; clipboard-write" loading="lazy" />
                  )}
                </div>
              ))}
            </section>
          );
        })}
      </div>

      {results && results.length > 0 && (
        <div className="commit-bar">
          <span><strong>{selected.size}</strong> selected</span>
          <div className="spacer" />
          {mode === 'grow' && (
            <button onClick={() => addTo(playlistId)} disabled={busy || selected.size === 0}>
              Add {selected.size} to {byId.get(playlistId)?.name}
            </button>
          )}
          {mode === 'misfits' && (
            <button className={confirmRemove ? 'danger' : 'ghost'} onClick={remove} disabled={busy || selected.size === 0}>
              {confirmRemove ? `Click again to remove ${selected.size} from Spotify` : `Remove ${selected.size} from ${byId.get(playlistId)?.name}`}
            </button>
          )}
          {mode === 'seeds' && (
            <>
              <select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                <option value="">Add to playlist…</option>
                {targets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <button className="ghost" onClick={() => addTo(targetId)} disabled={busy || !targetId || selected.size === 0}>Add</button>
              <span className="muted small">or</span>
              <input placeholder="New playlist name" value={newName} onChange={(e) => setNewName(e.target.value)} />
              <button onClick={create} disabled={busy || !newName.trim()}
                title="Creates a private playlist with your picked songs plus the selected results">
                Create playlist
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
