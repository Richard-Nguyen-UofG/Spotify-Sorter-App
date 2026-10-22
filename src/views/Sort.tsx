import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText, type Mood, type Pace, type Playlist, type QueueItem, type Status, type TrackContext } from '../api';
import {
  autoIds, cellKey, cellScores, emptySelection, finalIds, fromStaged, MOODS, PACES, toggle, type Selection,
} from '../filing';
import Player from './Player';

interface Props {
  playlists: Playlist[];
  queue: QueueItem[];
  canRevert: boolean;
  stats: Status['suggestionStats'];
  /** Bumped when the audio model rescored songs, so suggestions reload. */
  refreshKey: number;
  onChanged: () => Promise<void>;
  onError: (e: unknown) => void;
  onNotice: (text: string) => void;
}

const PACE_LABEL: Record<Pace, string> = { high: 'High', med: 'Med', low: 'Low' };
const MOOD_LABEL: Record<Mood, string> = { positive: 'Positive', negative: 'Negative' };
// The Suggested row is vibe playlists only. Pools are ticked automatically with a vibe, exercise
// playlists have their own row and are easy to pick by hand, and Random Ideas are too loose to
// suggest; their chips only crowded out vibes. On a rolling quarterly hold-out, the share of the
// user's vibe picks among the 9 chips went 63% (all kinds) → 71% (no pools) → 77% (vibes only).
const SUGGESTABLE = new Set(['vibe']);

type SortOption = 'title' | 'recently_added' | 'artist' | 'album';
type SortDirection = 'asc' | 'desc';

interface SortState {
  option: SortOption;
  direction: SortDirection;
}

const SORT_OPTIONS: { id: SortOption; label: string }[] = [
  { id: 'title', label: 'Title' },
  { id: 'recently_added', label: 'Recently added' },
  { id: 'artist', label: 'Artist' },
  { id: 'album', label: 'Album' },
];

const DEFAULT_SORT: SortState = {
  option: 'recently_added',
  direction: 'desc',
};

const SORT_STORAGE_KEY = 'spotifySorterSort';

function loadSort(): SortState {
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const validOptions: SortOption[] = ['title', 'recently_added', 'artist', 'album'];
      const validDirs: SortDirection[] = ['asc', 'desc'];
      if (validOptions.includes(parsed?.option) && validDirs.includes(parsed?.direction)) {
        return { option: parsed.option, direction: parsed.direction };
      }
    }
  } catch {
    // fallback to default
  }
  return DEFAULT_SORT;
}

function saveSort(state: SortState) {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function isTyping(target: EventTarget | null) {
  return target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export default function Sort({ playlists, queue, canRevert, stats, refreshKey, onChanged, onError, onNotice }: Props) {
  const [sort, setSort] = useState<SortState>(loadSort);
  const [sortOpen, setSortOpen] = useState(false);
  const sortRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sortOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (sortRef.current && !sortRef.current.contains(e.target as Node)) {
        setSortOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSortOpen(false);
    };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [sortOpen]);

  const selectSort = (option: SortOption) => {
    setSort((prev) => {
      const next: SortState = {
        option,
        direction: prev.option === option
          ? (prev.direction === 'asc' ? 'desc' : 'asc')
          : (option === 'recently_added' ? 'desc' : 'asc'),
      };
      saveSort(next);
      return next;
    });
  };

  const sortedQueue = useMemo(() => {
    const items = [...queue];
    items.sort((a, b) => {
      let diff = 0;
      if (sort.option === 'recently_added') {
        diff = a.likedAt.localeCompare(b.likedAt);
        if (diff !== 0) return sort.direction === 'asc' ? diff : -diff;
      } else {
        let aText = '';
        let bText = '';
        if (sort.option === 'title') {
          aText = a.track.name;
          bText = b.track.name;
        } else if (sort.option === 'artist') {
          aText = a.track.artists[0]?.name ?? '';
          bText = b.track.artists[0]?.name ?? '';
        } else if (sort.option === 'album') {
          aText = a.track.album ?? '';
          bText = b.track.album ?? '';
        }
        diff = aText.toLowerCase().localeCompare(bText.toLowerCase());
        if (diff !== 0) return sort.direction === 'asc' ? diff : -diff;

        const dateDiff = a.likedAt.localeCompare(b.likedAt);
        if (dateDiff !== 0) return dateDiff;
      }
      return a.track.id.localeCompare(b.track.id);
    });
    return items;
  }, [queue, sort]);

  const byId = useMemo(() => new Map(playlists.map((p) => [p.id, p])), [playlists]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const current = sortedQueue.find((q) => q.track.id === currentId) ?? sortedQueue.find((q) => !q.staged) ?? sortedQueue[0] ?? null;

  const [ctx, setCtx] = useState<TrackContext | null>(null);
  const [sel, setSel] = useState<Selection>(emptySelection);
  const [unlike, setUnlike] = useState(true);
  const [focus, setFocus] = useState<{ mood: Mood; pace: Pace } | null>(null);
  const [showPlayer, setShowPlayer] = useState(true);
  const [showMore, setShowMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState(false);

  const currentTrackId = current?.track.id;
  useEffect(() => {
    if (!current) {
      setCtx(null);
      return;
    }
    let cancelled = false;
    api.context(current.track.id).then((c) => {
      if (cancelled) return;
      setCtx(c);
      setSel(current.staged ? fromStaged(current.staged, byId, c) : emptySelection());
      setUnlike(current.unlike);
      const best = cellScores(byId, c).reduce((a, b) => (b.score > a.score ? b : a));
      setFocus(best.score > 0 ? { mood: best.mood, pace: best.pace } : null);
    }).catch(onError);
    return () => { cancelled = true; };
    // Only reload when the song, the playlist set or the audio scores change, not on every queue refresh.
  }, [currentTrackId, byId, refreshKey]);

  const final = useMemo(() => (ctx ? finalIds(sel, byId, ctx) : new Set<string>()), [sel, byId, ctx]);
  const auto = useMemo(() => (ctx ? autoIds(sel.picked, byId, ctx) : new Set<string>()), [sel, byId, ctx]);
  const already = useMemo(() => new Set(ctx?.alreadyIn ?? []), [ctx]);

  const suggestions = useMemo(() => {
    if (!ctx) return [];
    return ctx.suggestions
      .filter((s) => SUGGESTABLE.has(byId.get(s.playlistId)?.kind ?? '') && !already.has(s.playlistId))
      .slice(0, 9);
  }, [ctx, byId, already]);

  const flip = useCallback((id: string | null | undefined) => {
    if (!id || !ctx || already.has(id)) return;
    setSel((s) => toggle(s, id, byId, ctx));
  }, [ctx, byId, already]);

  const goTo = useCallback((direction: 1 | -1, onlyUnstaged = false) => {
    if (!current) return;
    const start = sortedQueue.findIndex((q) => q.track.id === current.track.id);
    for (let i = start + direction; i >= 0 && i < sortedQueue.length; i += direction) {
      if (!onlyUnstaged || !sortedQueue[i].staged) {
        setCurrentId(sortedQueue[i].track.id);
        return;
      }
    }
  }, [current, sortedQueue]);

  const stageAndNext = useCallback(async () => {
    if (!current || !ctx) return;
    try {
      await api.stage(current.track.id, [...final], unlike, suggestions.map((s) => s.playlistId), ctx.audioAnalysed);
      goTo(1, true);
      await onChanged();
    } catch (e) {
      onError(e);
    }
  }, [current, ctx, final, unlike, suggestions, goTo, onChanged, onError]);

  const unstageCurrent = async () => {
    if (!current) return;
    try {
      await api.unstage(current.track.id);
      await onChanged();
    } catch (e) {
      onError(e);
    }
  };

  const stagedCount = queue.filter((q) => q.staged).length;

  const commit = async () => {
    setBusy(true);
    try {
      const r = await api.commit();
      onNotice(`Filed ${r.songs} song${r.songs === 1 ? '' : 's'}: ${r.additions} playlist additions, ${r.unliked} unliked.`);
    } catch (e) {
      onError(`Commit stopped part-way: ${errorText(e)} Anything not finished is still staged; commit again to retry.`);
    } finally {
      setBusy(false);
      await onChanged();
    }
  };

  const revert = async () => {
    if (!confirmRevert) {
      setConfirmRevert(true);
      setTimeout(() => setConfirmRevert(false), 4000);
      return;
    }
    setConfirmRevert(false);
    setBusy(true);
    try {
      const r = await api.revertLastCommit();
      onNotice(`Reverted ${r.songs} song${r.songs === 1 ? '' : 's'}: removed from ${r.additions} playlist slots, re-liked ${r.unliked}.`);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
      await onChanged();
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k >= '1' && k <= '9') flip(suggestions[Number(k) - 1]?.playlistId);
      else if (k === 'g') flip(ctx?.gold.playlistId);
      else if (k === 'u') setUnlike((u) => !u);
      else if (k === 'p') setShowPlayer((v) => !v);
      else if (k === 'enter') void stageAndNext();
      else if (k === 's' || k === 'arrowdown' || k === 'j') goTo(1);
      else if (k === 'arrowup' || k === 'k') goTo(-1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flip, suggestions, ctx, stageAndNext, goTo]);

  if (queue.length === 0) {
    return (
      <div className="empty">
        <h2>Liked Songs is empty</h2>
        <p className="muted">Nothing to sort. Like some songs in Spotify, then hit Sync.</p>
      </div>
    );
  }

  const chipState = (id: string) =>
    already.has(id) ? 'already' : final.has(id) ? (auto.has(id) && !sel.picked.has(id) ? 'auto' : 'on') : 'off';

  const chip = (p: Playlist | undefined, extra?: { num?: number; hint?: string }) =>
    p && (
      <Chip key={p.id} playlist={p} state={chipState(p.id)} onClick={() => flip(p.id)} num={extra?.num} hint={extra?.hint} />
    );

  const ofKind = (kind: Playlist['kind']) => playlists.filter((p) => p.kind === kind);
  const scores = ctx ? cellScores(byId, ctx) : [];
  const maxScore = Math.max(0.0001, ...scores.map((s) => s.score));
  const previousSemesters = ctx?.alreadyIn
    .map((id) => byId.get(id))
    .filter((p): p is Playlist => p?.kind === 'semester' && p.id !== ctx.semester.playlistId) ?? [];
  const olderGold = ctx?.alreadyIn
    .map((id) => byId.get(id))
    .filter((p): p is Playlist => p?.kind === 'gold' && p.id !== ctx.gold.playlistId) ?? [];
  const uncategorisedVibes = playlists.filter((p) => p.kind === 'vibe' && (!p.mood || !p.pace));
  const track = current?.track;

  return (
    <div className="sort">
      <aside className="queue">
        <div className="queue-head">
          <strong>Liked Songs</strong>
          <div className="queue-sort">
            <div className="sort-dropdown" ref={sortRef}>
              <button
                type="button"
                className="link small sort-trigger"
                onClick={() => setSortOpen((o) => !o)}
                aria-expanded={sortOpen}
                aria-haspopup="menu"
                title="Sort queue"
              >
                <span>{SORT_OPTIONS.find((o) => o.id === sort.option)?.label}</span>
                <span className="sort-arrow">{sort.direction === 'asc' ? '↑' : '↓'}</span>
                <span className="chevron">{sortOpen ? '▴' : '▾'}</span>
              </button>
              {sortOpen && (
                <ul className="sort-menu" role="menu">
                  {SORT_OPTIONS.map((opt) => {
                    const isActive = opt.id === sort.option;
                    return (
                      <li key={opt.id} role="none">
                        <button
                          type="button"
                          role="menuitem"
                          className={`sort-menu-item${isActive ? ' active' : ''}`}
                          onClick={() => {
                            selectSort(opt.id);
                            setSortOpen(false);
                          }}
                        >
                          <span>{opt.label}</span>
                          {isActive && <span className="sort-arrow">{sort.direction === 'asc' ? '↑' : '↓'}</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <span className="muted small">· {sortedQueue.length}</span>
          </div>
        </div>
        <ul>
          {sortedQueue.map((q) => (
            <li key={q.track.id}>
              <button className={`queue-item${q.track.id === track?.id ? ' current' : ''}${q.staged ? ' staged' : ''}`}
                onClick={() => setCurrentId(q.track.id)}>
                {q.track.imageUrl ? <img src={q.track.imageUrl} alt="" /> : <div className="art-blank" />}
                <span className="queue-text">
                  <span className="ellipsis">{q.track.name}</span>
                  <span className="ellipsis muted small">{q.track.artists.map((a) => a.name).join(', ')}</span>
                </span>
                {q.staged
                  ? <span className="staged-mark" title={`${q.staged.length} playlists staged`}>✓ {q.staged.length}</span>
                  : <span className="muted small">{formatDate(q.likedAt).replace(/, \d{4}$/, '')}</span>}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="card">
        {track && ctx && (
          <>
            <div className="song-head">
              {track.imageUrl && <img className="art" src={track.imageUrl} alt="" />}
              <div className="song-meta">
                <h2>{track.name}</h2>
                <div className="artists">{track.artists.map((a) => a.name).join(', ')}</div>
                <div className="muted small">
                  {track.album}{track.releaseDate ? ` · ${track.releaseDate.slice(0, 4)}` : ''}
                </div>
                <div className="small">
                  Liked {formatDate(current!.likedAt)} → <strong>{ctx.semester.name}</strong>
                  {previousSemesters.length > 0 && (
                    <span className="muted"> · first filed in {previousSemesters.map((p) => p.name).join(', ')}</span>
                  )}
                </div>
                {!ctx.audioAnalysed && (
                  <div className="small muted">
                    Suggestions use artist history only. No audio analysis for this song yet.
                  </div>
                )}
              </div>
              <div className="song-actions">
                <button className="ghost small" onClick={() => api.openInSpotify(track.uri).catch(onError)}>Open in Spotify</button>
                <button className="ghost small" onClick={() => setShowPlayer((v) => !v)}>{showPlayer ? 'Hide' : 'Show'} player (P)</button>
              </div>
            </div>

            {showPlayer && (
              <Player trackId={track.id} onError={onError} />
            )}

            {ctx.alreadyIn.length > 0 && (
              <div className="row">
                <span className="label">Already in</span>
                <div className="chips">{ctx.alreadyIn.map((id) => byId.get(id)).filter(Boolean).map((p) => (
                  <span key={p!.id} className="tag">{p!.name}</span>
                ))}</div>
              </div>
            )}

            <div className="row">
              <span className="label">Defaults</span>
              <div className="chips">
                {ctx.semester.playlistId
                  ? chip(byId.get(ctx.semester.playlistId))
                  : <span className="tag warn">No “{ctx.semester.name}” playlist. Create it in Spotify, then Sync.</span>}
                {ofKind('internal').map((p) => chip(p))}
                {ofKind('skimmed').map((p) => chip(p, { hint: 'auto when it earns a real playlist' }))}
              </div>
            </div>

            <div className="row">
              <span className="label">Gold <kbd>G</kbd></span>
              <div className="chips">
                {ctx.gold.playlistId
                  ? chip(byId.get(ctx.gold.playlistId))
                  : <span className="tag">No “{ctx.gold.name}” playlist yet</span>}
                {ofKind('gold_all').map((p) => chip(p, { hint: 'auto with any year’s Gold' }))}
                {olderGold.length > 0 && <span className="tag warn">Already in {olderGold.map((p) => p.name).join(', ')}</span>}
              </div>
            </div>

            <div className="row">
              <span className="label">Suggested vibes</span>
              <div className="chips">
                {suggestions.length === 0 && (
                  <span className="muted small">No suggestions for this song yet. Pick a mood and pace below.</span>
                )}
                {suggestions.map((s, i) => chip(byId.get(s.playlistId), { num: i + 1, hint: s.reasons.join(' · ') }))}
              </div>
            </div>

            <div className="row">
              <span className="label">Mood × pace</span>
              <div className="grid">
                <div />
                {PACES.map((pace) => <div key={pace} className="grid-head">{PACE_LABEL[pace]}</div>)}
                {MOODS.map((mood) => (
                  <Fragment key={mood}>
                    <div className="grid-head">{MOOD_LABEL[mood]}</div>
                    {PACES.map((pace) => {
                      const s = scores.find((c) => c.mood === mood && c.pace === pace)?.score ?? 0;
                      const cellPlaylists = playlists.filter((p) => p.kind === 'vibe' && p.mood === mood && p.pace === pace);
                      const chosen = cellPlaylists.filter((p) => final.has(p.id)).length;
                      const isFocus = focus?.mood === mood && focus.pace === pace;
                      return (
                        <button key={cellKey(mood, pace)} className={`cell ${mood}${isFocus ? ' focus' : ''}`}
                          onClick={() => setFocus(isFocus ? null : { mood, pace })} disabled={cellPlaylists.length === 0}>
                          <span className="cell-bar" style={{ width: `${(s / maxScore) * 100}%` }} />
                          <span className="cell-text">
                            {cellPlaylists.length} lists{chosen > 0 ? ` · ${chosen} picked` : ''}
                          </span>
                        </button>
                      );
                    })}
                  </Fragment>
                ))}
              </div>
            </div>
            {focus && (
              <div className="row">
                <span className="label">{MOOD_LABEL[focus.mood]} · {PACE_LABEL[focus.pace]}</span>
                <div className="chips">
                  {ofKind('pool').filter((p) => p.mood === focus.mood).map((p) => chip(p))}
                  {playlists.filter((p) => p.kind === 'vibe' && p.mood === focus.mood && p.pace === focus.pace).map((p) => chip(p))}
                </div>
              </div>
            )}

            <div className="row">
              <span className="label">Exercise</span>
              <div className="chips">{ofKind('exercise').map((p) => chip(p))}</div>
            </div>

            <div className="row">
              <span className="label">
                <button className="link" onClick={() => setShowMore((v) => !v)}>{showMore ? '▾' : '▸'} More</button>
              </span>
              {showMore ? (
                <div className="chips">
                  {ofKind('pool').map((p) => chip(p))}
                  {ofKind('idea').map((p) => chip(p))}
                  {uncategorisedVibes.map((p) => chip(p))}
                  {ofKind('unsorted').filter((p) => p.owned).map((p) => chip(p))}
                </div>
              ) : (
                <span className="muted small">Random Ideas, pools and uncategorised playlists</span>
              )}
            </div>

            <footer className="card-foot">
              <label className="check">
                <input type="checkbox" checked={unlike} onChange={(e) => setUnlike(e.target.checked)} />
                Unlike after filing <kbd>U</kbd>
              </label>
              <span className="muted small">{final.size} playlist{final.size === 1 ? '' : 's'}</span>
              <div className="spacer" />
              {current?.staged && <button className="ghost" onClick={unstageCurrent}>Unstage</button>}
              <button className="ghost" onClick={() => goTo(1)}>Skip <kbd>S</kbd></button>
              <button onClick={stageAndNext} disabled={final.size === 0 && !unlike}>
                {current?.staged ? 'Update' : 'Stage'} &amp; next <kbd>Enter</kbd>
              </button>
            </footer>
          </>
        )}
        {track && !ctx && <div className="muted">Loading…</div>}
      </section>

      <div className="commit-bar">
        <span>
          <strong>{stagedCount}</strong> song{stagedCount === 1 ? '' : 's'} staged
          <span className="muted small"> · nothing changes in Spotify until you commit</span>
        </span>
        {stats.songs > 0 && (
          <span className="muted small" title="How the Suggested vibes row has done on songs you've committed (when you picked a vibe playlist)">
            Suggestions so far: top pick {stats.top1}/{stats.songs} · top 3 {stats.top3}/{stats.songs} · among 9 {stats.top9}/{stats.songs}
          </span>
        )}
        <div className="spacer" />
        {canRevert && (
          <button className="ghost" onClick={revert} disabled={busy}>
            {confirmRevert ? 'Click again to undo last commit' : 'Undo last commit'}
          </button>
        )}
        <button onClick={commit} disabled={busy || stagedCount === 0}>
          {busy ? 'Working…' : `Commit ${stagedCount} to Spotify`}
        </button>
      </div>
    </div>
  );
}

type ChipState = 'on' | 'auto' | 'off' | 'already';

function Chip({ playlist, state, onClick, num, hint }: {
  playlist: Playlist; state: ChipState; onClick: () => void; num?: number; hint?: string;
}) {
  const title = [
    playlist.description,
    hint,
    state === 'already' ? 'Already in this playlist' : state === 'auto' ? 'Added automatically. Click to leave it out' : null,
  ].filter(Boolean).join('\n');
  return (
    <button className={`chip ${state}`} onClick={onClick} disabled={state === 'already'} title={title || undefined}>
      {num !== undefined && <kbd>{num}</kbd>}
      <span>{playlist.name}</span>
      {state === 'auto' && <span className="chip-note">auto</span>}
      {hint && num !== undefined && <span className="chip-note">{hint.split(' · ')[0]}</span>}
    </button>
  );
}
