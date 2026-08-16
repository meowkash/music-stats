import { normalizeForCompare, tokenize } from './normalize.js';

/**
 * Match scoring.
 *
 * The old resolver took `limit=1` from iTunes with no verification, so a query
 * that had no real match still cached whatever came back first — wrong covers
 * were as likely an outcome as missing ones. Everything here exists to make
 * "no match" a result the caller can act on.
 */

/** Fraction of the shorter token set that appears in the longer one. */
function tokenSetRatio(a, b) {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (!left.size || !right.size) return 0;

  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;

  return shared / Math.min(left.size, right.size);
}

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

export function similarity(a, b) {
  if (!a || !b) return 0;
  return Math.max(tokenSetRatio(a, b), levenshteinRatio(a, b));
}

/**
 * Acceptance thresholds. Artist is held to a higher bar than title because a
 * wrong artist is always wrong, whereas titles legitimately vary in decoration.
 */
export const ARTIST_THRESHOLD = 0.8;
export const TITLE_THRESHOLD = 0.7;
/** Artist-only lookups have no title to corroborate, so they must be near-exact. */
export const ARTIST_ONLY_THRESHOLD = 0.9;

/**
 * @returns {{accepted: boolean, score: number, artistScore: number, titleScore: number}}
 */
export function scoreCandidate(query, candidate) {
  const wantsArtist = Boolean(query.artistName);
  const wantsTitle = Boolean(query.name);

  const artistScore = wantsArtist ? similarity(query.artistName, candidate.artistName) : 1;
  const titleScore = wantsTitle ? similarity(query.name, candidate.name) : 1;

  let accepted;
  if (wantsArtist && wantsTitle) {
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
