import type { Kind, Mood, Pace, Playlist, TrackContext } from './api';

/**
 * Filing rules:
 * - The current semester and Internal are always on.
 * - Skimmed Internal comes along whenever the song earns any non-default playlist.
 * - Picking a vibe playlist brings in that mood's pool.
 * - Picking a year's Gold brings in the all-time Gold playlist (2018-Present Gold).
 * Anything automatic can still be switched off for a single song.
 */

const KEEPER_KINDS: Kind[] = ['gold', 'gold_all', 'pool', 'vibe', 'exercise', 'idea'];

export interface Selection {
  /** Playlists the user switched on. */
  picked: Set<string>;
  /** Automatic playlists the user switched off for this song. */
  off: Set<string>;
}

export const emptySelection = (): Selection => ({ picked: new Set(), off: new Set() });

export function autoIds(picked: Set<string>, byId: Map<string, Playlist>, ctx: TrackContext): Set<string> {
  const auto = new Set<string>();
  if (ctx.semester.playlistId) auto.add(ctx.semester.playlistId);
  for (const p of byId.values()) if (p.kind === 'internal') auto.add(p.id);

  const pickedPlaylists = [...picked].map((id) => byId.get(id)).filter((p): p is Playlist => !!p);
  if (pickedPlaylists.some((p) => KEEPER_KINDS.includes(p.kind))) {
    for (const p of byId.values()) if (p.kind === 'skimmed') auto.add(p.id);
  }
  if (pickedPlaylists.some((p) => p.kind === 'gold')) {
    for (const p of byId.values()) if (p.kind === 'gold_all') auto.add(p.id);
  }
  const vibeMoods = new Set(pickedPlaylists.filter((p) => p.kind === 'vibe' && p.mood).map((p) => p.mood));
  for (const p of byId.values()) {
    if (p.kind === 'pool' && p.mood && vibeMoods.has(p.mood)) auto.add(p.id);
  }
  return auto;
}

/** The playlists the song will actually be added to. */
export function finalIds(sel: Selection, byId: Map<string, Playlist>, ctx: TrackContext): Set<string> {
  const already = new Set(ctx.alreadyIn);
  const out = new Set<string>();
  for (const id of [...sel.picked, ...autoIds(sel.picked, byId, ctx)]) {
    if (!sel.off.has(id) && !already.has(id) && byId.has(id)) out.add(id);
  }
  return out;
}

export function toggle(sel: Selection, id: string, byId: Map<string, Playlist>, ctx: TrackContext): Selection {
  const picked = new Set(sel.picked);
  const off = new Set(sel.off);
  if (finalIds(sel, byId, ctx).has(id)) {
    picked.delete(id);
    if (autoIds(picked, byId, ctx).has(id)) off.add(id);
  } else {
    off.delete(id);
    if (!autoIds(picked, byId, ctx).has(id)) picked.add(id);
  }
  return { picked, off };
}

/** Rebuilds a selection from a previously staged list of playlist IDs. */
export function fromStaged(staged: string[], byId: Map<string, Playlist>, ctx: TrackContext): Selection {
  const picked = new Set(staged);
  const off = new Set([...autoIds(picked, byId, ctx)].filter((id) => !picked.has(id)));
  return { picked, off };
}

export const MOODS: Mood[] = ['positive', 'negative'];
export const PACES: Pace[] = ['high', 'med', 'low'];
export const cellKey = (mood: Mood, pace: Pace) => `${mood}-${pace}`;

export interface CellScore { mood: Mood; pace: Pace; score: number }

/** Sums suggestion scores (artist history blended with sound-alikes) of the vibe playlists in each cell. */
export function cellScores(byId: Map<string, Playlist>, ctx: TrackContext): CellScore[] {
  const scores = new Map<string, number>();
  for (const s of ctx.suggestions) {
    const p = byId.get(s.playlistId);
    if (p?.kind === 'vibe' && p.mood && p.pace) {
      const key = cellKey(p.mood, p.pace);
      scores.set(key, (scores.get(key) ?? 0) + s.score);
    }
  }
  return MOODS.flatMap((mood) =>
    PACES.map((pace) => ({ mood, pace, score: scores.get(cellKey(mood, pace)) ?? 0 })),
  );
}
