// Slides are HTML strings built once; the player only toggles `.is-active`, so a
// replay costs a class toggle. Voice is "my"/"the" — one listener, never "your".
import { escapeHTML, getArtistArtworkUrl, getArtworkThumbHTML, getArtworkUrl, getBottomColorForUrl, getColorForUrl } from './ui';
import { rgbToHsl } from './colorSurface';
import { icon, introIllustration, minutesIllustration, styleIllustration, vibeIllustration } from './recapArt';

// The viewer must live outside `#app-shell`: `.panel-section` is transformed and
// would become the containing block for the viewer's `position: fixed`.
export const RECAP_OPEN_EVENT = 'recap-open';

export interface RecapArtist {
  name: string;
  plays: number;
  share: number;
}
export interface RecapAlbum {
  name: string;
  artist: string;
  plays: number;
}
export interface RecapTrack {
  name: string;
  artist: string;
  album: string;
  plays: number;
}
export interface RecapGenre {
  slug: string;
  name: string;
  share: number;
}
export interface RecapSeason {
  name: string;
  plays: number;
  share: number;
  topArtist: string;
}

export interface Recap {
  year: number;
  totals: {
    scrobbles: number;
    artists: number;
    albums: number;
    tracks: number;
    activeDays: number;
    minutes: number;
    durationCoverage: number;
  };
  topArtists: RecapArtist[];
  topAlbums: RecapAlbum[];
  topTracks: RecapTrack[];
  topGenres: RecapGenre[];
  genreTrend: { slugs: string[]; names: string[]; months: number[][] };
  clock: { byHour: number[]; peakHour: number; label: string; blurb: string };
  week: { byWeekday: number[]; peakWeekday: number; peakWeekdayName: string };
  months: { byMonth: number[]; peakMonth: number; peakMonthName: string };
  seasons: RecapSeason[];
  milestones: {
    firstScrobble: string;
    busiestDay: { date: string; plays: number; track: string };
    longestStreak: number;
  };
  style: { label: string; blurb: string };
  vibe: { label: string; blurb: string };
}

export interface RecapIndexEntry {
  year: number;
  scrobbles: number;
  minutes: number;
  topArtist: string;
  topGenre: string;
  vibe: string;
}

export interface Story {
  /** Drives the slide's default palette via a data attribute. */
  tone: string;
  html: string;
  /** Artwork blurred behind the slide, when it has one. */
  backdrop?: string | null;
  /** Inline palette override (`--c1`…), e.g. colours pulled from artwork. */
  style?: string;
  /** Phases played inside the one segment (see utils/storyPlayer.ts). */
  steps?: number;
}

const MONTH_INITIALS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function formatNumber(value: number): string {
  return value.toLocaleString();
}

function hoursLabel(minutes: number): string {
  const hours = Math.round(minutes / 60);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${formatNumber(hours)} hours — about ${days} full ${days === 1 ? 'day' : 'days'}`;
  }
  return `${formatNumber(hours)} hours`;
}

function ordinalHour(hour: number): string {
  if (hour === 0) return '12 AM';
  if (hour === 12) return '12 PM';
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

// A counting number the CSS reveal animates; the value is stashed on the element
// so one shared observer runs the count-up.
function counter(value: number, formatted = formatNumber(value)): string {
  return `<span class="story-counter" data-count-to="${value}" data-count-text="${escapeHTML(formatted)}">0</span>`;
}

function bars(values: number[], labels: string[], peak: number, extraClass = ''): string {
  const max = Math.max(...values, 1);
  return `<div class="story-bars${extraClass ? ` ${extraClass}` : ''}" role="img" aria-label="${escapeHTML(labels.join(', '))}">${values
    .map((value, i) => {
      const height = Math.max(4, Math.round((value / max) * 100));
      return `<div class="story-bar${i === peak ? ' is-peak' : ''}" style="--bar-height:${height}%;--bar-index:${i}">
        <i></i><span>${escapeHTML(labels[i])}</span>
      </div>`;
    })
    .join('')}</div>`;
}

// Polar chart of listening by hour: a clock face maps "when do you listen" onto
// a shape already read as time.
function clockDial(byHour: number[], peakHour: number): string {
  const max = Math.max(...byHour, 1);
  const cx = 100;
  const cy = 100;
  const inner = 34;
  const outer = 92;

  const rays = byHour
    .map((value, hour) => {
      const angle = ((hour / 24) * 360 - 90) * (Math.PI / 180);
      const length = inner + (value / max) * (outer - inner);
      const x1 = cx + Math.cos(angle) * inner;
      const y1 = cy + Math.sin(angle) * inner;
      const x2 = cx + Math.cos(angle) * length;
      const y2 = cy + Math.sin(angle) * length;
      return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"
        class="story-ray${hour === peakHour ? ' is-peak' : ''}" style="--ray-index:${hour}" />`;
    })
    .join('');

  // Midnight, 6, noon and 18 marked so the dial reads as a clock at a glance.
  const ticks = [0, 6, 12, 18]
    .map((hour) => {
      const angle = ((hour / 24) * 360 - 90) * (Math.PI / 180);
      const x = cx + Math.cos(angle) * 18;
      const y = cy + Math.sin(angle) * 18 + 3.5;
      return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" class="story-clock-tick">${hour}</text>`;
    })
    .join('');

  return `<svg class="story-clock" viewBox="0 0 200 200" aria-hidden="true">
    <circle cx="${cx}" cy="${cy}" r="${inner - 6}" class="story-clock-core" />
    ${ticks}
    ${rays}
  </svg>`;
}

// Shares are renormalised per month so the band fills the plot: the story is the
// changing proportion, not the volume (which has its own slide).
function genreStream(trend: Recap['genreTrend']): string {
  const { names, months } = trend;
  if (!names.length) return '';

  const width = 300;
  const height = 150;

  const allTotals = Array.from({ length: 12 }, (_, m) =>
    months.reduce((sum, series) => sum + (series[m] ?? 0), 0),
  );

  // The current year stops partway through; plotting all twelve drew the band
  // collapsing to nothing, which read as a crash rather than missing data.
  const lastMonth = allTotals.reduce((last, total, m) => (total > 0 ? m : last), 0);
  const span = lastMonth + 1;
  if (span < 2) return '';

  const totals = allTotals.slice(0, span);
  const step = width / (span - 1);

  let baseline = new Array(span).fill(0);
  const layers = months.map((series, layerIndex) => {
    const top = totals.map((monthTotal, m) => {
      const normalised = monthTotal > 0 ? ((series[m] ?? 0) / monthTotal) * 100 : 0;
      return baseline[m] + normalised;
    });

    const upper = top.map((value, m) => `${(m * step).toFixed(1)},${(height - (value / 100) * height).toFixed(1)}`);
    const lower = baseline
      .map((value, m) => `${(m * step).toFixed(1)},${(height - (value / 100) * height).toFixed(1)}`)
      .reverse();

    baseline = top;
    return `<polygon class="story-stream-layer" style="--layer-index:${layerIndex}"
      points="${upper.join(' ')} ${lower.join(' ')}" />`;
  });

  const legend = names
    .map(
      (name, i) =>
        `<span class="story-legend-item" style="--layer-index:${i}"><i></i>${escapeHTML(name)}</span>`,
    )
    .join('');

  return `<div class="story-stream-wrap">
    <svg class="story-stream" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">${layers.join('')}</svg>
    <div class="story-stream-axis">${MONTH_INITIALS.slice(0, span)
      .map((m) => `<span>${m}</span>`)
      .join('')}</div>
    <div class="story-legend">${legend}</div>
  </div>`;
}

// Drawn rather than emoji so each season's mark inherits its colour and the
// slide's stroke language.
const SEASON_GLYPHS: Record<string, string> = {
  winter: `<path d="M32 6v52M9 19l46 26M55 19L9 45" />
    <path d="M32 16l-6 6M32 16l6 6M32 48l-6-6M32 48l6-6" />
    <path d="M18 22l1 8-8 1M46 42l-1-8 8-1M46 22l-1 8 8 1M18 42l1-8-8-1" />`,
  spring: `<path d="M32 58V30" />
    <circle cx="32" cy="20" r="6" />
    <path d="M32 20c0-8 6-12 12-10-1 8-6 11-12 10ZM32 20c0-8-6-12-12-10 1 8 6 11 12 10Z" />
    <path d="M32 44c-8 0-13-5-13-13 8 0 13 5 13 13ZM32 38c7 0 12-4 12-11-7 0-12 4-12 11Z" />`,
  summer: `<circle cx="32" cy="32" r="12" />
    <path d="M32 4v9M32 51v9M4 32h9M51 32h9M12 12l6 6M46 46l6 6M52 12l-6 6M18 46l-6 6" />`,
  autumn: `<path d="M46 12c6 16-2 32-18 36-6 2-12 0-14-4-3-6 0-14 8-20 8-6 18-10 24-12Z" />
    <path d="M14 54c8-10 16-20 30-32" />
    <path d="M26 34l8 2M32 24l6 3" />`,
};

function seasonGlyph(season: string): string {
  const path = SEASON_GLYPHS[season];
  if (!path) return '';
  return `<svg class="story-season-glyph" viewBox="0 0 64 64" fill="none" stroke="currentColor"
    stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

type RankedKind = 'artist' | 'album' | 'track';
type RankedItem = { name: string; artist?: string; album?: string; plays: number };

function artworkUrlFor(kind: RankedKind, item: { name: string; artist?: string; album?: string }): string | null {
  if (kind === 'artist') return getArtistArtworkUrl(item.name);
  if (kind === 'album') return getArtworkUrl('album', item.name, item.artist ?? '', item.name);
  return getArtworkUrl('track', item.name, item.artist ?? '', item.album ?? '');
}

function artworkFor(kind: RankedKind, item: { name: string; artist?: string; album?: string }): string {
  return getArtworkThumbHTML(artworkUrlFor(kind, item), kind);
}

const hsl = (h: number, s: number, l: number) =>
  `hsl(${Math.round(((h % 360) + 360) % 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;

/**
 * A three-colour palette pulled from a cover: its dominant hue plus two
 * neighbours either side, lifted to a saturation that survives the dark slide.
 * Near-grey covers return nothing, so the slide keeps its own tone instead of
 * turning to mud.
 */
function artworkPalette(url: string | null): string | undefined {
  const rgb = getColorForUrl(url);
  if (!rgb) return undefined;
  const { h, s } = rgbToHsl(rgb.r, rgb.g, rgb.b);
  if (s < 0.14) return undefined;

  const sat = Math.min(0.95, Math.max(0.62, s + 0.12));
  const vars = [
    `--c1:${hsl(h, sat, 0.6)}`,
    `--c2:${hsl(h + 38, sat, 0.56)}`,
    `--c3:${hsl(h - 46, sat * 0.92, 0.52)}`,
  ];
  const bottom = getBottomColorForUrl(url);
  if (bottom) vars.push(`--base:rgb(${bottom.r} ${bottom.g} ${bottom.b})`);
  return vars.join(';');
}

function runnerUpList(kind: RankedKind, items: RankedItem[], leaderPlays: number): string {
  return `<ol class="story-runners">${items
    .map(
      (item, i) => `<li style="--row-index:${i};--fill:${Math.max(6, Math.round((item.plays / Math.max(leaderPlays, 1)) * 100))}%">
        <span class="story-runner-rank">${i + 2}</span>
        <span class="story-runner-art">${artworkFor(kind, item)}</span>
        <span class="story-runner-text">
          <strong>${escapeHTML(item.name)}</strong>
          ${item.artist ? `<em>${escapeHTML(item.artist)}</em>` : ''}
        </span>
        <span class="story-runner-plays">${formatNumber(item.plays)}</span>
      </li>`,
    )
    .join('')}</ol>`;
}

/**
 * One slide per ranking, played in two phases: the #1 alone and large, then it
 * shrinks into a header card and the rest of the list rises in underneath.
 * RecapStory animates the hand-off (the cover FLIPs, the text cross-fades).
 */
function rankedSlide(
  kind: RankedKind,
  noun: { one: string; many: string },
  items: RankedItem[],
  meta: string,
  footnote: string,
): Story {
  const [top, ...rest] = items;
  const url = artworkUrlFor(kind, top);
  const palette = artworkPalette(url);
  return {
    tone: kind,
    // A near-grey cover blurred behind the slide only greys out its palette, so
    // the backdrop comes with the extracted colours or not at all.
    backdrop: palette ? url : null,
    style: palette,
    steps: rest.length ? 2 : 1,
    html: `<p class="story-eyebrow story-swap">
        <span class="story-swap-a">My top ${escapeHTML(noun.one)}</span>
        <span class="story-swap-b">My top ${escapeHTML(noun.many)}</span>
      </p>
      <div class="story-lead">
        <span class="story-lead-rank" data-fade>1</span>
        <div class="story-hero-art" data-flip>${artworkFor(kind, top)}</div>
        <div class="story-lead-text" data-fade>
          <h2 class="story-title">${escapeHTML(top.name)}</h2>
          ${top.artist ? `<p class="story-subtitle">${escapeHTML(top.artist)}</p>` : ''}
          <p class="story-lead-meta">${meta}</p>
        </div>
      </div>
      ${rest.length ? runnerUpList(kind, rest, top.plays) : ''}
      <p class="story-footnote story-split-foot">${footnote}</p>`,
  };
}

function hourIcon(hour: number): string {
  if (hour >= 5 && hour < 10) return icon('sunrise');
  if (hour >= 10 && hour < 17) return icon('sun');
  if (hour >= 17 && hour < 21) return icon('sunset');
  return icon('moon');
}

// Dawn orange, midday gold, dusk pink, night indigo — the card wears its hour.
function hourColor(hour: number): string {
  if (hour >= 5 && hour < 10) return '#fb923c';
  if (hour >= 10 && hour < 17) return '#facc15';
  if (hour >= 17 && hour < 21) return '#f472b6';
  return '#818cf8';
}

export function buildStories(recap: Recap): Story[] {
  const stories: Story[] = [];
  const { totals, topArtists, topAlbums, topTracks, topGenres, clock, week, months, seasons, milestones } = recap;

  stories.push({
    tone: 'intro',
    html: `<p class="story-eyebrow">My year in music</p>
      <h1 class="story-year">${recap.year}</h1>
      ${introIllustration()}
      <p class="story-lede">I pressed play ${counter(totals.scrobbles)} times across ${counter(totals.activeDays)} days.</p>
      <p class="story-hint">Tap to begin</p>`,
  });

  const minutesText = formatNumber(totals.minutes);
  stories.push({
    tone: 'minutes',
    html: `<p class="story-eyebrow">Time spent listening</p>
      ${minutesIllustration()}
      <h2 class="story-stat${minutesText.length > 6 ? ' is-long' : ''}">${counter(totals.minutes)}</h2>
      <p class="story-subtitle">minutes</p>
      <p class="story-lede">That's ${hoursLabel(totals.minutes)}.</p>
      ${
        totals.durationCoverage < 80
          ? `<p class="story-footnote">Estimated — exact lengths known for ${Math.round(totals.durationCoverage)}% of these plays.</p>`
          : ''
      }`,
  });

  if (topArtists.length) {
    stories.push(
      rankedSlide(
        'artist',
        { one: 'artist', many: 'artists' },
        topArtists,
        `${counter(topArtists[0].plays)} plays · ${topArtists[0].share}% of the year`,
        `${counter(totals.artists)} artists in total.`,
      ),
    );
  }

  if (topAlbums.length) {
    stories.push(
      rankedSlide(
        'album',
        { one: 'album', many: 'albums' },
        topAlbums,
        `${counter(topAlbums[0].plays)} plays`,
        `${counter(totals.albums)} albums played this year.`,
      ),
    );
  }

  if (topTracks.length) {
    stories.push(
      rankedSlide(
        'track',
        { one: 'track', many: 'tracks' },
        topTracks,
        `${counter(topTracks[0].plays)} plays`,
        `${counter(totals.tracks)} different tracks in all.`,
      ),
    );
  }

  if (topGenres.length) {
    // Top genres rarely clear 20%, so a 0–100% axis left every bar a stub. The
    // axis runs to the leader; the printed percentage is still the real share.
    const topShare = Math.max(...topGenres.map((g) => g.share), 1);
    stories.push({
      tone: 'genre',
      html: `<p class="story-eyebrow">My top genre</p>
        <h2 class="story-title">${escapeHTML(topGenres[0].name)}</h2>
        <div class="story-genre-bars">${topGenres
          .map(
            (genre, i) => `<div class="story-genre-row" style="--row-index:${i}">
              <span class="story-genre-name">${escapeHTML(genre.name)}</span>
              <span class="story-genre-track"><i style="--fill:${Math.max(
                Math.round((genre.share / topShare) * 100),
                4,
              )}%"></i></span>
              <span class="story-genre-share">${genre.share}%</span>
            </div>`,
          )
          .join('')}</div>
        <p class="story-footnote">Bars scaled to the leader; percentages are the share of the whole year.</p>`,
    });

    if (recap.genreTrend.names.length > 1) {
      stories.push({
        tone: 'stream',
        html: `<p class="story-eyebrow">How the taste moved</p>
          <h2 class="story-title-sm">Genres across ${recap.year}</h2>
          ${genreStream(recap.genreTrend)}`,
      });
    }
  }

  // Hour, weekday and month share one slide, the way the seasons do: three
  // cards, each in its own colour, instead of three near-identical bar charts.
  stories.push({
    tone: 'when',
    html: `<p class="story-eyebrow">When the music played</p>
      <h2 class="story-title-sm">${escapeHTML(clock.label)}</h2>
      <div class="story-when">
        <div class="story-when-card is-clock" style="--card-color:${hourColor(clock.peakHour)};--row-index:0">
          ${clockDial(clock.byHour, clock.peakHour)}
          <div class="story-when-text">
            <span class="story-when-label">${hourIcon(clock.peakHour)}Peak hour</span>
            <b class="story-when-value">${escapeHTML(ordinalHour(clock.peakHour))}</b>
            <span class="story-when-note">${escapeHTML(clock.blurb)}</span>
          </div>
        </div>
        <div class="story-when-card" style="--card-color:#2dd4bf;--row-index:1">
          <div class="story-when-head">
            <span class="story-when-label">${icon('week')}Loudest day</span>
            <b class="story-when-value">${escapeHTML(week.peakWeekdayName)}</b>
          </div>
          ${bars(week.byWeekday, WEEKDAY_INITIALS, week.peakWeekday, 'is-mini')}
          <span class="story-when-note">${counter(week.byWeekday[week.peakWeekday])} plays on ${escapeHTML(week.peakWeekdayName)}s</span>
        </div>
        <div class="story-when-card" style="--card-color:#fb7185;--row-index:2">
          <div class="story-when-head">
            <span class="story-when-label">${icon('month')}Biggest month</span>
            <b class="story-when-value">${escapeHTML(months.peakMonthName)}</b>
          </div>
          ${bars(months.byMonth, MONTH_INITIALS, months.peakMonth, 'is-mini')}
          <span class="story-when-note">${counter(months.byMonth[months.peakMonth])} plays in ${escapeHTML(months.peakMonthName)} alone</span>
        </div>
      </div>`,
  });

  stories.push({
    tone: 'season',
    html: `<p class="story-eyebrow">Through the seasons</p>
      <h2 class="story-title-sm">${recap.year} in four acts</h2>
      <div class="story-seasons">${seasons
        .map((season, i) => {
          const key = season.name.toLowerCase();
          return `<div class="story-season" data-season="${key}" style="--row-index:${i}">
            ${seasonGlyph(key)}
            <span class="story-season-name">${escapeHTML(season.name)}</span>
            <span class="story-season-ring" style="--share:${season.share}"><b>${season.share}%</b></span>
            <span class="story-season-artist">${escapeHTML(season.topArtist)}</span>
          </div>`;
        })
        .join('')}</div>`,
  });

  stories.push({
    tone: 'milestone',
    html: `<p class="story-eyebrow">The record books</p>
      <h2 class="story-title-sm">Moments that stood out</h2>
      <div class="story-facts">
        <div class="story-fact" style="--row-index:0;--fact-color:var(--c2)">
          <span class="story-fact-icon">${icon('bolt')}</span>
          <span class="story-fact-value">${counter(milestones.busiestDay.plays)}</span>
          <span class="story-fact-label">plays on ${escapeHTML(milestones.busiestDay.date)}<br />the busiest day</span>
        </div>
        <div class="story-fact" style="--row-index:1;--fact-color:var(--c1)">
          <span class="story-fact-icon">${icon('flame')}</span>
          <span class="story-fact-value">${counter(milestones.longestStreak)}</span>
          <span class="story-fact-label">days in a row<br />the longest streak</span>
        </div>
        <div class="story-fact" style="--row-index:2;--fact-color:var(--c3)">
          <span class="story-fact-icon">${icon('calendarCheck')}</span>
          <span class="story-fact-value">${counter(totals.activeDays)}</span>
          <span class="story-fact-label">days with music<br />out of the whole year</span>
        </div>
      </div>
      ${milestones.busiestDay.track ? `<p class="story-footnote">That day belonged to “${escapeHTML(milestones.busiestDay.track)}”.</p>` : ''}`,
  });

  stories.push({
    tone: 'style',
    html: `<p class="story-eyebrow">My listening style</p>
      ${styleIllustration(recap.style.label)}
      <h2 class="story-title">${escapeHTML(recap.style.label)}</h2>
      <p class="story-lede">${escapeHTML(recap.style.blurb)}</p>
      <p class="story-footnote">${counter(totals.artists)} artists · ${counter(totals.tracks)} tracks · ${counter(totals.scrobbles)} plays</p>`,
  });

  stories.push({
    tone: 'finale',
    html: `<p class="story-eyebrow">My ${recap.year} vibe</p>
      ${vibeIllustration(recap.vibe.label)}
      <h2 class="story-title">${escapeHTML(recap.vibe.label)}</h2>
      <p class="story-lede">${escapeHTML(recap.vibe.blurb)}</p>
      <div class="story-finale-summary">
        <span><b>${escapeHTML(topArtists[0]?.name ?? '—')}</b>top artist</span>
        <span><b>${escapeHTML(topGenres[0]?.name ?? '—')}</b>top genre</span>
        <span><b class="is-number">${formatNumber(totals.minutes)}</b>minutes</span>
      </div>
      <p class="story-hint">That's a wrap on ${recap.year}</p>`,
  });

  return stories;
}
