import { normalizeForCompare, primaryArtist, tokenize } from './normalize.js';

// The old resolver took iTunes `limit=1` unverified, so a query with no real
// match still cached whatever came first. This makes "no match" actionable.

/** Words that describe an edition or a soundtrack rather than which release
 *  it is, so "(Original Motion Picture Soundtrack)" and "(Soundtrack)" agree. */
const EDITION_WORDS = new Set([
  'the', 'a', 'an', 'and', 'original', 'motion', 'picture', 'soundtrack', 'ost', 'music', 'from',
  'score', 'official', 'edition', 'deluxe', 'expanded', 'remastered', 'remaster', 'version',
  'anniversary', 'bonus', 'tracks', 'series', 'album', 'video', 'game', 'tv', 'television',
  // Whether a single may stand in for an album is SINGLE_OR_EP's call below.
  'single', 'ep',
]);

/** Shared tokens over the shorter set plus whatever the longer one adds that
 *  is not edition noise. Containment alone let "Drake" match "Drake Bell",
 *  "Queen" match "Queen Naija" and "Love" match "Love Songs: Greatest Hits". */
function tokenSetRatio(a, b) {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (!left.size || !right.size) return 0;
  const [shorter, longer] = left.size <= right.size ? [left, right] : [right, left];

  let shared = 0;
  for (const token of shorter) if (longer.has(token)) shared++;
  let extra = 0;
  // A year on one side only is an edition; numbersAgree() rejects two different ones.
  for (const token of longer) if (!shorter.has(token) && !EDITION_WORDS.has(token) && !/^(?:19|20)\d\d$/.test(token)) extra++;

  return shared / (shorter.size + extra);
}

/** How stores credit a compilation instead of its performers. */
const VARIOUS_ARTISTS = /^(?:various(?: artists)?|va|v a|multi interpretes|verschiedene interpreten|artistes divers|varios artistas|original (?:motion picture )?soundtrack|soundtrack|(?:original )?cast)$/;
export function isVariousArtists(name) {
  return VARIOUS_ARTISTS.test(normalizeForCompare(name));
}

/** A store's single or EP is a different release from a full album. */
const SINGLE_OR_EP = /\s[-–—]\s(?:single|ep)\s*$|\((?:single|ep)\)\s*$/i;

/** Normalized edit distance, for catching near-miss spellings. */
function levenshteinRatio(a, b) {
  const left = normalizeForCompare(a);
  const right = normalizeForCompare(b);
  if (!left || !right) return 0;
  if (left === right) return 1;

  const rows = left.length + 1;
  const cols = right.length + 1;
  let previous = Array.from({ length: cols }, (_, i) => i);

  for (let i = 1; i < rows; i++) {
    const current = [i];
    for (let j = 1; j < cols; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }

  return 1 - previous[cols - 1] / Math.max(left.length, right.length);
}

/** Sequel and volume numbers carry identity, so "Shrek" is not "Shrek 2"
 *  however close the strings are. A year only one side mentions is an edition
 *  ("Remastered 2019"); two different years are different releases. */
function numbersAgree(a, b) {
  const numbers = (value) => tokenize(value).filter((token) => /^\d+$/.test(token));
  const isYear = (n) => /^(?:19|20)\d\d$/.test(n);
  const [left, right] = [numbers(a), numbers(b)];
  const plain = (list) => list.filter((n) => !isYear(n)).map(Number).sort().join(',');
  if (plain(left) !== plain(right)) return false;
  const [leftYears, rightYears] = [left.filter(isYear), right.filter(isYear)];
  return !leftYears.length || !rightYears.length || leftYears.some((year) => rightYears.includes(year));
}

export function similarity(a, b) {
  if (!a || !b) return 0;
  if (!numbersAgree(a, b)) return 0;
  return Math.max(tokenSetRatio(a, b), levenshteinRatio(a, b));
}

/** Credits list guests the other side may omit: compare lead artists too. */
function artistSimilarity(a, b) {
  return Math.max(similarity(a, b), similarity(primaryArtist(a), primaryArtist(b)));
}

// Artist is held to a higher bar than title: a wrong artist is always wrong,
// whereas titles legitimately vary in decoration.
export const ARTIST_THRESHOLD = 0.8;
export const TITLE_THRESHOLD = 0.7;
/** Artist-only lookups have no title to corroborate, so they must be near-exact. */
export const ARTIST_ONLY_THRESHOLD = 0.9;
/** A compilation matched on its title alone (credited to Various Artists, or
 *  found through one of its songs) has no artist to corroborate it either. */
export const COMPILATION_TITLE_THRESHOLD = 0.85;

// Returns { accepted, score, artistScore, titleScore }.
//
// query.kind 'album' with query.multiTrack (more than one song played from
// it) rejects singles/EPs: that release is the album, so a single's cover is
// a different one. With one song it may well be the single. query.compilation also accepts a
// Various Artists credit. query.viaTrack matches a song result: its title is
// the song, and the album it sits on (candidate.album) must be query.album.
export function scoreCandidate(query, candidate) {
  const wantsArtist = Boolean(query.artistName);
  const wantsTitle = Boolean(query.name);

  let artistScore = wantsArtist ? artistSimilarity(query.artistName, candidate.artistName) : 1;
  const titleScore = wantsTitle ? similarity(query.name, candidate.name) : 1;
  const various = query.compilation && isVariousArtists(candidate.artistName);
  if (various) artistScore = 1;

  let accepted;
  if (query.kind === 'album' && query.multiTrack && SINGLE_OR_EP.test(candidate.name ?? '') && !SINGLE_OR_EP.test(query.name ?? '')) {
    accepted = false;
  } else if (query.viaTrack) {
    const albumScore = similarity(query.album, candidate.album);
    accepted = artistScore >= ARTIST_THRESHOLD && titleScore >= TITLE_THRESHOLD && albumScore >= COMPILATION_TITLE_THRESHOLD;
    return { accepted, artistScore, titleScore, albumScore, score: (artistScore + titleScore + albumScore) / 3 };
  } else if (various) {
    accepted = titleScore >= COMPILATION_TITLE_THRESHOLD;
  } else if (wantsArtist && wantsTitle) {
    accepted = artistScore >= ARTIST_THRESHOLD && titleScore >= TITLE_THRESHOLD;
  } else if (wantsTitle) {
    accepted = titleScore >= ARTIST_ONLY_THRESHOLD;
  } else {
    accepted = artistScore >= ARTIST_ONLY_THRESHOLD;
  }

  return {
    accepted,
    artistScore,
    titleScore,
    score: (artistScore + titleScore) / 2,
  };
}

/** Best accepted candidate, or null when nothing clears the bar. */
export function pickBest(query, candidates) {
  let best = null;

  for (const candidate of candidates) {
    if (!candidate?.url) continue;
    const result = scoreCandidate(query, candidate);
    if (!result.accepted) continue;
    if (!best || result.score > best.score) best = { ...candidate, ...result };
  }

  return best;
}
