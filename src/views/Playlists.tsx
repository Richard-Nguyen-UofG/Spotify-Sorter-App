import { useMemo, useState } from 'react';
import { api, type Kind, type Mood, type Pace, type Playlist } from '../api';

const KIND_OPTIONS: { value: Kind; label: string; help: string }[] = [
  { value: 'unsorted', label: 'Unsorted', help: 'Not categorised yet' },
  { value: 'vibe', label: 'Vibe', help: 'Lives in a Positive/Negative × High/Med/Low folder' },
  { value: 'pool', label: 'Pool', help: 'positive pool / negative pool' },
  { value: 'exercise', label: 'Exercise', help: 'Gym and cardio playlists' },
  { value: 'idea', label: 'Random idea', help: 'Incubating playlists' },
  { value: 'semester', label: 'Semester', help: 'Fall/Winter/Summer YYYY, picked automatically by like date' },
  { value: 'gold', label: 'Gold', help: 'YYYY Gold, picked by year' },
  { value: 'gold_all', label: 'All-time Gold', help: 'Gets every song that goes into a YYYY Gold' },
  { value: 'internal', label: 'Internal', help: 'Every finished song goes here' },
  { value: 'skimmed', label: 'Skimmed Internal', help: 'Added when a song earns a real playlist' },
  { value: 'archive', label: 'Archived', help: 'Old taste-based playlists you keep; not suggested or re-downloaded' },
  { value: 'memory', label: 'Memory', help: 'Time-capsule playlists for a moment in time; not suggested or re-downloaded' },
  { value: 'ignore', label: 'Ignore', help: 'Not relevant (e.g. Song Buffer, followed playlists)' },
];

const GROUP_ORDER: Kind[] = [
  'unsorted', 'vibe', 'pool', 'exercise', 'idea', 'internal', 'skimmed', 'gold_all', 'gold', 'semester', 'archive', 'memory', 'ignore',
];

interface Props {
  playlists: Playlist[];
  onSaved: (playlists: Playlist[]) => void;
  onError: (e: unknown) => void;
}

export default function Playlists({ playlists, onSaved, onError }: Props) {
  const [filter, setFilter] = useState('');

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const visible = playlists.filter((p) => !q || p.name.toLowerCase().includes(q));
    return GROUP_ORDER
      .map((kind) => ({ kind, items: visible.filter((p) => p.kind === kind) }))
      .filter((g) => g.items.length > 0);
  }, [playlists, filter]);

  const save = async (p: Playlist, change: Partial<Playlist>) => {
    const next = { ...p, ...change };
    if (next.kind !== 'vibe') next.pace = null;
    if (next.kind !== 'vibe' && next.kind !== 'pool') next.mood = null;
    onSaved(playlists.map((x) => (x.id === p.id ? next : x)));
    try {
      await api.updatePlaylist(next);
    } catch (e) {
      onError(e);
      onSaved(playlists);
    }
  };

  const archiveAllUnsorted = async () => {
    const unsorted = playlists.filter((p) => p.kind === 'unsorted');
    onSaved(playlists.map((p) => (p.kind === 'unsorted' ? { ...p, kind: 'archive', mood: null, pace: null } : p)));
    try {
      for (const p of unsorted) await api.updatePlaylist({ ...p, kind: 'archive', mood: null, pace: null });
    } catch (e) {
      onError(e);
    }
  };

  return (
    <div className="playlists">
      <div className="playlists-head">
        <div>
          <h2>Playlists</h2>
          <p className="muted small">
            Spotify's API can't see your folders, so mirror them here once. Vibe playlists need a mood and pace
            (the folder they live in). A short description of what belongs in each playlist will help future
            suggestions, especially for small or [WIP] playlists.
          </p>
        </div>
        <input className="search" placeholder="Filter playlists" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>

      {groups.map((g) => (
        <section key={g.kind} className="pl-group">
          <h3>
            {KIND_OPTIONS.find((k) => k.value === g.kind)?.label} <span className="muted small">{g.items.length}</span>
            {g.kind === 'unsorted' && !filter && (
              <button className="ghost small group-action" onClick={archiveAllUnsorted}
                title="Tag the playlists you file into first, then archive the rest so they're kept as history but not re-downloaded">
                Mark all unsorted as Archived
              </button>
            )}
          </h3>
          <div className="pl-rows">
            {g.items.map((p) => (
              <div key={p.id} className={`pl-row${p.kind === 'vibe' && (!p.mood || !p.pace) ? ' needs' : ''}`}>
                {p.imageUrl ? <img src={p.imageUrl} alt="" /> : <div className="art-blank" />}
                <div className="pl-name">
                  <span className="ellipsis">{p.name}</span>
                  <span className="muted small">{p.total} songs{p.owned ? '' : ' · not yours'}</span>
                </div>
                <select value={p.kind} onChange={(e) => save(p, { kind: e.target.value as Kind })}
                  title={KIND_OPTIONS.find((k) => k.value === p.kind)?.help}>
                  {KIND_OPTIONS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                </select>
                {(p.kind === 'vibe' || p.kind === 'pool') ? (
                  <select value={p.mood ?? ''} onChange={(e) => save(p, { mood: (e.target.value || null) as Mood | null })}>
                    <option value="">Mood…</option>
                    <option value="positive">Positive</option>
                    <option value="negative">Negative</option>
                  </select>
                ) : <span />}
                {p.kind === 'vibe' ? (
                  <select value={p.pace ?? ''} onChange={(e) => save(p, { pace: (e.target.value || null) as Pace | null })}>
                    <option value="">Pace…</option>
                    <option value="high">High</option>
                    <option value="med">Med</option>
                    <option value="low">Low</option>
                  </select>
                ) : <span />}
                <input className="desc" placeholder="What belongs here? (optional)" defaultValue={p.description ?? ''}
                  onBlur={(e) => {
                    if ((e.target.value.trim() || null) !== (p.description ?? null)) void save(p, { description: e.target.value.trim() || null });
                  }} />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
