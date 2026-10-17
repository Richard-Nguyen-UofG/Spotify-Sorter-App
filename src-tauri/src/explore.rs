//! Playlist → songs tools: grow a playlist, find the songs that fit it least, and find songs like
//! a hand-picked few.
//!
//! Suggestions come in two labelled groups, because the signals differ a lot in strength. On the
//! author's library, hiding 20% of a playlist and searching for it found 28% of the hidden songs
//! in the top 40 by artist ("other songs by this artist are here") but only ~7% by sound alone
//! (random: ~2%). So artist matches come first, and sound-alikes from other artists are offered
//! as ideas.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::db;
use crate::error::{AppError, AppResult};
use crate::model::Track;

const AUDIO_DIM: usize = 512;
const TEXT_DIM: usize = 384;
const DIM: usize = AUDIO_DIM + TEXT_DIM;
/// Must match LYRICS_WEIGHT in ml/sorter_ml.py.
const LYRICS_WEIGHT: f32 = 0.6;
/// A candidate's sound score is its mean similarity to its closest few seed songs, so a playlist
/// with two distinct moods can still pull in songs that match either one.
const TOP_K: usize = 5;
/// Big playlists (pools) are sampled down to keep searches instant.
const MAX_SEEDS: usize = 250;
const ARTIST_RESULTS: usize = 20;
const SOUND_RESULTS: usize = 25;
/// Sound picks per closest seed song, so one seed can't fill the list.
const PER_SEED: usize = 2;

/// Songs the user kept: the default search space (same as the Python reference library).
const KEPT_KINDS: &str = "'pool','vibe','exercise','idea','skimmed','gold','gold_all'";
const HEARD_KINDS: &str = "'pool','vibe','exercise','idea','skimmed','gold','gold_all','internal','semester'";

// ------------------------------------------------------------------------------- vectors

pub struct VectorIndex {
    ids: Vec<String>,
    pos: HashMap<String, usize>,
    data: Vec<f32>,
    /// Each song's mean similarity to its nearest neighbours. Subtracting it ("CSLS") stops
    /// songs that resemble everything from topping every list.
    hub: Vec<f32>,
}

fn floats(blob: &[u8]) -> Vec<f32> {
    blob.chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect()
}

fn mean<'a>(vectors: impl Iterator<Item = &'a Vec<f32>>, dim: usize) -> Vec<f32> {
    let mut sum = vec![0.0f32; dim];
    let mut n = 0usize;
    for v in vectors {
        sum.iter_mut().zip(v).for_each(|(s, x)| *s += x);
        n += 1;
    }
    sum.iter().map(|s| s / n.max(1) as f32).collect()
}

/// `(v - mean)` scaled to length `weight`.
fn centred_unit(v: &[f32], mean: &[f32], weight: f32) -> Vec<f32> {
    let c: Vec<f32> = v.iter().zip(mean).map(|(x, m)| x - m).collect();
    let norm = c.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-9);
    c.iter().map(|x| x / norm * weight).collect()
}

/// Mean of the `k` largest values.
fn top_k_mean(values: &mut [f32], k: usize) -> f32 {
    let k = k.min(values.len()).max(1);
    values.select_nth_unstable_by(k - 1, |a, b| b.total_cmp(a));
    values[..k].iter().sum::<f32>() / k as f32
}

impl VectorIndex {
    pub fn build(conn: &Connection) -> AppResult<Self> {
        let mut stmt = conn.prepare(
            "SELECT a.track_id, a.embedding, l.embedding FROM ml_audio a
             LEFT JOIN ml_lyrics l ON l.track_id = a.track_id AND l.status = 'ok'
             WHERE a.status = 'ok' AND a.embedding IS NOT NULL",
        )?;
        let mut rows = stmt.query([])?;
        let mut raw: Vec<(String, Vec<f32>, Option<Vec<f32>>)> = Vec::new();
        while let Some(row) = rows.next()? {
            let audio = floats(&row.get::<_, Vec<u8>>(1)?);
            if audio.len() != AUDIO_DIM {
                continue;
            }
            let lyrics = row
                .get::<_, Option<Vec<u8>>>(2)?
                .map(|b| floats(&b))
                .filter(|v| v.len() == TEXT_DIM);
            raw.push((row.get(0)?, audio, lyrics));
        }

        // Centre each part on the library average before comparing: raw CLAP vectors share a
        // large common component (two random songs average ~0.96 cosine). Mirrors
        // Library.vectors in ml/sorter_ml.py.
        let audio_mean = mean(raw.iter().map(|r| &r.1), AUDIO_DIM);
        let lyrics_mean = mean(raw.iter().filter_map(|r| r.2.as_ref()), TEXT_DIM);
        let (mut ids, mut data) = (Vec::with_capacity(raw.len()), Vec::with_capacity(raw.len() * DIM));
        for (id, audio, lyrics) in raw {
            let mut v = centred_unit(&audio, &audio_mean, 1.0);
            match lyrics {
                Some(l) => v.extend(centred_unit(&l, &lyrics_mean, LYRICS_WEIGHT)),
                None => v.extend(std::iter::repeat(0.0).take(TEXT_DIM)),
            }
            let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-9);
            data.extend(v.iter().map(|x| x / norm));
            ids.push(id);
        }
        let pos = ids.iter().enumerate().map(|(i, id)| (id.clone(), i)).collect();
        let mut index = VectorIndex { ids, pos, data, hub: Vec::new() };

        // Hubness against a sample of the library: close enough, and keeps the build to ~2 s.
        let n = index.ids.len();
        let step = (n / 500).max(1);
        let sample: Vec<usize> = (0..n).step_by(step).collect();
        index.hub = (0..n)
            .map(|i| {
                let mut sims: Vec<f32> = sample.iter().filter(|&&s| s != i).map(|&s| index.sim(i, s)).collect();
                if sims.is_empty() { 0.0 } else { top_k_mean(&mut sims, 10) }
            })
            .collect();
        Ok(index)
    }

    pub fn len(&self) -> usize {
        self.ids.len()
    }

    fn row(&self, i: usize) -> &[f32] {
        &self.data[i * DIM..(i + 1) * DIM]
    }

    fn sim(&self, a: usize, b: usize) -> f32 {
        self.row(a).iter().zip(self.row(b)).map(|(x, y)| x * y).sum()
    }

    /// Hub-corrected similarity (CSLS); comparable within a search, not an absolute scale.
    fn adjusted(&self, a: usize, b: usize) -> f32 {
        2.0 * self.sim(a, b) - self.hub[a] - self.hub[b]
    }

    /// Best adjusted similarity of `row` to `seeds` (top-k mean) and the closest seed.
    fn fit(&self, row: usize, seeds: &[usize]) -> (f32, usize) {
        let mut sims: Vec<f32> = seeds.iter().map(|&s| self.adjusted(row, s)).collect();
        let best = sims
            .iter()
            .enumerate()
            .fold((0, f32::MIN), |acc, (i, &v)| if v > acc.1 { (i, v) } else { acc })
            .0;
        (top_k_mean(&mut sims, TOP_K), seeds[best])
    }
}

// ------------------------------------------------------------------------------- searches

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Match {
    pub track: Track,
    /// Ranking score within its group (higher = better fit; misfits: lower = worse fit).
    pub score: f32,
    /// "artist", "sound" or "misfit".
    pub group: &'static str,
    /// Why it's here, e.g. "3 of 5 songs by Cafuné are in this playlist" or "sounds like …".
    pub reason: String,
}

fn query_ids(conn: &Connection, sql: &str, param: Option<&str>) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = match param {
        Some(p) => stmt.query_map([p], |r| r.get(0))?.collect::<Result<_, _>>()?,
        None => stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?,
    };
    Ok(rows)
}

fn track_pool(conn: &Connection, include_internal: bool) -> AppResult<Vec<String>> {
    let kinds = if include_internal { HEARD_KINDS } else { KEPT_KINDS };
    query_ids(
        conn,
        &format!(
            "SELECT DISTINCT pt.track_id FROM playlist_tracks pt JOIN playlists p ON p.id = pt.playlist_id
             WHERE p.present = 1 AND p.owned = 1 AND p.kind IN ({kinds})"
        ),
        None,
    )
}

fn playlist_members(conn: &Connection, playlist_id: &str) -> AppResult<Vec<String>> {
    query_ids(conn, "SELECT track_id FROM playlist_tracks WHERE playlist_id = ?1", Some(playlist_id))
}

fn isrcs(conn: &Connection) -> AppResult<HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT id, isrc FROM tracks WHERE isrc IS NOT NULL")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
    Ok(rows)
}

/// track id → [(artist id, artist name)]
fn track_artists(conn: &Connection) -> AppResult<HashMap<String, Vec<(String, String)>>> {
    let mut stmt =
        conn.prepare("SELECT track_id, artist_id, artist_name FROM track_artists WHERE artist_id IS NOT NULL")?;
    let mut map: HashMap<String, Vec<(String, String)>> = HashMap::new();
    for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get(1)?, r.get(2)?)))? {
        let (track, artist, name) = row?;
        map.entry(track).or_default().push((artist, name));
    }
    Ok(map)
}

fn label(conn: &Connection, id: &str) -> String {
    db::load_track(conn, id)
        .ok()
        .flatten()
        .map(|t| match t.artists.first() {
            Some(a) => format!("{} – {}", t.name, a.name),
            None => t.name,
        })
        .unwrap_or_default()
}

/// What the seed songs are, for phrasing reasons.
#[derive(Clone, Copy)]
pub enum Seeds {
    Playlist,
    Picks,
}

/// Songs from the library that belong with `seeds`: first by shared artists, then by sound.
pub fn find(
    index: &VectorIndex,
    conn: &Connection,
    seeds: &[String],
    kind: Seeds,
    include_internal: bool,
) -> AppResult<Vec<Match>> {
    let seed_set: HashSet<&String> = seeds.iter().collect();
    let isrc = isrcs(conn)?;
    let seed_isrcs: HashSet<&String> = seeds.iter().filter_map(|t| isrc.get(t)).collect();
    let candidates: Vec<String> = track_pool(conn, include_internal)?
        .into_iter()
        .filter(|t| !seed_set.contains(t) && isrc.get(t).map_or(true, |i| !seed_isrcs.contains(i)))
        .collect();

    // Artist evidence: how many of each artist's songs are among the seeds.
    let artists = track_artists(conn)?;
    let mut in_seeds: HashMap<&str, usize> = HashMap::new();
    for t in seeds {
        for (a, _) in artists.get(t).into_iter().flatten() {
            *in_seeds.entry(a.as_str()).or_default() += 1;
        }
    }
    let mut known: HashMap<&str, usize> = HashMap::new();
    for t in candidates.iter().chain(seeds) {
        for (a, _) in artists.get(t).into_iter().flatten() {
            *known.entry(a.as_str()).or_default() += 1;
        }
    }

    let mut seed_rows: Vec<usize> = seeds.iter().filter_map(|s| index.pos.get(s).copied()).collect();
    if seed_rows.len() > MAX_SEEDS {
        let step = seed_rows.len() as f64 / MAX_SEEDS as f64;
        seed_rows = (0..MAX_SEEDS).map(|i| seed_rows[(i as f64 * step) as usize]).collect();
    }

    struct Scored<'a> {
        id: &'a String,
        artist: f32,
        artist_reason: Option<String>,
        sound: Option<(f32, usize)>,
    }
    let scored: Vec<Scored> = candidates
        .iter()
        .map(|id| {
            let mut best: Option<(f32, String)> = None;
            for (a, name) in artists.get(id).into_iter().flatten() {
                let Some(&n) = in_seeds.get(a.as_str()) else { continue };
                let total = known[a.as_str()];
                let share = n as f32 / (total as f32 + 1.0);
                if best.as_ref().map_or(true, |b| share > b.0) {
                    let reason = match kind {
                        Seeds::Playlist => format!("{n} of {total} songs by {name} are in this playlist"),
                        Seeds::Picks => format!("by {name}, like {n} of your picks"),
                    };
                    best = Some((share, reason));
                }
            }
            let sound = (!seed_rows.is_empty())
                .then(|| index.pos.get(id).map(|&row| index.fit(row, &seed_rows)))
                .flatten();
            Scored {
                id,
                artist: best.as_ref().map_or(0.0, |b| b.0),
                artist_reason: best.map(|b| b.1),
                sound,
            }
        })
        .collect();

    let sound_of = |s: &Scored| s.sound.map_or(f32::MIN, |x| x.0);
    let mut by_artist: Vec<&Scored> = scored.iter().filter(|s| s.artist > 0.0).collect();
    by_artist.sort_by(|a, b| b.artist.total_cmp(&a.artist).then(sound_of(b).total_cmp(&sound_of(a))));
    let mut by_sound: Vec<&Scored> = scored.iter().filter(|s| s.artist == 0.0 && s.sound.is_some()).collect();
    by_sound.sort_by(|a, b| sound_of(b).total_cmp(&sound_of(a)));

    if by_artist.is_empty() && by_sound.is_empty() && seed_rows.is_empty() {
        return Err(AppError::msg(
            "None of these songs have been analysed yet, and no other songs share their artists.",
        ));
    }

    let mut out = Vec::new();
    let mut seen: HashSet<&String> = HashSet::new();
    let mut per_seed: HashMap<usize, usize> = HashMap::new();
    let mut take = |list: Vec<&Scored>, limit: usize, group: &'static str, out: &mut Vec<Match>| -> AppResult<()> {
        let mut added = 0;
        for s in list {
            if added >= limit {
                break;
            }
            if group == "sound" {
                let closest = s.sound.map_or(usize::MAX, |x| x.1);
                let used = per_seed.entry(closest).or_default();
                if *used >= PER_SEED {
                    continue;
                }
                *used += 1;
            }
            if let Some(code) = isrc.get(s.id) {
                if !seen.insert(code) {
                    continue; // another release of a song already listed
                }
            }
            let Some(track) = db::load_track(conn, s.id)? else { continue };
            let reason = match group {
                "artist" => s.artist_reason.clone().unwrap_or_default(),
                _ => format!("sounds like {}", s.sound.map(|x| label(conn, &index.ids[x.1])).unwrap_or_default()),
            };
            out.push(Match {
                track,
                score: if group == "artist" { s.artist } else { sound_of(s) },
                group,
                reason,
            });
            added += 1;
        }
        Ok(())
    };
    take(by_artist, ARTIST_RESULTS, "artist", &mut out)?;
    take(by_sound, SOUND_RESULTS, "sound", &mut out)?;
    Ok(out)
}

pub fn grow(index: &VectorIndex, conn: &Connection, playlist_id: &str, include_internal: bool) -> AppResult<Vec<Match>> {
    find(index, conn, &playlist_members(conn, playlist_id)?, Seeds::Playlist, include_internal)
}

/// The playlist's songs that sound least like the rest of it.
pub fn misfits(index: &VectorIndex, conn: &Connection, playlist_id: &str) -> AppResult<Vec<Match>> {
    let rows: Vec<usize> = playlist_members(conn, playlist_id)?
        .iter()
        .filter_map(|t| index.pos.get(t).copied())
        .collect();
    if rows.len() < 6 {
        return Err(AppError::msg("Misfits needs at least 6 analysed songs in the playlist."));
    }
    let mut scored: Vec<(usize, f32, usize)> = rows
        .iter()
        .map(|&m| {
            let others: Vec<usize> = rows.iter().copied().filter(|&o| o != m).collect();
            let (fit, closest) = index.fit(m, &others);
            (m, fit, closest)
        })
        .collect();
    scored.sort_by(|a, b| a.1.total_cmp(&b.1));
    let mut out = Vec::new();
    for (row, score, closest) in scored.into_iter().take(25) {
        if let Some(track) = db::load_track(conn, &index.ids[row])? {
            out.push(Match {
                track,
                score,
                group: "misfit",
                reason: format!("closest: {}", label(conn, &index.ids[closest])),
            });
        }
    }
    Ok(out)
}

/// Library songs whose title or artist contains `query` (for picking seed songs).
pub fn search(conn: &Connection, query: &str) -> AppResult<Vec<Track>> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let pattern = format!("%{}%", q.replace('%', "").replace('_', ""));
    let mut stmt = conn.prepare(&format!(
        "SELECT DISTINCT t.id FROM tracks t
         JOIN playlist_tracks pt ON pt.track_id = t.id
         JOIN playlists p ON p.id = pt.playlist_id AND p.present = 1 AND p.kind IN ({HEARD_KINDS})
         WHERE t.name LIKE ?1
            OR EXISTS (SELECT 1 FROM track_artists a WHERE a.track_id = t.id AND a.artist_name LIKE ?1)
         LIMIT 25"
    ))?;
    let ids: Vec<String> = stmt.query_map(params![pattern], |r| r.get(0))?.collect::<Result<_, _>>()?;
    Ok(ids.iter().filter_map(|id| db::load_track(conn, id).ok().flatten()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs the searches against the real app database. `cargo test -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn explore_on_real_library() {
        let path = std::path::Path::new(&std::env::var("APPDATA").unwrap())
            .join("com.richardnguyen.spotifysorter")
            .join("sorter.db");
        let conn = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let t = std::time::Instant::now();
        let index = VectorIndex::build(&conn).unwrap();
        println!("index: {} songs in {:?}", index.len(), t.elapsed());

        for name in ["the moon", "positive pool"] {
            let id: String = conn
                .query_row("SELECT id FROM playlists WHERE name = ?1", [name], |r| r.get(0))
                .unwrap();
            let t = std::time::Instant::now();
            let grown = grow(&index, &conn, &id, false).unwrap();
            println!("\ngrow '{name}' ({:?}):", t.elapsed());
            for group in ["artist", "sound"] {
                for m in grown.iter().filter(|m| m.group == group).take(4) {
                    println!("  [{group}] {:.3}  {} – {}   ({})", m.score, m.track.name, m.track.artists[0].name, m.reason);
                }
            }
            let odd = misfits(&index, &conn, &id).unwrap();
            for m in odd.iter().take(3) {
                println!("  [misfit] {:.3}  {} – {}   ({})", m.score, m.track.name, m.track.artists[0].name, m.reason);
            }
        }
    }
}
