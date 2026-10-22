import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText, type ExplorePick, type Match, type Playlist, type Track } from '../api';
import Player from './Player';

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
  sound: { title: 'Sounds like it', note: 'other artists, by audio, lyrics and genre; worth a listen' },
  artist: { title: 'By artists already in it', note: 'more songs by the same artists' },
  misfit: { title: 'Least like the rest', note: 'worst fit first; give them a listen before removing' },
};

const TARGET_KINDS = new Set(['vibe', 'pool', 'exercise', 'idea', 'gold', 'gold_all']);
const KIND_ORDER = ['vibe', 'idea', 'exercise', 'pool', 'gold_all', 'gold'];

const artistsOf = (t: Track) => t.artists.map((a) => a.name).join(', ');

function SearchablePlaylistSelect({
  playlists,
  value,
  onChange,
  placeholder = 'Search or choose a playlist…',
}: {
  playlists: Playlist[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(() => playlists.find((p) => p.id === value), [playlists, value]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return playlists;
    return playlists.filter((p) => p.name.toLowerCase().includes(q));
  }, [playlists, filter]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setFilter('');
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const handleSelect = (id: string) => {
    onChange(id);
    setOpen(false);
    setFilter('');
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange('');
    setFilter('');
    inputRef.current?.focus();
  };

  return (
    <div className="playlist-picker" ref={wrapRef}>
      <div className="playlist-picker-input-wrap">
        <input
          ref={inputRef}
          type="text"
          placeholder={selected ? `${selected.name} (${selected.total})` : placeholder}
          value={open ? filter : (selected ? `${selected.name} (${selected.total})` : '')}
          onChange={(e) => {
            setFilter(e.target.value);
            if (!open) setOpen(true);
          }}
          onFocus={() => {
            setOpen(true);
            setFilter('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setOpen(false);
              setFilter('');
            } else if (e.key === 'Enter' && open && filtered.length > 0) {
              e.preventDefault();
              handleSelect(filtered[0].id);
            }
          }}
        />
        {value && !open && (
          <button type="button" className="playlist-picker-clear" onClick={handleClear} title="Clear selection">
            ×
          </button>
        )}
        <button
          type="button"
          className="playlist-picker-chevron"
          onClick={() => {
            setOpen((o) => !o);
            if (!open) {
              setFilter('');
              inputRef.current?.focus();
            }
          }}
          title={open ? 'Close' : 'Open playlist list'}
        >
          {open ? '▴' : '▾'}
        </button>
      </div>

      {open && (
        <ul className="playlist-picker-dropdown">
          {filtered.length === 0 ? (
            <li className="playlist-picker-empty">No matching playlists</li>
          ) : (
            filtered.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className={p.id === value ? 'active' : ''}
                  onClick={() => handleSelect(p.id)}
                >
                  <span className="ellipsis">{p.name}</span>
                  <span className="muted small">({p.total})</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

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
  // Result sections the user folded away; kept across searches.
  const [collapsed, setCollapsed] = useState<Set<Match['group']>>(new Set());

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

  // What produced the current results, for logging picks (seeds can change after a search).
  const searched = useRef<{ mode: Mode; source: string | null }>({ mode: 'grow', source: null });
  const picksFor = (ids: string[]): ExplorePick[] =>
    ids.flatMap((id) => {
      const m = results?.find((r) => r.track.id === id);
      if (!m) return [];
      const group = results!.filter((r) => r.group === m.group);
      return [{
        trackId: id, mode: searched.current.mode, source: searched.current.source, group: m.group,
        rank: group.indexOf(m) + 1, groupSize: group.length,
      }];
    });

  const run = async () => {
    setLoading(true);
    setSelected(new Set());
    setConfirmRemove(false);
    searched.current = { mode, source: mode === 'seeds' ? JSON.stringify(seeds.map((s) => s.id)) : playlistId };
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
      const n = await api.addTracks(id, ids, picksFor(ids));
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
      const n = await api.removeTracks(playlistId, ids, picksFor(ids));
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
    const defaultName = seeds[0]?.name
      ? (seeds.length === 1 ? `Similar to ${seeds[0].name}` : `${seeds[0].name} & more – Similar`)
      : 'New Playlist';
    const nameToUse = newName.trim() || defaultName;
    setBusy(true);
    try {
      await api.createPlaylist(nameToUse, ids, picksFor([...selected]));
      onNotice(`Created “${nameToUse}” with ${ids.length} song${ids.length === 1 ? '' : 's'}. It's under Random Ideas; recategorise it on the Playlists tab if needed.`);
      setNewName('');
      setSelected(new Set());
      await onChanged();
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const createFromGroup = async (group: Match['group']) => {
    const groupItems = results?.filter((m) => m.group === group) ?? [];
    if (groupItems.length === 0) return;

    const selectedInGroup = groupItems.filter((m) => selected.has(m.track.id)).map((m) => m.track.id);
    const matchIds = selectedInGroup.length > 0 ? selectedInGroup : groupItems.map((m) => m.track.id);
    const ids = mode === 'seeds'
      ? Array.from(new Set([...seeds.map((s) => s.id), ...matchIds]))
      : matchIds;

    let newPlaylistName = '';
    if (mode === 'seeds') {
      const seedLabel = seeds[0]?.name ? (seeds.length === 1 ? `Similar to ${seeds[0].name}` : `${seeds[0].name} & more`) : 'Picks';
      const groupLabel = group === 'sound' ? 'Sounds like it' : 'By artists in it';
      newPlaylistName = `${seedLabel} – ${groupLabel}`;
    } else if (group === 'misfit') {
      const sourceName = byId.get(playlistId)?.name ?? 'Playlist';
      newPlaylistName = `${sourceName} – Misfits`;
    } else {
      const sourceName = byId.get(playlistId)?.name ?? 'Playlist';
      const groupLabel = group === 'sound' ? 'Sounds like it' : 'By artists in it';
      newPlaylistName = `${sourceName} – ${groupLabel}`;
    }

    setBusy(true);
    try {
      await api.createPlaylist(newPlaylistName, ids, picksFor(ids));
      onNotice(`Created “${newPlaylistName}” with ${ids.length} song${ids.length === 1 ? '' : 's'}. It's under Random Ideas; recategorise it on the Playlists tab if needed.`);
      await onChanged();
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const canRun = mode === 'seeds' ? seeds.length > 0 : !!playlistId;
  const current = MODES.find((m) => m.value === mode)!;
  // Sound-alikes first: they're the songs you wouldn't find by browsing an artist.
  const groups = (['sound', 'artist', 'misfit'] as const)
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
            <SearchablePlaylistSelect
              playlists={targets}
              value={playlistId}
              onChange={setPlaylistId}
              placeholder={mode === 'grow' ? 'Search a playlist to grow…' : 'Search a playlist for misfits…'}
            />
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
          const open = !collapsed.has(group);
          return (
            <section key={group} className="result-group">
              <div className="group-header-row">
                <h3>
                  <button className="group-toggle" aria-expanded={open}
                    onClick={() => setCollapsed((c) => {
                      const next = new Set(c);
                      if (open) next.add(group);
                      else next.delete(group);
                      return next;
                    })}>
                    <span className="chevron" aria-hidden>{open ? '▾' : '▸'}</span>
                    {GROUP_TITLES[group].title} ({items.length})
                    <span className="muted small">{GROUP_TITLES[group].note}</span>
                  </button>
                </h3>
                <button
                  type="button"
                  className="ghost small"
                  onClick={(e) => {
                    e.stopPropagation();
                    void createFromGroup(group);
                  }}
                  disabled={busy}
                  title={`Create a new playlist from ${items.length} songs`}
                >
                  Create playlist
                </button>
              </div>
              {open && items.map((m) => (
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
                    <Player trackId={m.track.id} onError={onError} />
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
            <>
              {groups.some((g) => g.group === 'sound') && (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void createFromGroup('sound')}
                  disabled={busy}
                  title="Create a new playlist from songs that sound like this playlist"
                >
                  Create “Sounds like it” playlist ({(() => {
                    const soundItems = results?.filter((m) => m.group === 'sound') ?? [];
                    const sel = soundItems.filter((m) => selected.has(m.track.id)).length;
                    return sel > 0 ? `${sel} selected` : soundItems.length;
                  })()})
                </button>
              )}
              {groups.some((g) => g.group === 'artist') && (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void createFromGroup('artist')}
                  disabled={busy}
                  title="Create a new playlist from songs by artists already in this playlist"
                >
                  Create “By artists in it” playlist ({(() => {
                    const artistItems = results?.filter((m) => m.group === 'artist') ?? [];
                    const sel = artistItems.filter((m) => selected.has(m.track.id)).length;
                    return sel > 0 ? `${sel} selected` : artistItems.length;
                  })()})
                </button>
              )}
              <button onClick={() => addTo(playlistId)} disabled={busy || selected.size === 0}>
                Add {selected.size} to {byId.get(playlistId)?.name}
              </button>
            </>
          )}
          {mode === 'misfits' && (
            <>
              {groups.some((g) => g.group === 'misfit') && (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void createFromGroup('misfit')}
                  disabled={busy}
                  title="Create a new playlist from these misfit songs"
                >
                  Create “Misfits” playlist ({(() => {
                    const misfitItems = results?.filter((m) => m.group === 'misfit') ?? [];
                    const sel = misfitItems.filter((m) => selected.has(m.track.id)).length;
                    return sel > 0 ? `${sel} selected` : misfitItems.length;
                  })()})
                </button>
              )}
              <button className={confirmRemove ? 'danger' : 'ghost'} onClick={remove} disabled={busy || selected.size === 0}>
                {confirmRemove ? `Click again to remove ${selected.size} from Spotify` : `Remove ${selected.size} from ${byId.get(playlistId)?.name}`}
              </button>
            </>
          )}
          {mode === 'seeds' && (
            <>
              {groups.some((g) => g.group === 'sound') && (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void createFromGroup('sound')}
                  disabled={busy}
                  title="Create a new playlist from seeds and songs that sound like them"
                >
                  Create “Sounds like it” playlist ({(() => {
                    const soundItems = results?.filter((m) => m.group === 'sound') ?? [];
                    const sel = soundItems.filter((m) => selected.has(m.track.id)).length;
                    return (sel > 0 ? sel : soundItems.length) + seeds.length;
                  })()})
                </button>
              )}
              {groups.some((g) => g.group === 'artist') && (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void createFromGroup('artist')}
                  disabled={busy}
                  title="Create a new playlist from seeds and songs by the same artists"
                >
                  Create “By artists in it” playlist ({(() => {
                    const artistItems = results?.filter((m) => m.group === 'artist') ?? [];
                    const sel = artistItems.filter((m) => selected.has(m.track.id)).length;
                    return (sel > 0 ? sel : artistItems.length) + seeds.length;
                  })()})
                </button>
              )}
              <select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                <option value="">Add to playlist…</option>
                {targets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <button className="ghost" onClick={() => addTo(targetId)} disabled={busy || !targetId || selected.size === 0}>Add</button>
              <span className="muted small">or</span>
              <input
                placeholder={seeds[0]?.name ? `Similar to ${seeds[0].name}` : "New playlist name"}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
              <button onClick={create} disabled={busy}
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
