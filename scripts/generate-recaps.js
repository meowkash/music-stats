/**
 * Builds the per-year story payloads behind the Recaps tab.
 *
 * Output: public/data/recaps.json (index) + public/data/recap-<year>.json.
 *
 * All the heavy lifting happens here rather than in the browser: the raw
 * enrichment cache is ~1 MB of tags the client would otherwise download and
 * re-aggregate on every launch. Each year's payload is a few KB instead, and is
 * fetched only when that year's story is opened.
 */
import fs from 'fs';
import path from 'path';
import { readScrobbles } from './scrobble-source.js';
import { buildArtistAttribution, loadOverrides, parseArtistCredits } from './artist-resolve.js';
import { albumGroupingKey, canonicalAlbumTitle } from './resolve-artwork/normalize.js';
import { canonicalizeTag, genreDisplayName, tagWeight } from './genre-taxonomy.js';

const PUBLIC_DATA_DIR = path.resolve('public/data');
const CACHE_PATH = path.resolve('src/data/recap-meta-cache.json');

/**
 * Hours-of-day and weekday stories are meaningless in UTC, so scrobbles are
 * bucketed in the listener's own timezone. Override with RECAP_TIMEZONE.
 */
const TIMEZONE = process.env.RECAP_TIMEZONE || 'America/New_York';

/** Below this a "year in review" is noise — 2021 here is nine days of data. */
const MIN_SCROBBLES = 400;

/** Used only for tracks Last.fm has no duration for. */
const FALLBACK_TRACK_MS = 210_000;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const SEASONS = [
  { name: 'Winter', months: [11, 0, 1] },
  { name: 'Spring', months: [2, 3, 4] },
  { name: 'Summer', months: [5, 6, 7] },
  { name: 'Autumn', months: [8, 9, 10] },
];

const trackKey = (name, artist) => `${name}\0${artist}`;

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

/**
 * Resolves a UTC timestamp into local calendar fields. Intl is the only way to
 * get this right across DST, so results are memoised per minute — consecutive
 * scrobbles cluster heavily and this cuts the formatter calls by ~10x.
 */
function createLocalTimeResolver(timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const cache = new Map();

  return (uts) => {
    const minute = Math.floor(uts / 60);
    const hit = cache.get(minute);
    if (hit) return hit;

    const parts = formatter.formatToParts(new Date(uts * 1000));
    const field = {};
    for (const { type, value } of parts) field[type] = value;

    const resolved = {
      year: Number(field.year),
      month: Number(field.month) - 1,
      day: Number(field.day),
      hour: Number(field.hour) % 24,
      weekday: WEEKDAY_INDEX[field.weekday] ?? 0,
      date: `${field.year}-${field.month}-${field.day}`,
    };
    cache.set(minute, resolved);
    return resolved;
  };
}

function topEntries(counts, limit) {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, limit);
}

function bump(map, key, by = 1) {
  if (key === undefined || key === null || key === '') return;
  map.set(key, (map.get(key) ?? 0) + by);
}

function share(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}

/** Longest run of consecutive calendar days with at least one scrobble. */
function longestStreak(dateSet) {
  const days = [...dateSet].sort();
  let best = 0;
  let run = 0;
  let previous = null;

  for (const day of days) {
    const time = Date.parse(`${day}T00:00:00Z`);
    run = previous !== null && time - previous === 86_400_000 ? run + 1 : 1;
    previous = time;
    if (run > best) best = run;
  }
  return best;
}

function timeOfDayArchetype(peakHour) {
  if (peakHour >= 5 && peakHour < 9) return { label: 'Early Bird', blurb: 'The day starts with a soundtrack.' };
  if (peakHour >= 9 && peakHour < 12) return { label: 'Morning Mover', blurb: 'The best listening happens before lunch.' };
  if (peakHour >= 12 && peakHour < 17) return { label: 'Afternoon Drifter', blurb: 'Music carries the middle of the day.' };
  if (peakHour >= 17 && peakHour < 21) return { label: 'Golden Hour', blurb: 'The evening winds down on repeat.' };
  if (peakHour >= 21 && peakHour < 24) return { label: 'Night Owl', blurb: 'The later it gets, the louder it gets.' };
  return { label: 'After Hours', blurb: 'The music keeps going long past midnight.' };
}

/**
 * Four independent signals, because no single one describes a year:
 *
 *   breadth    — distinct artists per 100 plays (how wide the net was)
 *   devotion   — share held by the single favourite artist
 *   repeat     — average plays per distinct track (how hard things were looped)
 *   rhythm     — how many days of the year had music, and how dense they were
 *
 * Checked most-distinctive first: a year with a 30%-share top artist is a
 * Devotee year no matter how the other numbers fall.
 */
function listeningStyle({
  scrobbles,
  uniqueArtists,
  uniqueTracks,
  uniqueAlbums,
  topArtistShare,
  topFiveShare,
  activeDays,
  daysInYear,
}) {
  const breadth = (uniqueArtists / scrobbles) * 100;
  const repeat = uniqueTracks > 0 ? scrobbles / uniqueTracks : 0;
  const coverage = daysInYear > 0 ? activeDays / daysInYear : 0;
  const intensity = activeDays > 0 ? scrobbles / activeDays : 0;
  const tracksPerAlbum = uniqueAlbums > 0 ? uniqueTracks / uniqueAlbums : 0;

  if (topArtistShare >= 28) {
    return { label: 'Devotee', blurb: 'One artist owned the year, and I was not subtle about it.' };
  }
  if (repeat >= 10) {
    return { label: 'On Repeat', blurb: 'Once a song landed, it did not get a rest for weeks.' };
  }
  if (breadth >= 14) {
    return { label: 'Explorer', blurb: 'Barely the same thing twice — the map kept getting bigger.' };
  }
  if (breadth >= 10) {
    return { label: 'Cartographer', blurb: 'A year of first listens, charted one new artist at a time.' };
  }
  if (topArtistShare >= 13 || topFiveShare >= 45) {
    return { label: 'Inner Circle', blurb: 'A short list of names did most of the work, and they earned it.' };
  }
  if (intensity >= 70 && coverage < 0.6) {
    return { label: 'Binge Listener', blurb: 'Quiet stretches, then days that never turned the music off.' };
  }
  if (coverage >= 0.92 && intensity < 45) {
    return { label: 'Daily Ritual', blurb: 'Almost every single day had something playing. Never loud, never absent.' };
  }
  if (intensity >= 55) {
    return { label: 'Marathoner', blurb: 'Long sessions rather than short bursts — press play and leave it.' };
  }
  if (tracksPerAlbum >= 9) {
    return { label: 'Album Sitter', blurb: 'Records front to back, the way they were sequenced to be heard.' };
  }
  if (breadth >= 7) {
    return { label: 'Wanderer', blurb: 'A steady rotation with plenty of detours along the way.' };
  }
  if (repeat >= 5.5) {
    return { label: 'Creature of Habit', blurb: 'A familiar shortlist, revisited far more often than it was replaced.' };
  }
  if (breadth >= 4) {
    return { label: 'Regular', blurb: 'A known set of favourites, returned to again and again.' };
  }
  return { label: 'Loyalist', blurb: 'A tight circle of favourites, played into the ground.' };
}

/**
 * Genre families, scored by summed share rather than mere presence. Checking
 * membership in priority order made almost every year come out the same, since
 * a 5%-share genre high in the list outranked a 20%-share one below it.
 *
 * Deliberately fine-grained: one broad "electronic" family made every year
 * with any dance music in it come out identical. Splitting the big rooms into
 * trance / club / bass / synth-pop (and the same for rock, rap and pop) is what
 * gives neighbouring years a chance to land somewhere different.
 */
const VIBE_FAMILIES = [
  {
    label: 'High Voltage',
    blurb: 'A year that ran loud, fast and with the gain turned up.',
    genres: ['metal', 'nu metal', 'heavy metal', 'alternative metal', 'metalcore',
      'hardcore', 'thrash metal', 'death metal', 'rapcore'],
  },
  {
    label: 'Basement Show',
    blurb: 'Short, fast and a little bruised — punk energy all year.',
    genres: ['punk', 'punk rock', 'pop punk', 'post hardcore', 'emo', 'screamo', 'ska'],
  },
  {
    label: 'Heavy Rotation',
    blurb: 'Bars, beats and basslines carried the year.',
    genres: ['hip-hop', 'boom bap', 'g-funk'],
  },
  {
    label: 'Trap House',
    blurb: 'Hi-hats, 808s and hooks that would not leave.',
    genres: ['trap', 'drill', 'grime', 'emo rap', 'cloud rap'],
  },
  {
    label: 'Trance State',
    blurb: 'Long builds, bigger breakdowns, and no interest in getting there quickly.',
    genres: ['trance', 'progressive trance', 'uplifting trance', 'vocal trance', 'psytrance'],
  },
  {
    label: 'Club Circuit',
    blurb: 'Four to the floor, from the warm-up right through to the last record.',
    genres: ['house', 'deep house', 'tech house', 'progressive house', 'techno',
      'minimal', 'garage', 'uk garage', 'afro house'],
  },
  {
    label: 'Bass Weight',
    blurb: 'Built around the low end and the break, not the chorus.',
    genres: ['drum & bass', 'dubstep', 'jungle', 'breakbeat', 'bass', 'future bass'],
  },
  {
    label: 'Neon Pulse',
    blurb: 'Synthetic, propulsive and built for movement.',
    genres: ['electronic', 'dance', 'synthpop', 'electro', 'electropop', 'eurodance',
      'synthwave', 'new wave'],
  },
  {
    label: 'Pop Instinct',
    blurb: 'Hooks first — songs built to stick, and they did.',
    genres: ['pop', 'dance-pop', 'power pop', 'teen pop'],
  },
  {
    label: 'Art Department',
    blurb: 'Pop with the edges left on and the production doing the talking.',
    genres: ['art pop', 'bedroom pop', 'indie pop', 'dream pop', 'hyperpop', 'chamber pop'],
  },
  {
    label: 'Pop Passport',
    blurb: 'Charts from somewhere else, on repeat here.',
    genres: ['k-pop', 'j-pop', 'c-pop', 'latin', 'reggaeton', 'afrobeats', 'amapiano'],
  },
  {
    label: 'Quiet Storyteller',
    blurb: 'Songs that take their time and expect to be listened to.',
    genres: ['folk', 'folk rock', 'indie folk', 'acoustic', 'singer-songwriter', 'americana'],
  },
  {
    label: 'Long Road',
    blurb: 'Twang, road songs and a chorus visible from a mile off.',
    genres: ['country', 'alt-country', 'bluegrass', 'blues', 'southern rock'],
  },
  {
    label: 'Deep Focus',
    blurb: 'Music as atmosphere — textured, patient, mostly wordless.',
    genres: ['classical', 'ambient', 'instrumental', 'post-rock', 'drone', 'minimalism'],
  },
  {
    label: 'Blue Note',
    blurb: 'Played by people listening to each other in real time.',
    genres: ['jazz', 'bebop', 'jazz fusion', 'bossa nova', 'swing'],
  },
  {
    label: 'Smooth Operator',
    blurb: 'Groove first, and never rushed.',
    genres: ['r&b', 'soul', 'funk', 'disco', 'neo-soul', 'motown'],
  },
  {
    label: 'Late Night Haze',
    blurb: 'Slowed down, softened at the edges, best after midnight.',
    genres: ['lo-fi', 'trip-hop', 'chillout', 'downtempo', 'chillwave', 'vaporwave'],
  },
  {
    label: 'Guitar Forward',
    blurb: 'Riffs did most of the heavy lifting this year.',
    genres: ['rock', 'classic rock', 'hard rock', 'psychedelic rock', 'grunge',
      'garage rock', 'blues rock'],
  },
  {
    label: 'Indie Sprawl',
    blurb: 'Guitars, but the kind that would rather not be famous about it.',
    genres: ['indie', 'indie rock', 'alternative rock', 'shoegaze', 'post-punk', 'math rock'],
  },
  {
    label: 'Prog Odyssey',
    blurb: 'Nothing under six minutes, and every one of them earned.',
    genres: ['progressive rock', 'progressive metal', 'art rock', 'krautrock'],
  },
  {
    label: 'Full Cinema',
    blurb: 'Big, melodic and unapologetically dramatic.',
    genres: ['bollywood', 'desi', 'bhangra', 'filmi', 'indipop'],
  },
  {
    label: 'Island Time',
    blurb: 'Off-beat guitars and a tempo that refuses to be hurried.',
    genres: ['reggae', 'dub', 'dancehall', 'ska punk', 'roots reggae'],
  },
];

/**
 * Catch-all tags that sit on almost every artist. Counted at half weight so a
 * generic "electronic" or "pop" tag cannot outvote the specific subgenre that
 * actually describes the year — that was what made four of five years come out
 * as the same vibe.
 */
const BROAD_SLUGS = new Set([
  'pop', 'rock', 'electronic', 'indie', 'alternative rock', 'dance',
]);

const BROAD_WEIGHT = 0.5;

function vibeFromGenres(genres) {
  const shares = new Map(genres.map((g) => [g.slug, g.share]));

  const scored = VIBE_FAMILIES.map((family) => ({
    family,
    score: family.genres.reduce(
      (sum, slug) => sum + (shares.get(slug) ?? 0) * (BROAD_SLUGS.has(slug) ? BROAD_WEIGHT : 1),
      0,
    ),
  }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const [best, runnerUp] = scored;

  if (best) {
    // A close second means the year genuinely sat between two rooms; say so
    // rather than pretending the leader had it to itself.
    const contested = runnerUp && runnerUp.score >= best.score * 0.7;
    return {
      label: best.family.label,
      blurb: contested
        ? `${best.family.blurb} ${runnerUp.family.label} was never far behind.`
        : best.family.blurb,
    };
  }

  const top = genres[0];
  if (top) {
    return { label: top.name, blurb: `${top.name} defined the shape of the year.` };
  }
  return { label: 'Wide Open', blurb: 'Too varied to pin down — and that is the point.' };
}

function main() {
  const cache = readJson(CACHE_PATH, { tracks: {}, artists: {} });
  const durations = cache.tracks ?? {};
  const artistTags = cache.artists ?? {};
  const overrides = loadOverrides();
  const localTime = createLocalTimeResolver(TIMEZONE);

  // Pass 1 — bucket every scrobble by year, resolving names once up front.
  const years = new Map();
  const rawArtistNames = [];
  const rawArtistIndex = new Map();
  const rawArtistCounts = [];

  const artistIdFor = (name) => {
    let id = rawArtistIndex.get(name);
    if (id === undefined) {
      id = rawArtistNames.length;
      rawArtistNames.push(name);
      rawArtistIndex.set(name, id);
      rawArtistCounts[id] = 0;
    }
    rawArtistCounts[id]++;
    return id;
  };

  let scanned = 0;
  for (const { uts, artist, album, track } of readScrobbles()) {
    const local = localTime(uts);
    let bucket = years.get(local.year);
    if (!bucket) {
      bucket = {
        scrobbles: 0,
        firstUts: uts,
        lastUts: uts,
        artists: new Map(),
        albums: new Map(),
        albumDisplayNames: new Map(),
        tracks: new Map(),
        albumArtist: new Map(),
        trackArtist: new Map(),
        trackAlbum: new Map(),
        byHour: new Array(24).fill(0),
        byWeekday: new Array(7).fill(0),
        byMonth: new Array(12).fill(0),
        dates: new Set(),
        dayCounts: new Map(),
        dayTopTrack: new Map(),
        genreByMonth: Array.from({ length: 12 }, () => new Map()),
        artistPlaysByMonth: new Map(),
        durationMs: 0,
        durationKnown: 0,
        rawArtistPlays: new Map(),
      };
      years.set(local.year, bucket);
    }

    bucket.scrobbles++;
    if (uts < bucket.firstUts) bucket.firstUts = uts;
    if (uts > bucket.lastUts) bucket.lastUts = uts;

    artistIdFor(artist);
    bump(bucket.rawArtistPlays, artist);
    if (album) {
      const albumKey = albumGroupingKey(artist, album);
      bump(bucket.albums, albumKey);
      bucket.albumArtist.set(albumKey, artist);
      if (!bucket.albumDisplayNames.has(albumKey)) {
        bucket.albumDisplayNames.set(albumKey, canonicalAlbumTitle(album));
      }
    }
    const tKey = trackKey(track, artist);
    bump(bucket.tracks, tKey);
    bucket.trackArtist.set(tKey, artist);
    if (album) bucket.trackAlbum.set(tKey, canonicalAlbumTitle(album));

    bucket.byHour[local.hour]++;
    bucket.byWeekday[local.weekday]++;
    bucket.byMonth[local.month]++;
    bucket.dates.add(local.date);
    bump(bucket.dayCounts, local.date);

    const dayTop = bucket.dayTopTrack.get(local.date) ?? new Map();
    bump(dayTop, tKey);
    bucket.dayTopTrack.set(local.date, dayTop);

    const monthArtists = bucket.artistPlaysByMonth.get(local.month) ?? new Map();
    bump(monthArtists, artist);
    bucket.artistPlaysByMonth.set(local.month, monthArtists);

    const duration = durations[tKey]?.duration;
    if (duration) {
      bucket.durationMs += duration;
      bucket.durationKnown++;
    } else {
      bucket.durationMs += FALLBACK_TRACK_MS;
    }

    scanned++;
  }

  console.log(`Scanned ${scanned.toLocaleString()} scrobbles across ${years.size} years (timezone ${TIMEZONE})`);

  // Canonical artist graph, so "A & B" credits both rather than inventing a duo.
  const attribution = buildArtistAttribution(rawArtistNames, overrides, rawArtistCounts, [], []);
  const { canonicalArtists, rawToCanonical } = attribution;

  const canonicalTagCache = new Map();
  const tagsForCanonical = (canonicalName) => {
    let tags = canonicalTagCache.get(canonicalName);
    if (tags) return tags;
    tags = artistTags[canonicalName]?.tags ?? [];
    canonicalTagCache.set(canonicalName, tags);
    return tags;
  };

  const index = [];

  for (const [year, bucket] of [...years.entries()].sort((a, b) => a[0] - b[0])) {
    if (bucket.scrobbles < MIN_SCROBBLES) {
      console.log(`Skipping ${year}: only ${bucket.scrobbles} scrobbles`);
      continue;
    }

    // Fold raw artist names onto canonical entities.
    const canonicalPlays = new Map();
    for (const [name, plays] of bucket.rawArtistPlays) {
      const rawId = rawArtistIndex.get(name);
      for (const cId of rawToCanonical[rawId] ?? [rawId]) {
        bump(canonicalPlays, canonicalArtists[cId] ?? name, plays);
      }
    }

    const topArtists = topEntries(canonicalPlays, 5).map(([name, plays]) => ({
      name,
      plays,
      share: share(plays, bucket.scrobbles),
    }));

    const topAlbums = topEntries(bucket.albums, 5).map(([key, plays]) => ({
      name: bucket.albumDisplayNames.get(key) ?? key,
      artist: bucket.albumArtist.get(key) ?? '',
      plays,
    }));

    const topTracks = topEntries(bucket.tracks, 5).map(([key, plays]) => ({
      name: key.split('\0')[0],
      artist: bucket.trackArtist.get(key) ?? '',
      album: bucket.trackAlbum.get(key) ?? '',
      plays,
    }));

    // Genre weight = artist plays × tag rank weight, so your most-played artists
    // shape the genre picture proportionally to how much you actually played them.
    const genrePlays = new Map();
    for (const [name, plays] of canonicalPlays) {
      const tags = tagsForCanonical(name);
      tags.forEach((tag, i) => {
        const slug = canonicalizeTag(tag, name);
        if (slug) bump(genrePlays, slug, plays * tagWeight(i));
      });
    }

    const genreTotal = [...genrePlays.values()].reduce((a, b) => a + b, 0);
    const topGenres = topEntries(genrePlays, 6).map(([slug, weight]) => ({
      slug,
      name: genreDisplayName(slug),
      share: share(weight, genreTotal),
    }));

    // Per-month genre mix for the trend stream graph.
    const trendSlugs = topGenres.slice(0, 5).map((g) => g.slug);
    const genreTrend = trendSlugs.map(() => new Array(12).fill(0));
    for (const [month, monthArtists] of bucket.artistPlaysByMonth) {
      const monthWeights = new Map();
      for (const [name, plays] of monthArtists) {
        const rawId = rawArtistIndex.get(name);
        for (const cId of rawToCanonical[rawId] ?? [rawId]) {
          const canonicalName = canonicalArtists[cId] ?? name;
          tagsForCanonical(canonicalName).forEach((tag, i) => {
            const slug = canonicalizeTag(tag, canonicalName);
            if (slug) bump(monthWeights, slug, plays * tagWeight(i));
          });
        }
      }
      const monthTotal = [...monthWeights.values()].reduce((a, b) => a + b, 0);
      trendSlugs.forEach((slug, i) => {
        genreTrend[i][month] = share(monthWeights.get(slug) ?? 0, monthTotal);
      });
    }

    const peakHour = bucket.byHour.indexOf(Math.max(...bucket.byHour));
    const peakWeekday = bucket.byWeekday.indexOf(Math.max(...bucket.byWeekday));
    const peakMonth = bucket.byMonth.indexOf(Math.max(...bucket.byMonth));

    const seasons = SEASONS.map(({ name, months }) => {
      const plays = months.reduce((sum, m) => sum + bucket.byMonth[m], 0);
      const seasonArtists = new Map();
      for (const m of months) {
        for (const [artist, count] of bucket.artistPlaysByMonth.get(m) ?? []) {
          bump(seasonArtists, artist, count);
        }
      }
      return {
        name,
        plays,
        share: share(plays, bucket.scrobbles),
        topArtist: topEntries(seasonArtists, 1)[0]?.[0] ?? '',
      };
    });

    const [busiestDate, busiestPlays] = topEntries(bucket.dayCounts, 1)[0] ?? ['', 0];
    const busiestTopTrack = topEntries(bucket.dayTopTrack.get(busiestDate) ?? new Map(), 1)[0];

    const uniqueArtists = canonicalPlays.size;
    // The in-progress year only has the days that have happened so far, so
    // "days with music out of the year" has to measure against those.
    const daysElapsed = Math.min(
      Math.round((bucket.lastUts - Date.UTC(year, 0, 1) / 1000) / 86_400) + 1,
      new Date(year, 1, 29).getMonth() === 1 ? 366 : 365,
    );
    const style = listeningStyle({
      scrobbles: bucket.scrobbles,
      uniqueArtists,
      uniqueTracks: bucket.tracks.size,
      uniqueAlbums: bucket.albums.size,
      topArtistShare: topArtists[0]?.share ?? 0,
      topFiveShare: topArtists.reduce((sum, a) => sum + a.share, 0),
      activeDays: bucket.dates.size,
      daysInYear: Math.max(daysElapsed, 1),
    });
    const clock = timeOfDayArchetype(peakHour);
    const vibe = vibeFromGenres(topGenres);

    const recap = {
      year,
      timezone: TIMEZONE,
      totals: {
        scrobbles: bucket.scrobbles,
        artists: uniqueArtists,
        albums: bucket.albums.size,
        tracks: bucket.tracks.size,
        activeDays: bucket.dates.size,
        minutes: Math.round(bucket.durationMs / 60_000),
        // Surfaced so the UI can hedge the wording when coverage is thin.
        durationCoverage: share(bucket.durationKnown, bucket.scrobbles),
      },
      topArtists,
      topAlbums,
      topTracks,
      topGenres,
      genreTrend: { slugs: trendSlugs, names: trendSlugs.map(genreDisplayName), months: genreTrend },
      clock: { byHour: bucket.byHour, peakHour, label: clock.label, blurb: clock.blurb },
      week: {
        byWeekday: bucket.byWeekday,
        peakWeekday,
        peakWeekdayName: WEEKDAY_NAMES[peakWeekday],
      },
      months: {
        byMonth: bucket.byMonth,
        peakMonth,
        peakMonthName: MONTH_NAMES[peakMonth],
      },
      seasons,
      milestones: {
        firstScrobble: new Date(bucket.firstUts * 1000).toISOString(),
        busiestDay: {
          date: busiestDate,
          plays: busiestPlays,
          track: busiestTopTrack ? busiestTopTrack[0].split('\0')[0] : '',
        },
        longestStreak: longestStreak(bucket.dates),
      },
      style,
      vibe,
    };

    fs.writeFileSync(
      path.join(PUBLIC_DATA_DIR, `recap-${year}.json`),
      JSON.stringify(recap),
      'utf-8',
    );

    index.push({
      year,
      scrobbles: bucket.scrobbles,
      minutes: recap.totals.minutes,
      topArtist: topArtists[0]?.name ?? '',
      topGenre: topGenres[0]?.name ?? '',
      vibe: vibe.label,
    });
  }

  // Newest first — that is the order the year picker offers them in.
  index.sort((a, b) => b.year - a.year);
  fs.writeFileSync(
    path.join(PUBLIC_DATA_DIR, 'recaps.json'),
    JSON.stringify({ years: index }),
    'utf-8',
  );

  console.log(`Wrote ${index.length} recaps: ${index.map((r) => r.year).join(', ')}`);
}

main();
