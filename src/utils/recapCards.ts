import { escapeHTML } from './ui';
import type { RecapGenre, RecapStats } from './recapStats';

export interface CardPalette {
  c1: string;
  c2: string;
  c3: string;
}

export function rgbCss(rgb: { r: number; g: number; b: number }): string {
  return `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
}

export const YEAR_CHART_COLORS = [
  '#ff2d55', '#00f0ff', '#8b5cf6', '#22c55e', '#f97316', '#eab308',
];

export function buildYearColorMap(years: string[]): Record<string, string> {
  const sorted = [...years].sort();
  const map: Record<string, string> = {};
  sorted.forEach((year, idx) => {
    map[year] = YEAR_CHART_COLORS[idx % YEAR_CHART_COLORS.length];
  });
  return map;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.min(255, Math.max(0, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

function mixHex(a: string, b: string, t: number): string {
  const c1 = hexToRgb(a);
  const c2 = hexToRgb(b);
  return rgbToHex(
    c1.r + (c2.r - c1.r) * t,
    c1.g + (c2.g - c1.g) * t,
    c1.b + (c2.b - c1.b) * t,
  );
}

function darkenHex(hex: string, amount: number): string {
  return mixHex(hex, '#000000', amount);
}

function lightenHex(hex: string, amount: number): string {
  return mixHex(hex, '#ffffff', amount);
}

/** Derive a three-stop palette from the year's chart color. */
export function paletteFromYearColor(hex: string, variant = 0): CardPalette {
  const shifts = [
    { light: 0.35, dark: 0.55 },
    { light: 0.25, dark: 0.65 },
    { light: 0.45, dark: 0.45 },
    { light: 0.2, dark: 0.7 },
    { light: 0.5, dark: 0.5 },
  ];
  const s = shifts[variant % shifts.length];
  return {
    c1: hex,
    c2: lightenHex(hex, s.light),
    c3: darkenHex(hex, s.dark),
  };
}

export function blendPalette(base: CardPalette, accent: CardPalette, t = 0.35): CardPalette {
  return {
    c1: mixHex(base.c1, accent.c1, t),
    c2: mixHex(base.c2, accent.c2, t),
    c3: mixHex(base.c3, accent.c3, t),
  };
}

export function defaultPalette(seed = 0, yearColor?: string): CardPalette {
  if (yearColor) return paletteFromYearColor(yearColor, seed);
  const sets: CardPalette[] = [
    { c1: '#eab308', c2: '#f97316', c3: '#ff2d55' },
    { c1: '#7c3aed', c2: '#db2777', c3: '#581c87' },
    { c1: '#0891b2', c2: '#00f0ff', c3: '#0c4a6e' },
    { c1: '#16a34a', c2: '#22c55e', c3: '#14532d' },
    { c1: '#a855f7', c2: '#ec4899', c3: '#4a044e' },
  ];
  return sets[seed % sets.length];
}

/** Layered scenery: blurred artwork, mesh, grain, decorative shapes. */
export function buildScenery(opts: {
  artworkUrl?: string | null;
  palette: CardPalette;
  variant?: string;
}): string {
  const { artworkUrl, palette, variant = 'default' } = opts;
  const artLayer = artworkUrl
    ? `<div class="recap-scenery-art" style="background-image:url('${escapeHTML(artworkUrl)}')"></div>`
    : '';

  const shapes = buildShapes(variant, palette);

  return `
    ${artLayer}
    <div class="recap-scenery-mesh" style="--c1:${palette.c1};--c2:${palette.c2};--c3:${palette.c3}"></div>
    <div class="recap-scenery-grain" aria-hidden="true"></div>
    ${shapes}
    <div class="recap-scenery-vignette"></div>
  `;
}

function buildShapes(variant: string, palette: CardPalette): string {
  const shapes: Record<string, string> = {
    intro: `
      <div class="recap-shape recap-shape-ring" style="--shape-color:${palette.c1}"></div>
      <div class="recap-shape recap-shape-diamond" style="--shape-color:${palette.c2}"></div>
    `,
    stat: `
      <div class="recap-shape recap-shape-arc" style="--shape-color:${palette.c2}"></div>
      <div class="recap-shape recap-shape-dots"></div>
    `,
    hero: `
      <div class="recap-shape recap-shape-halo" style="--shape-color:${palette.c1}"></div>
      <div class="recap-shape recap-shape-streak" style="--shape-color:${palette.c3}"></div>
    `,
    list: `
      <div class="recap-shape recap-shape-grid"></div>
    `,
    chart: `
      <div class="recap-shape recap-shape-wave" style="--shape-color:${palette.c1}"></div>
    `,
    genre: `
      <div class="recap-shape recap-shape-burst" style="--shape-color:${palette.c2}"></div>
    `,
    default: `<div class="recap-shape recap-shape-ring" style="--shape-color:${palette.c3}"></div>`,
  };
  return shapes[variant] || shapes.default;
}

export function buildListItems(
  items: Array<{ rank: number; name: string; sub?: string; count: number; imgUrl: string | null }>,
): string {
  return items
    .map(
      (item) => `
      <div class="recap-list-item">
        <span class="recap-list-rank">${item.rank}</span>
        ${
          item.imgUrl
            ? `<img class="recap-list-thumb" src="${escapeHTML(item.imgUrl)}" alt="" loading="lazy" />`
            : `<div class="recap-list-thumb"></div>`
        }
        <div class="recap-list-info">
          <div class="recap-list-name">${escapeHTML(item.name)}</div>
          ${item.sub ? `<div class="recap-list-sub">${escapeHTML(item.sub)}</div>` : ""}
        </div>
        <span class="recap-list-count">${item.count.toLocaleString()}</span>
      </div>
    `,
    )
    .join('');
}

export function buildGenreBars(genres: RecapGenre[]): string {
  const max = genres[0]?.count || 1;
  return genres
    .slice(0, 6)
    .map((g, i) => {
      const pct = Math.max(8, (g.count / max) * 100);
      return `
        <div class="recap-genre-row" style="animation-delay:${i * 0.08}s">
          <span class="recap-genre-name">${escapeHTML(g.name)}</span>
          <div class="recap-genre-bar-track">
            <div class="recap-genre-bar-fill" style="width:${pct}%"></div>
          </div>
          <span class="recap-genre-pct">${g.pct}%</span>
        </div>
      `;
    })
    .join('');
}

function buildAmbientOrbs(palette: CardPalette): string {
  return `
    <div class="recap-ambient-orb" style="--orb-color:${palette.c1};width:280px;height:280px;top:-8%;left:-12%"></div>
    <div class="recap-ambient-orb" style="--orb-color:${palette.c2};width:200px;height:200px;bottom:5%;right:-8%;animation-delay:-4s"></div>
    <div class="recap-ambient-orb" style="--orb-color:${palette.c3};width:140px;height:140px;top:40%;left:55%;animation-delay:-7s"></div>
  `;
}

function buildAmbientShapes(palette: CardPalette, cardType?: string): string {
  if (cardType === 'hero' || cardType === 'artist' || cardType === 'track' || cardType === 'album') {
    return `<div class="recap-ambient-ring" style="--shape-color:${palette.c1}"></div>`;
  }
  if (cardType === 'intro' || cardType === 'outro') {
    return `
      <div class="recap-ambient-ring recap-ambient-ring-lg" style="--shape-color:${palette.c2}"></div>
      <div class="recap-ambient-streak" style="--shape-color:${palette.c1}"></div>
    `;
  }
  return `<div class="recap-ambient-streak" style="--shape-color:${palette.c2}"></div>`;
}

/** Ambient fill for the full recaps panel — mirrors the active story. */
export function buildAmbientMarkup(
  palette: CardPalette,
  artworkUrl?: string | null,
  cardType?: string,
): string {
  const artLayer = artworkUrl
    ? `<div class="recap-ambient-art" style="background-image:url('${escapeHTML(artworkUrl)}')"></div>
       <div class="recap-ambient-art recap-ambient-art-secondary" style="background-image:url('${escapeHTML(artworkUrl)}')"></div>`
    : '';
  return `
    ${artLayer}
    <div class="recap-ambient-mesh" style="--c1:${palette.c1};--c2:${palette.c2};--c3:${palette.c3}"></div>
    <div class="recap-ambient-rays" style="--c1:${palette.c1};--c2:${palette.c2}"></div>
    <div class="recap-ambient-orbs">${buildAmbientOrbs(palette)}</div>
    ${buildAmbientShapes(palette, cardType)}
    <div class="recap-ambient-grain" aria-hidden="true"></div>
    <div class="recap-ambient-noise" aria-hidden="true"></div>
    <div class="recap-ambient-vignette"></div>
  `;
}

export interface BuildCardsContext {
  stats: RecapStats;
  yearColor: string;
  getArtistImg: (name: string) => string | null;
  getTrackImg: (name: string, artist: string, album: string) => string | null;
  getAlbumImg: (name: string, artist: string) => string | null;
  getColor: (url: string | null) => { r: number; g: number; b: number } | null;
}

export function buildRecapCards(ctx: BuildCardsContext): string {
  const { stats, yearColor, getArtistImg, getTrackImg, getAlbumImg, getColor } = ctx;
  const topArtist = stats.topArtists[0];
  const topTrack = stats.topTracks[0];
  const topAlbum = stats.topAlbums[0];

  const artistImg = topArtist ? getArtistImg(topArtist.name) : null;
  const trackImg = topTrack
    ? getTrackImg(topTrack.name, topTrack.artistName || '', topTrack.albumName || '')
    : null;
  const albumImg = topAlbum ? getAlbumImg(topAlbum.name, topAlbum.artistName || '') : null;

  const artistRgb = artistImg ? getColor(artistImg) : null;
  const trackRgb = trackImg ? getColor(trackImg) : null;
  const albumRgb = albumImg ? getColor(albumImg) : null;

  const cards: string[] = [];

  const wrap = (
    type: string,
    palette: CardPalette,
    content: string,
    artworkUrl?: string | null,
  ) => `
    <article class="recap-card" data-card="${type}"
      data-c1="${palette.c1}" data-c2="${palette.c2}" data-c3="${palette.c3}"
      data-artwork="${artworkUrl ? escapeHTML(artworkUrl) : ''}">
      <div class="recap-card-content">${content}</div>
    </article>
  `;

  const pal = (seed: number) => paletteFromYearColor(yearColor, seed);
  const heroPal = (rgb: { r: number; g: number; b: number } | null, seed: number) => {
    if (!rgb) return pal(seed);
    const artPal: CardPalette = { c1: rgbCss(rgb), c2: lightenHex(rgbCss(rgb), 0.2), c3: darkenHex(rgbCss(rgb), 0.5) };
    return blendPalette(pal(seed), artPal, 0.5);
  };

  // Intro
  cards.push(
    wrap(
      'intro',
      pal(0),
      `
        <span class="recap-eyebrow">Your year in music</span>
        <h3 class="recap-title">${stats.year}<br/>Recap</h3>
        <p class="recap-subtext">Swipe to explore your story</p>
      `,
    ),
  );

  // Listening time
  const listeningHours = stats.listeningMinutes >= 120;
  const listeningCounter = listeningHours
    ? Math.round(stats.listeningMinutes / 60)
    : Math.round(stats.listeningMinutes);
  cards.push(
    wrap(
      'listening',
      pal(1),
      `
        <span class="recap-eyebrow">${stats.listeningMinutesEstimated ? 'Estimated listening' : 'You listened for'}</span>
        <div class="recap-stat-value" data-counter="${listeningCounter}">0</div>
        <span class="recap-stat-label">${listeningHours ? 'hours of music' : 'minutes of music'}</span>
      `,
    ),
  );

  // Total plays
  cards.push(
    wrap(
      'plays',
      pal(2),
      `
        <span class="recap-eyebrow">You played</span>
        <div class="recap-stat-value" data-counter="${stats.totalPlays}">0</div>
        <span class="recap-stat-label">songs this year</span>
      `,
    ),
  );

  // Active days
  cards.push(
    wrap(
      'streak',
      pal(3),
      `
        <span class="recap-eyebrow">You listened on</span>
        <div class="recap-stat-value" data-counter="${stats.activeDays}">0</div>
        <span class="recap-stat-label">active days</span>
        <p class="recap-subtext">Longest streak: <strong>${stats.longestStreak} day${stats.longestStreak === 1 ? '' : 's'}</strong>${
          stats.biggestDay
            ? `<br/>Busiest: ${stats.biggestDay.label} · ${stats.biggestDay.count.toLocaleString()} plays`
            : ''
        }</p>
      `,
    ),
  );

  // Top artist
  if (topArtist) {
    cards.push(
      wrap(
        'artist',
        heroPal(artistRgb, 4),
        `
          <span class="recap-eyebrow">Your #1 artist</span>
          ${artistImg ? `<img class="recap-artwork" src="${escapeHTML(artistImg)}" alt="${escapeHTML(topArtist.name)}" loading="lazy" />` : ''}
          <h3 class="recap-title">${escapeHTML(topArtist.name)}</h3>
          <span class="recap-stat-label">${topArtist.count.toLocaleString()} plays</span>
        `,
        artistImg,
      ),
    );
  }

  // Top track
  if (topTrack) {
    cards.push(
      wrap(
        'track',
        heroPal(trackRgb, 1),
        `
          <span class="recap-eyebrow">On repeat</span>
          ${trackImg ? `<img class="recap-artwork" src="${escapeHTML(trackImg)}" alt="${escapeHTML(topTrack.name)}" loading="lazy" />` : ''}
          <h3 class="recap-title">${escapeHTML(topTrack.name)}</h3>
          <span class="recap-stat-label">${escapeHTML(topTrack.artistName || '')} · ${topTrack.count.toLocaleString()} plays</span>
        `,
        trackImg,
      ),
    );
  }

  // Top album
  if (topAlbum) {
    cards.push(
      wrap(
        'album',
        heroPal(albumRgb, 3),
        `
          <span class="recap-eyebrow">Most played album</span>
          ${albumImg ? `<img class="recap-artwork" src="${escapeHTML(albumImg)}" alt="${escapeHTML(topAlbum.name)}" loading="lazy" />` : ''}
          <h3 class="recap-title">${escapeHTML(topAlbum.name)}</h3>
          <span class="recap-stat-label">${escapeHTML(topAlbum.artistName || '')} · ${topAlbum.count.toLocaleString()} plays</span>
        `,
        albumImg,
      ),
    );
  }

  // Genres
  if (stats.topGenres.length > 0) {
    cards.push(
      wrap(
        'genres',
        pal(4),
        `
          <span class="recap-eyebrow">Your top genres</span>
          <h3 class="recap-title recap-title-sm">What you vibed with</h3>
          <div class="recap-genre-list">${buildGenreBars(stats.topGenres)}</div>
        `,
      ),
    );
  }

  // Top artists list
  if (stats.topArtists.length > 0) {
    cards.push(
      wrap(
        'artists',
        blendPalette(pal(0), heroPal(artistRgb, 0), 0.4),
        `
          <span class="recap-eyebrow">Top artists</span>
          <div class="recap-list">${buildListItems(
            stats.topArtists.slice(0, 5).map((a, i) => ({
              rank: i + 1,
              name: a.name,
              count: a.count,
              imgUrl: getArtistImg(a.name),
            })),
          )}</div>
        `,
        artistImg,
      ),
    );
  }

  // Top tracks list
  if (stats.topTracks.length > 0) {
    cards.push(
      wrap(
        'tracks',
        pal(2),
        `
          <span class="recap-eyebrow">Top tracks</span>
          <div class="recap-list">${buildListItems(
            stats.topTracks.slice(0, 5).map((t, i) => ({
              rank: i + 1,
              name: t.name,
              sub: t.artistName,
              count: t.count,
              imgUrl: getTrackImg(t.name, t.artistName || '', t.albumName || ''),
            })),
          )}</div>
        `,
      ),
    );
  }

  // Monthly chart
  if (stats.topMonth) {
    const maxMonthCount = Math.max(...stats.monthlyPlays.map((m) => m.count), 1);
    const monthBars = stats.monthlyPlays
      .map((m) => {
        const pct = Math.max(4, (m.count / maxMonthCount) * 100);
        const isTop = stats.topMonth?.month === m.month;
        return `<div class="recap-month-bar${isTop ? ' highlight' : ''}" style="height:${pct}%"></div>`;
      })
      .join('');

    cards.push(
      wrap(
        'months',
        pal(4),
        `
          <span class="recap-eyebrow">Your peak month</span>
          <h3 class="recap-title">${stats.topMonth.label}</h3>
          <span class="recap-stat-label">${stats.topMonth.count.toLocaleString()} plays</span>
          <div class="recap-month-chart">${monthBars}</div>
        `,
      ),
    );
  }

  // Discovery
  cards.push(
    wrap(
      'discovery',
      { c1: '#334155', c2: mixHex(yearColor, '#64748b', 0.4), c3: darkenHex(yearColor, 0.75) },
      `
        <span class="recap-eyebrow">Your library in ${stats.year}</span>
        <div class="recap-stat-grid">
          <div class="recap-mini-stat">
            <span class="recap-mini-value" data-counter="${stats.uniqueArtists}">0</span>
            <span class="recap-mini-label">Artists</span>
          </div>
          <div class="recap-mini-stat">
            <span class="recap-mini-value" data-counter="${stats.uniqueAlbums}">0</span>
            <span class="recap-mini-label">Albums</span>
          </div>
          <div class="recap-mini-stat">
            <span class="recap-mini-value" data-counter="${stats.uniqueTracks}">0</span>
            <span class="recap-mini-label">Tracks</span>
          </div>
        </div>
      `,
    ),
  );

  // Outro
  cards.push(
    wrap(
      'outro',
      pal(0),
      `
        <span class="recap-eyebrow">That's a wrap</span>
        <h3 class="recap-title">${stats.year}</h3>
        <p class="recap-subtext">Thanks for listening.<br/>See you next year.</p>
      `,
    ),
  );

  return cards.join('');
}

export function buildStoryProgress(count: number): string {
  return Array.from({ length: count }, (_, i) =>
    `<div class="story-segment" data-index="${i}"><span class="story-segment-fill"></span></div>`,
  ).join('');
}
