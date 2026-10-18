import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type Kind =
  | 'semester' | 'internal' | 'skimmed' | 'gold' | 'gold_all'
  | 'pool' | 'vibe' | 'exercise' | 'idea'
  | 'archive' | 'memory' | 'ignore' | 'unsorted';
export type Mood = 'positive' | 'negative';
export type Pace = 'high' | 'med' | 'low';

export interface Playlist {
  id: string;
  name: string;
  total: number;
  imageUrl: string | null;
  kind: Kind;
  mood: Mood | null;
  pace: Pace | null;
  description: string | null;
  owned: boolean;
}

export interface Artist { id: string | null; name: string }

export interface Track {
  id: string;
  uri: string;
  name: string;
  album: string | null;
  releaseDate: string | null;
  isrc: string | null;
  durationMs: number | null;
  imageUrl: string | null;
  artists: Artist[];
}

export interface QueueItem {
  track: Track;
  likedAt: string;
  staged: string[] | null;
  unlike: boolean;
}

export interface DatedTarget { name: string; playlistId: string | null }
export interface Suggestion { playlistId: string; score: number; reasons: string[] }

export interface TrackContext {
  alreadyIn: string[];
  semester: DatedTarget;
  gold: DatedTarget;
  suggestions: Suggestion[];
  /** Whether sound-alike scores from the audio/lyrics analysis went into the suggestions. */
  audioAnalysed: boolean;
}

export interface Status {
  hasClientId: boolean;
  loggedIn: boolean;
  displayName: string | null;
  redirectUri: string;
  apiCallsToday: number;
  lastSync: string | null;
  canRevert: boolean;
  mlAvailable: boolean;
  mlRunning: boolean;
  mlTrainedAt: string | null;
  mlSongs: number;
  /** Real-use accuracy of the Suggested vibes row on committed songs where a vibe was picked. */
  suggestionStats: { songs: number; top1: number; top3: number; top9: number };
  missingScopes: string[];
  cooldownSecs: number | null;
}

/** A library song found by an Explore search. */
export interface Match {
  track: Track;
  /** Ranking score within its group (only comparable inside one search). */
  score: number;
  /** "artist": shares artists with the seeds; "sound": other artists, by sound; "misfit": least typical. */
  group: 'artist' | 'sound' | 'misfit';
  /** Why it's listed, e.g. "3 of 5 songs by Cafuné are in this playlist". */
  reason: string;
}

export interface SyncProgress { message: string; done: number; total: number }
export interface SyncSummary {
  playlists: number;
  playlistsDownloaded: number;
  playlistsToppedUp: number;
  /** Changed playlists left for a later sync to stay within the request budget. */
  playlistsDeferred: number;
  deferredRequests: number;
  liked: number;
  apiCalls: number;
}
export interface CommitSummary { songs: number; additions: number; unliked: number }

export const api = {
  status: () => invoke<Status>('status'),
  setClientId: (clientId: string) => invoke<void>('set_client_id', { clientId }),
  login: () => invoke<void>('login'),
  cancelLogin: () => invoke<void>('cancel_login'),
  logout: () => invoke<void>('logout'),
  /** `allowLarge` downloads every changed playlist now instead of staying within the request budget. */
  sync: (force = false, allowLarge = false) => invoke<SyncSummary>('sync_library', { force, allowLarge }),
  runMl: () => invoke<void>('run_ml'),
  playlists: () => invoke<Playlist[]>('get_playlists'),
  updatePlaylist: ({ id, kind, mood, pace, description }: Pick<Playlist, 'id' | 'kind' | 'mood' | 'pace' | 'description'>) =>
    invoke<void>('update_playlist', { id, kind, mood, pace, description }),
  queue: () => invoke<QueueItem[]>('get_queue'),
  context: (trackId: string) => invoke<TrackContext>('get_track_context', { trackId }),
  /** `shown`: the Suggested vibes in order, logged next to the picks to measure real-use accuracy. */
  stage: (trackId: string, playlistIds: string[], unlike: boolean, shown: string[], audioAnalysed: boolean) =>
    invoke<void>('stage', { trackId, playlistIds, unlike, shown, audioAnalysed }),
  unstage: (trackId: string) => invoke<void>('unstage', { trackId }),
  commit: () => invoke<CommitSummary>('commit'),
  revertLastCommit: () => invoke<CommitSummary>('revert_last_commit'),
  openInSpotify: (uri: string) => invoke<void>('open_in_spotify', { uri }),
  exploreGrow: (playlistId: string, includeInternal: boolean) =>
    invoke<Match[]>('explore_grow', { playlistId, includeInternal }),
  exploreMisfits: (playlistId: string) => invoke<Match[]>('explore_misfits', { playlistId }),
  exploreSimilar: (trackIds: string[], includeInternal: boolean) =>
    invoke<Match[]>('explore_similar', { trackIds, includeInternal }),
  searchLibrary: (query: string) => invoke<Track[]>('search_library', { query }),
  addTracks: (playlistId: string, trackIds: string[]) => invoke<number>('add_tracks', { playlistId, trackIds }),
  removeTracks: (playlistId: string, trackIds: string[]) => invoke<number>('remove_tracks', { playlistId, trackIds }),
  createPlaylist: (name: string, trackIds: string[]) => invoke<string>('create_playlist', { name, trackIds }),
};

export function onSyncProgress(cb: (p: SyncProgress) => void): Promise<UnlistenFn> {
  return listen<SyncProgress>('sync-progress', (e) => cb(e.payload));
}

export function onMlProgress(cb: (p: SyncProgress) => void): Promise<UnlistenFn> {
  return listen<SyncProgress>('ml-progress', (e) => cb(e.payload));
}

/** Errors from Rust arrive as strings; login expiry is tagged so the UI can react. */
export function errorText(err: unknown): string {
  return typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
}

export function isLoginError(err: unknown): boolean {
  return errorText(err).startsWith('NOT_LOGGED_IN');
}
