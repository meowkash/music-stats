// Apple Music scrobbles carry three plain strings, not the catalog ID it renders
// artwork from — so matching works from decorated titles no catalog lists.

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

/** Titles that explicitly identify a compilation rather than a solo release. */
export function isCompilationAlbum(albumName) {
  const title = String(albumName ?? '');
  return /\b(?:soundtrack|original score|dj mix|compilation|various artists|year mix|mixed by|motion picture|music pack|yearbook|episode|official album)\b|^official\b.*\balbum\b|:\s*the album(?:\s|$)/i.test(title)
    || parseEpisodic(title) !== null;
}

/** Whether a release title names the artist ("Hannah Montana 2" for Hannah
 *  Montana) — the one case where a compilation's cover is that artist's. */
export function titleNamesArtist(albumName, artistName) {
  const artist = normalizeForCompare(primaryArtist(artistName));
  return !!artist && ` ${normalizeForCompare(albumName)} `.includes(` ${artist} `);
}

/** A compilation's cover belongs to the release, not to each performer on it:
 *  ZAYN is not the Fifty Shades Darker poster. */
export function isArtistsOwnCover(albumName, artistName) {
  return !isCompilationAlbum(albumName) || titleNamesArtist(albumName, artistName);
}

/** Editions and guest credits share a release; unrelated lead artists do not.
 * Scrobbles carry track artists, so explicitly named compilations use their
 * title as identity. Catalog release IDs would be needed for ambiguous cases.
 */
export function albumGroupingKey(artistName, albumName) {
  const base = canonicalAlbumTitle(albumName);
  if (!base) return '';
  const owner = isCompilationAlbum(albumName) ? 'compilation' : primaryArtist(artistName);
  return `${normalizeForCompare(owner)}|${normalizeForCompare(base)}`;
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

/** Lowercase, unaccent, drop punctuation — the form used for comparison only.
 *  Letters and digits of every script survive: an ASCII-only filter turned
 *  "Голая - Single" and "Худшая - Single" into the same "single", and Ed
 *  Sheeran's "+", "=" and "÷" into nothing, merging each set into one album.
 *  A title that is only symbols is its own key. */
export function normalizeForCompare(value) {
  if (!value) return '';
  const raw = String(value).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const words = raw.replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return words || raw.replace(/\s+/g, '');
}

export function tokenize(value) {
  const normalized = normalizeForCompare(value);
  return normalized ? normalized.split(' ') : [];
}

// Splits an episodic title into series + episode number, or null. Short series
// parts are rejected so "Blink 182" isn't read as an episode.
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
