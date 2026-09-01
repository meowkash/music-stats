/**
 * Title/artist normalization and episodic-release parsing.
 *
 * Scrobbles arrive from Apple Music as three plain strings — the catalog ID
 * that Apple itself renders artwork from is not carried across. So matching has
 * to work from decorated human titles like "Black Room Boy - Original Mix" or
 * "A State of Trance 1234", which no catalog lists verbatim.
 */

/** Trailing decorations that describe a version, not a different release. */
const VERSION_SUFFIX = new RegExp(
  String.raw`\s*[-–—]\s*(` +
    [
      'original mix',
      'radio (?:edit|version|mix)',
      'extended (?:mix|version)',
      'club mix',
      'instrumental',
      'acoustic',
      'live',
      'remaster(?:ed)?(?:\\s+\\d{4})?',
      '\\d{4}\\s+remaster(?:ed)?',
      'single version',
      'album version',
      'bonus track',
      'deluxe(?: edition)?',
      'custom(?: edition)?',
      'mono|stereo',
      '.*\\bremix\\b.*',
      '.*\\bmix(?:ed)?\\s+by\\b.*',
    ].join('|') +
    `)\\s*$`,
  'i',
);

/** Bracketed decorations anywhere in the string. */
const BRACKETED_NOISE =
  /\s*[([{](?:feat\.?|ft\.?|featuring|with|prod\.?|mixed by|remaster(?:ed)?|deluxe|custom(?: edition)?|bonus|explicit|clean|radio edit|original mix|extended|live|instrumental|acoustic)[^)\]}]*[)\]}]/gi;

/** Episodic releases: "A State of Trance 1234", "Group Therapy 500", "ASOT Episode 900". */
const EPISODIC = /^(?<series>.*?[a-z].*?)\s*(?:[-–—:,]\s*)?(?:episode|ep\.?|edition|vol\.?|volume|part|pt\.?|#)?\s*(?<number>\d{2,4})\s*$/i;

/** Series names too generic to safely share one cover across episodes. */
const MIN_SERIES_WORD_COUNT = 2;

export function canonicalAlbumTitle(albumName) {
  if (!albumName) return '';
  const trimmed = String(albumName).trim();
  return stripDecorations(trimmed) || trimmed;
}

/** Stable key for merging deluxe/custom/remaster editions per artist. */
export function albumGroupingKey(artistName, albumName) {
  const base = canonicalAlbumTitle(albumName);
  if (!base) return '';
  return `${normalizeForCompare(artistName)}|${normalizeForCompare(base)}`;
}

export function stripDecorations(title) {
  if (!title) return '';

  let out = String(title);
  let previous;
  do {
    previous = out;
    out = out.replace(BRACKETED_NOISE, '').replace(VERSION_SUFFIX, '');
  } while (out !== previous);

  return out.trim() || String(title).trim();
}

/** Lowercase, unaccent, drop punctuation — the form used for comparison only. */
export function normalizeForCompare(value) {
  if (!value) return '';
  return String(value)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function tokenize(value) {
  const normalized = normalizeForCompare(value);
  return normalized ? normalized.split(' ') : [];
}

/**
 * Split an episodic title into its series and episode number.
 * Returns null when the title isn't episodic, or when the series part is too
 * short to be a meaningful series (avoids treating "Blink 182" as an episode).
 */
export function parseEpisodic(title) {
  const match = EPISODIC.exec(stripDecorations(title));
  if (!match?.groups) return null;

  const series = match.groups.series.replace(/[-–—:,]\s*$/, '').trim();
  if (!series) return null;
  if (tokenize(series).length < MIN_SERIES_WORD_COUNT) return null;

  return { series, number: Number(match.groups.number) };
}

/** Artist strings can carry collaborators the catalog files separately. */
export function primaryArtist(artistName) {
  if (!artistName) return '';
  return String(artistName)
    .split(/\s*(?:,|&|\bfeat\.?\b|\bft\.?\b|\bwith\b|\bvs\.?\b|\bx\b)\s*/i)[0]
    .trim();
}
