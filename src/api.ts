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
}

export interface Status {
  hasClientId: boolean;
  loggedIn: boolean;
  displayName: string | null;
  redirectUri: string;
  apiCallsToday: number;
  lastSync: string | null;
  canRevert: boolean;
}

export interface SyncProgress { message: string; done: number; total: number }
export interface SyncSummary { playlists: number; playlistsDownloaded: number; liked: number; apiCalls: number }
export interface CommitSummary { songs: number; additions: number; unliked: number }

export const api = {
  status: () => invoke<Status>('status'),
  setClientId: (clientId: string) => invoke<void>('set_client_id', { clientId }),
  login: () => invoke<void>('login'),
  cancelLogin: () => invoke<void>('cancel_login'),
  logout: () => invoke<void>('logout'),
  sync: (force = false) => invoke<SyncSummary>('sync_library', { force }),
  playlists: () => invoke<Playlist[]>('get_playlists'),
  updatePlaylist: ({ id, kind, mood, pace, description }: Pick<Playlist, 'id' | 'kind' | 'mood' | 'pace' | 'description'>) =>
    invoke<void>('update_playlist', { id, kind, mood, pace, description }),
  queue: () => invoke<QueueItem[]>('get_queue'),
  context: (trackId: string) => invoke<TrackContext>('get_track_context', { trackId }),
  stage: (trackId: string, playlistIds: string[], unlike: boolean) =>
    invoke<void>('stage', { trackId, playlistIds, unlike }),
  unstage: (trackId: string) => invoke<void>('unstage', { trackId }),
  commit: () => invoke<CommitSummary>('commit'),
  revertLastCommit: () => invoke<CommitSummary>('revert_last_commit'),
  openInSpotify: (uri: string) => invoke<void>('open_in_spotify', { uri }),
};

export function onSyncProgress(cb: (p: SyncProgress) => void): Promise<UnlistenFn> {
  return listen<SyncProgress>('sync-progress', (e) => cb(e.payload));
}

/** Errors from Rust arrive as strings; login expiry is tagged so the UI can react. */
export function errorText(err: unknown): string {
  return typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
}

export function isLoginError(err: unknown): boolean {
  return errorText(err).startsWith('NOT_LOGGED_IN');
}
