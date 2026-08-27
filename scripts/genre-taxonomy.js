/**
 * Last.fm's top tags are folksonomy, not a genre list: alongside "nu metal" you
 * get "seen live", "american", "2017", "albums i own" and the artist's own name.
 * Left raw, a recap would proudly announce that your top genre of the year was
 * "male vocalists". This module filters tags down to things that are actually
 * genres and merges the obvious spelling variants.
 */

/** Tags that are never a genre, matched exactly after lowercasing/trimming. */
const NON_GENRE_TAGS = new Set([
  'seen live', 'favorites', 'favourites', 'favorite', 'favourite', 'favorite songs',
  'love', 'loved', 'beautiful', 'awesome', 'amazing', 'cool', 'catchy', 'epic',
  'male vocalists', 'female vocalists', 'male vocalist', 'female vocalist',
  'male vocals', 'female vocals', 'vocal', 'vocalists', 'singer-songwriter women',
  'my music', 'my favorites', 'my favourites', 'albums i own', 'i own it',
  'music', 'song', 'songs', 'album', 'albums', 'track', 'tracks', 'artist',
  'spotify', 'shazam', 'itunes', 'radio', 'playlist', 'mp3', 'youtube',
  'under 2000 listeners', 'best', 'best songs', 'good', 'great', 'perfect',
  'banger', 'bangers', 'masterpiece', 'classic', 'classics', 'legend', 'legends',
  'guilty pleasure', 'nostalgia', 'memories', 'sad', 'happy', 'chill', 'relax',
  'party', 'workout', 'summer', 'winter', 'driving', 'sleep', 'study',
  'new', 'old', 'oldies', 'modern', 'contemporary', 'current', 'recent',
  'hits', 'hit', 'top 40', 'charts', 'mainstream', 'popular', 'underrated',
  'covers', 'cover', 'remix', 'live', 'acoustic version', 'instrumental version',
  'soundtrack', 'ost', 'movie', 'film', 'tv', 'anime', 'game', 'video game',
  'composer', 'producer', 'band', 'duo', 'group', 'solo',
]);

/** Nationality / language tags — real, but not what "top genre" should mean. */
const PLACE_TAGS = new Set([
  'american', 'british', 'usa', 'us', 'uk', 'english', 'canadian', 'australian',
  'irish', 'scottish', 'swedish', 'norwegian', 'finnish', 'danish', 'german',
  'french', 'italian', 'spanish', 'dutch', 'belgian', 'russian', 'polish',
  'japanese', 'korean', 'chinese', 'indian', 'brazilian', 'mexican', 'african',
  'nigerian', 'jamaican', 'icelandic', 'australia', 'england', 'london',
  'new york', 'california', 'los angeles', 'detroit', 'chicago', 'seattle',
  'nashville', 'texas', 'toronto', 'europe', 'european', 'latin america',
  'israeli', 'turkish', 'greek', 'portuguese', 'argentine', 'colombian',
]);

/** Spelling and shorthand variants collapsed onto one display form. */
const TAG_ALIASES = new Map(Object.entries({
  'hip hop': 'hip-hop',
  hiphop: 'hip-hop',
  'hip-hop/rap': 'hip-hop',
  rap: 'hip-hop',
  'rap/hip-hop': 'hip-hop',
  rnb: 'r&b',
  'r and b': 'r&b',
  'rhythm and blues': 'r&b',
  'contemporary r&b': 'r&b',
  'alt-rock': 'alternative rock',
  alternative: 'alternative rock',
  alt: 'alternative rock',
  'indie-rock': 'indie rock',
  'indie-pop': 'indie pop',
  'synth pop': 'synthpop',
  'synth-pop': 'synthpop',
  'dream-pop': 'dream pop',
  'electro pop': 'electropop',
  'electro-pop': 'electropop',
  electronica: 'electronic',
  edm: 'electronic',
  'electronic dance music': 'electronic',
  'drum and bass': 'drum & bass',
  dnb: 'drum & bass',
  'drum n bass': 'drum & bass',
  'nu-metal': 'nu metal',
  'heavy-metal': 'heavy metal',
  'post-hardcore': 'post hardcore',
  'pop-punk': 'pop punk',
  'punk-rock': 'punk rock',
  'folk-rock': 'folk rock',
  'country rock': 'country',
  'singer songwriter': 'singer-songwriter',
  'singer/songwriter': 'singer-songwriter',
  'bollywood music': 'bollywood',
  'hindi pop': 'bollywood',
  hindi: 'bollywood',
  'indian pop': 'bollywood',
  'k pop': 'k-pop',
  kpop: 'k-pop',
  'j pop': 'j-pop',
  jpop: 'j-pop',
  'trip hop': 'trip-hop',
  'lo fi': 'lo-fi',
  lofi: 'lo-fi',
  'new-wave': 'new wave',
  'classic-rock': 'classic rock',
  'hard-rock': 'hard rock',
  'soft-rock': 'soft rock',
  'psychedelic-rock': 'psychedelic rock',
  'progressive-rock': 'progressive rock',
  'prog rock': 'progressive rock',
  'art-pop': 'art pop',
  'bedroom-pop': 'bedroom pop',
  'emo-rap': 'emo rap',
  'cloud rap': 'hip-hop',
  'gangsta rap': 'hip-hop',
  'conscious hip hop': 'hip-hop',
  'west coast rap': 'hip-hop',
  'east coast rap': 'hip-hop',
  'orchestral': 'classical',
  'score': 'classical',
  'film score': 'classical',
  'modern classical': 'classical',
  'neo-classical': 'classical',
  'neoclassical': 'classical',
}));

/** Display casing for genres whose canonical form isn't plain Title Case. */
const DISPLAY_OVERRIDES = new Map(Object.entries({
  'hip-hop': 'Hip-Hop',
  'r&b': 'R&B',
  'drum & bass': 'Drum & Bass',
  'lo-fi': 'Lo-Fi',
  'k-pop': 'K-Pop',
  'j-pop': 'J-Pop',
  'trip-hop': 'Trip-Hop',
  edm: 'EDM',
  'singer-songwriter': 'Singer-Songwriter',
}));

/** A bare year ("2017") or a decade ("80s", "1990s") is metadata, not a genre. */
const YEARISH = /^(19|20)\d{2}s?$|^'?\d0s$|^\d{4}-\d{4}$/;

/**
 * Normalises one raw tag to a canonical genre slug, or null if it isn't a genre.
 * `artistName` is excluded because self-tagging ("eminem" on Eminem) is rampant.
 */
export function canonicalizeTag(raw, artistName = '') {
  if (!raw) return null;
  const tag = raw.toLowerCase().trim().replace(/\s+/g, ' ');
  if (!tag || tag.length > 30) return null;
  if (YEARISH.test(tag)) return null;
  if (NON_GENRE_TAGS.has(tag) || PLACE_TAGS.has(tag)) return null;
  if (artistName && tag === artistName.toLowerCase().trim()) return null;

  const canonical = TAG_ALIASES.get(tag) ?? tag;
  // Re-check: an alias can map onto something the blocklists cover.
  if (NON_GENRE_TAGS.has(canonical) || PLACE_TAGS.has(canonical)) return null;
  return canonical;
}

export function genreDisplayName(slug) {
  const override = DISPLAY_OVERRIDES.get(slug);
  if (override) return override;
  return slug
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Tags are returned by Last.fm in popularity order, so earlier tags describe the
 * artist better. Weighting by rank stops a long tail of loosely-related tags
 * from outvoting the one tag that actually names the genre.
 */
export function tagWeight(index) {
  return 1 / (index + 1);
}
