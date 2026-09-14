import { parseEpisodic, primaryArtist, stripDecorations } from './normalize.js';
import { pickBest } from './score.js';
import { searchDeezer, searchItunes, searchLastfm, searchMusicBrainz } from './sources.js';

// For titles no catalog lists verbatim (DJ mixes, episodic shows). A query ladder
// (exact→undecorated→series→artist) plus series memoization collapses the lookups.

const REQUEST_PAUSE_MS = 150;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ITUNES_ENTITY = { album: 'album', artist: 'musicArtist', track: 'song' };
const DEEZER_TYPE = { album: 'album', artist: 'artist', track: 'track' };

// Each rung carries the query it is *scored* against, which differs from what it
// searches: a series lookup is judged against the series, not the episode title.
export function buildLadder({ type, name, artistName }) {
  const rungs = [];
  const bareArtist = primaryArtist(artistName);
  const undecorated = stripDecorations(name);
  const episodic = parseEpisodic(name);

  const push = (rung) => {
    if (!rung.term?.trim()) return;
    if (rungs.some((existing) => existing.term === rung.term && existing.type === rung.type)) return;
    rungs.push(rung);
  };

  if (type === 'artist') {
    push({ label: 'artist', type: 'artist', term: name, expect: { name, artistName: name } });
    if (bareArtist && bareArtist !== name) {
      push({ label: 'primary-artist', type: 'artist', term: bareArtist, expect: { name: bareArtist, artistName: bareArtist } });
    }
    return rungs;
  }

  push({
    label: 'exact',
    type,
    term: `${artistName} ${name}`,
    expect: { name, artistName },
  });

  if (undecorated !== name) {
    push({
      label: 'undecorated',
      type,
      term: `${artistName} ${undecorated}`,
      expect: { name: undecorated, artistName },
    });
  }

  if (bareArtist && bareArtist !== artistName) {
    push({
      label: 'primary-artist',
      type,
      term: `${bareArtist} ${undecorated}`,
      expect: { name: undecorated, artistName: bareArtist },
    });
  }

  // The episode number is the part no catalog knows; the series is the part it does.
  if (episodic) {
    push({
      label: 'series',
      type: 'album',
      term: artistName ? `${artistName} ${episodic.series}` : episodic.series,
      expect: { name: episodic.series, artistName },
      seriesKey: episodic.series,
    });
  }

  push({
    label: 'title-only',
    type,
    term: undecorated,
    expect: { name: undecorated, artistName: '' },
  });

  return rungs;
}

async function gatherCandidates(rung, { lastfmKey, artistName, name }) {
  const candidates = [];
  const collect = async (fn) => {
    try {
      candidates.push(...(await fn()));
    } catch {
      /* one source failing must not sink the rung */
    }
    await delay(REQUEST_PAUSE_MS);
  };

  await collect(() => searchItunes(rung.term, ITUNES_ENTITY[rung.type] ?? 'album'));
  if (candidates.length === 0) {
    await collect(() => searchDeezer(rung.term, DEEZER_TYPE[rung.type] ?? 'album'));
  }
  if (candidates.length === 0 && rung.type !== 'artist') {
    await collect(() => searchMusicBrainz(rung.expect.name, rung.expect.artistName));
  }
  if (candidates.length === 0) {
    await collect(() => searchLastfm(lastfmKey, { type: rung.type, name, artistName }));
  }

  return candidates;
}

// Resolve one entity to an artwork URL, or null when nothing scores as a match.
export async function resolveArtwork(entity, options = {}) {
  const { lastfmKey, seriesCache, onAttempt } = options;
  const { type, name, artistName = '' } = entity;

  const episodic = type !== 'artist' ? parseEpisodic(name) : null;
  const seriesKey = episodic ? `${primaryArtist(artistName)}|${episodic.series}` : null;

  // Every other episode of this series already resolved to the same cover.
  if (seriesKey && seriesCache?.has(seriesKey)) {
    const cached = seriesCache.get(seriesKey);
    if (cached) {
      onAttempt?.({ label: 'series-cache', accepted: true });
      return { ...cached, via: 'series-cache' };
    }
  }

  for (const rung of buildLadder({ type, name, artistName })) {
    const candidates = await gatherCandidates(rung, { lastfmKey, artistName, name });
    const best = pickBest(rung.expect, candidates);

    onAttempt?.({
      label: rung.label,
      term: rung.term,
      candidates: candidates.length,
      accepted: Boolean(best),
      score: best?.score,
    });

    if (!best) continue;

    const resolved = { url: best.url, via: rung.label, source: best.source, score: best.score };
    if (rung.seriesKey && seriesCache) {
      seriesCache.set(`${primaryArtist(artistName)}|${rung.seriesKey}`, resolved);
    }
    return resolved;
  }

  // Remember the failure too, so 300 episodes don't each retry the whole ladder.
  if (seriesKey && seriesCache) seriesCache.set(seriesKey, null);
  return null;
}
