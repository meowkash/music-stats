// Small animated SVG scenes for the recap stories. Each one illustrates what a
// label *means* (a compass for "Explorer", a cassette worn thin for "Loyalist"),
// drawn in the slide's own --c1/--c2/--c3 palette so it always matches the page.
//
// Colour and motion live in RecapStory.astro: `f1`/`s1`… paint with the palette,
// `ia-*` classes animate (all transform/opacity, so they stay on the compositor),
// and `--i` staggers repeated parts.

const VIEW = 'viewBox="0 0 200 160"';

function scene(body: string, label: string): string {
  return `<svg class="story-ill" ${VIEW} role="img" aria-label="${label}" fill="none" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

/** A floating eighth note, centred on (x, y). */
function note(x: number, y: number, cls: string, i = 0, scale = 1): string {
  return `<g class="ia-rise" style="--i:${i}"><g transform="translate(${x} ${y}) scale(${scale})">
    <path class="${cls}" d="M2 -10v14" stroke-width="2.4" />
    <path class="${cls}" d="M2 -10c4 1 7 3 7 7" stroke-width="2.4" />
    <ellipse class="${cls.replace('s', 'f')}" cx="-1" cy="5" rx="4" ry="3" />
  </g></g>`;
}

/**
 * Clips its contents to the scene: the scrolling waves are drawn wider than the
 * frame so they can loop, and a nested <svg> clips without needing an id.
 */
function clip(body: string): string {
  return `<svg width="200" height="160" viewBox="0 0 200 160" overflow="hidden">${body}</svg>`;
}

function sparkle(x: number, y: number, r: number, cls: string, i = 0): string {
  return `<path class="${cls} ia-twinkle" style="--i:${i}" d="M${x} ${y - r}Q${x} ${y} ${x + r} ${y}Q${x} ${y} ${x} ${y + r}Q${x} ${y} ${x - r} ${y}Q${x} ${y} ${x} ${y - r}Z" />`;
}

function eqBars(x: number, base: number, count: number, gap: number, width: number, maxH: number, cls: string[]): string {
  return Array.from({ length: count }, (_, i) => {
    const h = maxH * (0.45 + 0.55 * Math.abs(Math.sin(i * 1.7 + 0.4)));
    return `<rect class="${cls[i % cls.length]} ia-eq" style="--i:${i}" x="${x + i * (width + gap)}" y="${base - h}" width="${width}" height="${h}" rx="${width / 2}" />`;
  }).join('');
}

// ── Listening styles ───────────────────────────────────────────────────────

const STYLE_SCENES: Record<string, () => string> = {
  // One artist owned the year: a single heart at the centre, everything else
  // reduced to faint satellites around it.
  Devotee: () => `
    ${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
      const a = (i / 8) * Math.PI * 2;
      return `<circle class="f3 ia-blink" style="--i:${i}" cx="${(100 + Math.cos(a) * 64).toFixed(1)}" cy="${(80 + Math.sin(a) * 52).toFixed(1)}" r="3.5" opacity="0.5" />`;
    }).join('')}
    <circle class="f1 ia-ripple" cx="100" cy="80" r="30" opacity="0.35" />
    <path class="f1 ia-beat" d="M100 104c-22-14-34-26-34-40 0-10 8-17 17-17 7 0 13 4 17 10 4-6 10-10 17-10 9 0 17 7 17 17 0 14-12 26-34 40Z" />
    <path class="sw" stroke-width="3" d="M80 62c2-5 6-8 11-8" opacity="0.7" />`,

  // A song that would not get a rest: the repeat arrows, endlessly turning.
  'On Repeat': () => `
    <g class="ia-spin" style="--d:6s">
      <circle cx="100" cy="80" r="46" />
      <path class="s1" stroke-width="9" d="M60 80a40 40 0 0 1 68-28" />
      <path class="f1" d="M136 38l2 26-24-6Z" />
      <path class="s2" stroke-width="9" d="M140 80a40 40 0 0 1-68 28" />
      <path class="f2" d="M64 122l-2-26 24 6Z" />
    </g>
    ${note(100, 82, 'sw', 0, 1.6).replace('ia-rise', 'ia-bob')}`,

  // The map kept getting bigger: a compass hunting for the next direction.
  Explorer: () => `
    <path class="s3 ia-dash" stroke-width="3" stroke-dasharray="2 9" d="M18 140c30-10 30-40 60-44M182 22c-24 8-30 30-52 34" />
    <circle class="s2" stroke-width="6" cx="100" cy="80" r="46" />
    <circle class="s1" stroke-width="2" cx="100" cy="80" r="36" opacity="0.6" />
    ${[0, 90, 180, 270].map((d) => `<path class="sw" stroke-width="3" transform="rotate(${d} 100 80)" d="M100 38v8" />`).join('')}
    <g class="ia-swing">
      <path class="f1" d="M100 46l9 34h-18Z" />
      <path class="fw" d="M100 114l-9-34h18Z" opacity="0.85" />
    </g>
    <circle class="fw" cx="100" cy="80" r="4" />`,

  // First listens, charted one at a time: a folded map with a route being
  // drawn and pins dropping in as it goes.
  Cartographer: () => `
    <path class="f3" opacity="0.35" d="M30 40l46-14 48 14 46-14v96l-46 14-48-14-46 14Z" />
    <path class="s3" stroke-width="2" d="M76 26v96M124 40v96" opacity="0.6" />
    <path class="s1 ia-draw" pathLength="1" stroke-width="4" stroke-dasharray="1" d="M46 112c12-30 30-6 42-30s30-30 44-8 20-14 28-28" />
    ${[[46, 112], [88, 82], [132, 74], [160, 46]].map(([x, y], i) => `<g class="ia-drop" style="--i:${i}"><path class="f2" d="M${x} ${y - 4}c-7 0-11-5-11-10a11 11 0 0 1 22 0c0 5-4 10-11 10Z" transform="translate(0 -6)" /><circle class="fw" cx="${x}" cy="${y - 20}" r="3.5" /></g>`).join('')}`,

  // A short list did most of the work: five names in a tight orbit.
  'Inner Circle': () => `
    <circle class="s3" stroke-width="2" stroke-dasharray="3 6" cx="100" cy="80" r="56" opacity="0.6" />
    <g class="ia-spin" style="--d:16s">
      <circle cx="100" cy="80" r="52" />
      ${[0, 1, 2, 3, 4].map((i) => {
        const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
        return `<circle class="${['f1', 'f2', 'f1', 'f2', 'f1'][i]}" cx="${(100 + Math.cos(a) * 40).toFixed(1)}" cy="${(80 + Math.sin(a) * 40).toFixed(1)}" r="11" />`;
      }).join('')}
    </g>
    <circle class="fw ia-pulse" cx="100" cy="80" r="9" />`,

  // Quiet stretches, then days that never turned off: a calendar of bars that
  // is mostly flat, with a few towering spikes.
  'Binge Listener': () => {
    const heights = [6, 8, 5, 70, 86, 7, 6, 5, 9, 60, 6, 5, 92, 78, 7, 6];
    return `<path class="s3" stroke-width="2" d="M20 132h160" opacity="0.6" />
      ${heights.map((h, i) => `<rect class="${h > 40 ? (i % 2 ? 'f1' : 'f2') : 'f3'} ia-eq" style="--i:${i}" x="${24 + i * 9.6}" y="${130 - h}" width="6" height="${h}" rx="3" />`).join('')}`;
  },

  // Almost every day had something playing: a month of cells lighting up.
  'Daily Ritual': () => `
    <rect class="s3" stroke-width="3" x="34" y="22" width="132" height="118" rx="14" />
    <path class="f3" opacity="0.5" d="M34 36a14 14 0 0 1 14-14h104a14 14 0 0 1 14 14v10H34Z" />
    ${Array.from({ length: 28 }, (_, i) => {
      const col = i % 7;
      const row = Math.floor(i / 7);
      const off = i === 9 || i === 23;
      return `<rect class="${off ? 's3' : i % 3 ? 'f1' : 'f2'} ia-pop" style="--i:${i}" ${off ? 'stroke-width="1.5"' : ''} x="${44 + col * 17}" y="${56 + row * 20}" width="12" height="12" rx="3.5" />`;
    }).join('')}`,

  // Press play and leave it: one long road with the playhead still going.
  Marathoner: () => `
    <path class="s3" stroke-width="10" d="M14 120c30 0 30-60 62-60s30 60 62 60 30-74 48-74" opacity="0.4" />
    <path class="s1 ia-draw-loop" pathLength="1" stroke-width="10" stroke-dasharray="1" d="M14 120c30 0 30-60 62-60s30 60 62 60 30-74 48-74" />
    <circle class="fw" r="8"><animateMotion dur="5s" repeatCount="indefinite" path="M14 120c30 0 30-60 62-60s30 60 62 60 30-74 48-74" /></circle>
    <path class="sw" stroke-width="3" d="M178 30v-14l10 4-10 4" />`,

  // Records front to back: a spinning LP with the tonearm down.
  'Album Sitter': () => `
    <g class="ia-spin" style="--d:3.2s">
      <circle class="f3" cx="88" cy="82" r="58" />
      ${[50, 42, 34].map((r) => `<circle class="sw" stroke-width="1" cx="88" cy="82" r="${r}" opacity="0.18" />`).join('')}
      <circle class="f1" cx="88" cy="82" r="20" />
      <path class="fw" d="M88 64a18 18 0 0 1 16 10l-6 3a11 11 0 0 0-10-6Z" opacity="0.6" />
      <circle class="fw" cx="88" cy="82" r="3" />
    </g>
    <g class="ia-arm">
      <circle class="f2" cx="166" cy="30" r="8" />
      <path class="s2" stroke-width="5" d="M166 30l-14 62-18 14" />
      <rect class="f2" x="126" y="100" width="14" height="10" rx="3" transform="rotate(-36 133 105)" />
    </g>`,

  // A steady rotation with detours: a winding trail with branches off it.
  Wanderer: () => `
    <path class="s3" stroke-width="3" stroke-dasharray="3 7" d="M64 98c-14 6-26 0-34 10M128 54c10-14 30-12 40-24" />
    <path class="s1 ia-draw-loop" pathLength="1" stroke-width="5" stroke-dasharray="1" d="M20 132c40-4 30-40 64-40s24-40 60-40 24-24 40-30" />
    ${[[30, 108], [168, 30], [84, 92]].map(([x, y], i) => `<circle class="f2 ia-pop" style="--i:${i * 3}" cx="${x}" cy="${y}" r="6" />`).join('')}
    <circle class="fw" r="6"><animateMotion dur="6s" repeatCount="indefinite" path="M20 132c40-4 30-40 64-40s24-40 60-40 24-24 40-30" /></circle>`,

  // The same shortlist, revisited: one small world on a well-worn orbit.
  'Creature of Habit': () => `
    <ellipse class="s3" stroke-width="2" cx="100" cy="80" rx="74" ry="40" opacity="0.5" />
    <ellipse class="s1 ia-dash" stroke-width="3" stroke-dasharray="1 10" cx="100" cy="80" rx="74" ry="40" />
    <circle class="f2" cx="100" cy="80" r="22" />
    <circle class="sw" stroke-width="2" cx="100" cy="80" r="30" opacity="0.25" />
    <circle class="f1" r="10"><animateMotion dur="4.5s" repeatCount="indefinite" path="M26 80a74 40 0 1 0 148 0a74 40 0 1 0-148 0" /></circle>`,

  // Favourites returned to again and again: a shelf where one record after
  // another slides out and back.
  Regular: () => `
    <path class="s3" stroke-width="4" d="M24 136h152" />
    ${[0, 1, 2, 3, 4, 5].map((i) => `<rect class="${['f1', 'f2', 'f3', 'f1', 'f2', 'f3'][i]} ia-lift" style="--i:${i}" x="${34 + i * 23}" y="46" width="18" height="88" rx="4" />`).join('')}`,

  // Played into the ground: a cassette whose reels never stop.
  Loyalist: () => `
    <rect class="f3" x="26" y="34" width="148" height="96" rx="12" opacity="0.55" />
    <rect class="s1" stroke-width="4" x="26" y="34" width="148" height="96" rx="12" />
    <rect class="f1" x="44" y="48" width="112" height="44" rx="8" opacity="0.9" />
    ${[72, 128].map((cx) => `<g class="ia-spin" style="--d:1.6s"><circle class="fw" cx="${cx}" cy="70" r="13" /><path class="s3" stroke-width="3" d="M${cx} 59v22M${cx - 11} 70h22" /></g>`).join('')}
    <path class="s2" stroke-width="4" d="M58 130l10-22h64l10 22" />
    ${sparkle(170, 26, 8, 'fw', 0)}${sparkle(30, 140, 6, 'fw', 2)}`,
};

// ── Vibes ──────────────────────────────────────────────────────────────────

const VIBE_SCENES: Record<string, () => string> = {
  'High Voltage': () => `
    <circle class="f1 ia-ripple" cx="100" cy="80" r="40" opacity="0.3" />
    <path class="f1 ia-flash" d="M112 16L62 92h32l-10 52 54-80h-34Z" />
    <path class="sw" stroke-width="3" d="M108 30L76 80" opacity="0.6" />
    ${[[40, 40], [160, 44], [44, 124], [158, 120]].map(([x, y], i) => `<path class="s2 ia-twinkle" style="--i:${i}" stroke-width="4" d="M${x - 8} ${y}l6-5 4 8 6-6" />`).join('')}`,

  'Basement Show': () => `
    <rect class="f3" x="56" y="30" width="88" height="110" rx="10" />
    <rect class="s1" stroke-width="4" x="56" y="30" width="88" height="110" rx="10" />
    <circle class="f2 ia-beat" cx="100" cy="108" r="22" />
    <circle class="fw" cx="100" cy="108" r="7" />
    <circle class="f2 ia-beat" style="--i:1" cx="100" cy="56" r="12" />
    ${[0, 1, 2].map((i) => `<path class="s1 ia-shock" style="--i:${i}" stroke-width="4" d="M38 ${50 + i * 30}l-8 6 8 6-8 6M162 ${50 + i * 30}l8 6-8 6 8 6" />`).join('')}`,

  'Heavy Rotation': () => `
    <path class="s3" stroke-width="5" d="M64 40c0-14 72-14 72 0" />
    <rect class="f3" x="26" y="40" width="148" height="88" rx="14" />
    <rect class="s1" stroke-width="4" x="26" y="40" width="148" height="88" rx="14" />
    ${[64, 136].map((cx, i) => `<circle class="f1" cx="${cx}" cy="92" r="24" opacity="0.35" /><circle class="f2 ia-beat" style="--i:${i}" cx="${cx}" cy="92" r="16" /><circle class="fw" cx="${cx}" cy="92" r="5" />`).join('')}
    <rect class="fw" x="84" y="54" width="32" height="14" rx="3" opacity="0.8" />`,

  'Trap House': () => `
    ${Array.from({ length: 16 }, (_, i) => {
      const col = i % 4;
      const row = Math.floor(i / 4);
      return `<rect class="${(col + row) % 3 === 0 ? 'f1' : (col + row) % 3 === 1 ? 'f2' : 'f3'} ia-pad" style="--i:${(i * 7) % 16}" x="${48 + col * 27}" y="${28 + row * 27}" width="22" height="22" rx="5" />`;
    }).join('')}`,

  'Trance State': () => `
    ${[0, 1, 2, 3].map((i) => `<circle class="${i % 2 ? 's2' : 's1'} ia-ripple-slow" style="--i:${i}" stroke-width="3" cx="100" cy="80" r="56" />`).join('')}
    <circle class="f1 ia-pulse" cx="100" cy="80" r="14" />
    <circle class="fw" cx="100" cy="80" r="5" />`,

  'Club Circuit': () => `
    <path class="s3" stroke-width="2" d="M100 0v22" />
    ${[0, 1, 2, 3, 4].map((i) => `<path class="f${(i % 3) + 1} ia-beam" style="--i:${i}" opacity="0.35" d="M100 62L${30 + i * 35} 160h16Z" />`).join('')}
    <g class="ia-spin" style="--d:5s">
      <circle class="f3" cx="100" cy="62" r="34" />
      ${[-24, -12, 0, 12, 24].map((y) => `<path class="sw" stroke-width="1" opacity="0.4" d="M${100 - Math.sqrt(34 * 34 - y * y)} ${62 + y}h${2 * Math.sqrt(34 * 34 - y * y)}" />`).join('')}
      ${[-20, 0, 20].map((x) => `<ellipse class="sw" stroke-width="1" opacity="0.4" cx="100" cy="62" rx="${Math.abs(x) + 6}" ry="34" />`).join('')}
    </g>
    ${sparkle(76, 44, 6, 'fw', 0)}${sparkle(122, 74, 5, 'fw', 2)}`,

  'Bass Weight': () => `
    ${[0, 1, 2].map((i) => `<circle class="s2 ia-ripple" style="--i:${i}" stroke-width="3" cx="100" cy="80" r="62" />`).join('')}
    <circle class="f3" cx="100" cy="80" r="52" />
    <circle class="f1 ia-thump" cx="100" cy="80" r="38" />
    <circle class="f3" cx="100" cy="80" r="16" />
    <circle class="sw" stroke-width="2" cx="100" cy="80" r="46" opacity="0.4" />`,

  'Neon Pulse': () => `
    ${clip(`<path class="s1 ia-wave" stroke-width="5" d="M-40 56c20-28 40 28 60 0s40 28 60 0 40 28 60 0 40 28 60 0 40 28 60 0" />
    <path class="s2 ia-wave" style="--d:2.6s" stroke-width="3" opacity="0.7" d="M-40 66c20-20 40 20 60 0s40 20 60 0 40 20 60 0 40 20 60 0 40 20 60 0" />`)}
    <rect class="f3" x="22" y="96" width="156" height="46" rx="8" />
    ${Array.from({ length: 10 }, (_, i) => `<rect class="fw ia-key" style="--i:${(i * 3) % 10}" x="${28 + i * 15}" y="100" width="12" height="38" rx="3" />`).join('')}
    ${[0, 1, 2, 4, 5, 7, 8].map((i) => `<rect class="f1" x="${37 + i * 15}" y="100" width="8" height="22" rx="2" />`).join('')}`,

  'Pop Instinct': () => `
    <g class="ia-bob">
      <rect class="f1" x="80" y="20" width="40" height="64" rx="20" />
      ${[34, 46, 58, 70].map((y) => `<path class="sw" stroke-width="2" opacity="0.5" d="M84 ${y}h32" />`).join('')}
      <path class="s2" stroke-width="5" d="M70 70a30 30 0 0 0 60 0M100 100v24M80 132h40" />
    </g>
    ${sparkle(46, 40, 10, 'f2', 0)}${sparkle(156, 52, 8, 'fw', 1)}${sparkle(150, 120, 11, 'f1', 2)}${sparkle(48, 116, 7, 'fw', 3)}`,

  'Art Department': () => `
    <path class="f3" d="M100 22c40 0 72 26 72 58 0 18-14 22-26 20-10-2-16 6-12 16 4 12-6 22-34 22-40 0-72-26-72-58s32-58 72-58Z" />
    ${[[62, 58, 'f1'], [92, 44, 'f2'], [126, 52, 'fw'], [56, 92, 'f2']].map(([x, y, c], i) => `<circle class="${c} ia-pop" style="--i:${i}" cx="${x}" cy="${y}" r="11" />`).join('')}
    <path class="s1 ia-draw-loop" pathLength="1" stroke-width="7" stroke-dasharray="1" d="M18 150c30-20 50 6 80-10s50-8 84-24" />`,

  'Pop Passport': () => `
    <circle class="f3" cx="100" cy="80" r="50" />
    <clipPath id="globe-clip"><circle cx="100" cy="80" r="50" /></clipPath>
    <g clip-path="url(#globe-clip)">
      <g class="ia-slide">
        ${[-100, -50, 0, 50, 100, 150].map((x) => `<ellipse class="s1" stroke-width="2" opacity="0.6" cx="${100 + x}" cy="80" rx="18" ry="50" />`).join('')}
      </g>
      <path class="s1" stroke-width="2" opacity="0.6" d="M50 60h100M48 80h104M50 100h100" />
    </g>
    <circle class="s2" stroke-width="3" cx="100" cy="80" r="50" />
    <g class="ia-spin" style="--d:7s"><circle cx="100" cy="80" r="66" /><path class="fw" d="M100 14l8 6-8 2-2 8-4-10Z" transform="translate(0 -4)" /></g>`,

  'Quiet Storyteller': () => `
    <path class="f3" d="M100 60c-20-12-46-12-66-4v80c20-8 46-8 66 4 20-12 46-12 66-4V56c-20-8-46-8-66 4Z" />
    <path class="s1" stroke-width="4" d="M100 60v80" />
    ${[0, 1, 2].map((i) => `<path class="sw" stroke-width="2" opacity="0.4" d="M${46} ${76 + i * 14}q24-6 44 2M${110} ${78 + i * 14}q24-8 44-2" />`).join('')}
    ${note(84, 40, 's1', 0)}${note(112, 30, 's2', 1, 1.2)}${note(138, 44, 'sw', 2, 0.9)}`,

  'Long Road': () => `
    <circle class="f2 ia-pulse" cx="100" cy="50" r="24" />
    <path class="f3" d="M0 82h200v78H0Z" opacity="0.5" />
    <path class="f3" d="M88 82h24l60 78H28Z" />
    <path class="sw ia-road" stroke-width="4" stroke-dasharray="10 14" d="M100 84v76" />
    <path class="s1" stroke-width="3" d="M0 82h200" />
    <path class="s3" stroke-width="3" opacity="0.6" d="M20 82l-6-14M180 82l6-16" />`,

  'Deep Focus': () => `
    <circle class="f1 ia-breathe" cx="100" cy="80" r="30" opacity="0.8" />
    ${[0, 1, 2].map((i) => `<path class="${i % 2 ? 's2' : 's1'} ia-drift" style="--i:${i}" stroke-width="3" opacity="${0.7 - i * 0.15}" d="M10 ${120 + i * 12}c30-10 60 10 90 0s60-10 90 0" />`).join('')}`,

  'Blue Note': () => `
    <g class="ia-bob">
      <path class="f1" d="M146 52l30-18v76l-30-18Z" />
      <rect class="f1" x="40" y="66" width="108" height="12" rx="6" />
      <rect class="f2" x="40" y="86" width="90" height="10" rx="5" />
      <path class="s1" stroke-width="5" d="M56 78v8M78 78v8M100 78v8" />
      ${[66, 82, 98].map((x) => `<rect class="fw" x="${x}" y="52" width="8" height="14" rx="3" />`).join('')}
      <rect class="f3" x="26" y="68" width="16" height="8" rx="3" />
    </g>
    ${note(176, 34, 'sw', 0)}${note(184, 66, 's2', 1, 0.8)}`,

  'Smooth Operator': () => `
    ${clip([0, 1, 2].map((i) => `<path class="${['s1', 's2', 's3'][i]} ia-wave" style="--d:${4 + i}s;--p:-70px" stroke-width="${10 - i * 2}" opacity="${0.9 - i * 0.2}" d="M-40 ${60 + i * 22}c25-22 45 22 70 0s45 22 70 0 45 22 70 0 45 22 70 0 45 22 70 0" />`).join(''))}`,

  'Late Night Haze': () => `
    <path class="f2 ia-float" d="M118 26a40 40 0 1 0 34 62 32 32 0 0 1-34-62Z" />
    ${[[40, 34, 3], [64, 22, 2], [168, 30, 2.5], [58, 60, 2]].map(([x, y, r], i) => `<circle class="fw ia-twinkle" style="--i:${i}" cx="${x}" cy="${y}" r="${r}" />`).join('')}
    ${[0, 1].map((i) => `<path class="f3 ia-drift" style="--i:${i}" opacity="${0.55 - i * 0.15}" d="M${-10 + i * 40} ${120 + i * 14}c10-18 34-18 42-6 8-12 30-10 34 6 14-2 22 6 22 14H${-10 + i * 40}Z" />`).join('')}`,

  'Guitar Forward': () => `
    <g class="ia-sway" style="--o:50% 85%">
      <circle class="f1" cx="96" cy="112" r="30" />
      <circle class="f1" cx="96" cy="80" r="21" />
      <circle class="f3" cx="96" cy="96" r="9" />
      <rect class="f3" x="80" y="124" width="32" height="6" rx="3" />
      <rect class="f2" x="92" y="14" width="8" height="70" rx="2" />
      <rect class="f2" x="88" y="6" width="16" height="16" rx="4" />
      ${[93.5, 96, 98.5].map((x, i) => `<path class="sw ia-string" style="--i:${i}" stroke-width="1" d="M${x} 20V127" />`).join('')}
    </g>
    ${[0, 1].map((i) => `<path class="s2 ia-shock" style="--i:${i}" stroke-width="3" d="M${140 + i * 16} 70q8 20 0 40" />`).join('')}
    ${[0, 1].map((i) => `<path class="s2 ia-shock" style="--i:${i}" stroke-width="3" d="M${52 - i * 16} 70q-8 20 0 40" />`).join('')}`,

  'Indie Sprawl': () => `
    <path class="s1 ia-draw" pathLength="1" stroke-width="4" stroke-dasharray="1" d="M100 150c0-30-4-50 8-70s-6-40 4-60" />
    <path class="s2 ia-draw" pathLength="1" stroke-width="3" stroke-dasharray="1" style="--i:2" d="M104 96c20-6 30-20 44-16M106 64c-18-6-30-20-46-14M104 118c-18 2-32 10-44 4" />
    ${[[148, 80], [60, 50], [60, 122], [112, 22], [130, 108]].map(([x, y], i) => `<g class="ia-pop" style="--i:${i + 3}"><ellipse class="${i % 2 ? 'f1' : 'f2'}" cx="${x}" cy="${y}" rx="10" ry="6" transform="rotate(${-30 + i * 25} ${x} ${y})" /></g>`).join('')}`,

  'Prog Odyssey': () => `
    <ellipse class="s3" stroke-width="2" opacity="0.6" cx="100" cy="80" rx="86" ry="30" transform="rotate(-14 100 80)" />
    <circle class="f1" cx="100" cy="80" r="30" />
    <path class="s2" stroke-width="5" d="M56 92c20 10 70 6 92-14" opacity="0.9" />
    <circle class="f2" r="8"><animateMotion dur="7s" repeatCount="indefinite" path="M14 80a86 30 0 1 0 172 0a86 30 0 1 0-172 0" /></circle>
    ${sparkle(30, 30, 6, 'fw', 0)}${sparkle(170, 132, 5, 'fw', 2)}${sparkle(160, 26, 4, 'fw', 1)}`,

  'Full Cinema': () => `
    ${[0, 1].map((i) => `<path class="f2 ia-beam" style="--i:${i}" opacity="0.3" d="M${i ? 186 : 14} 0L${i ? 110 : 90} 160h${i ? -40 : 40}Z" />`).join('')}
    <g class="ia-spin" style="--d:6s">
      <circle class="f1" cx="100" cy="80" r="44" />
      ${[0, 1, 2, 3, 4].map((i) => {
        const a = (i / 5) * Math.PI * 2;
        return `<circle class="f3" cx="${(100 + Math.cos(a) * 26).toFixed(1)}" cy="${(80 + Math.sin(a) * 26).toFixed(1)}" r="9" />`;
      }).join('')}
      <circle class="fw" cx="100" cy="80" r="6" />
    </g>`,

  'Island Time': () => `
    <circle class="f2 ia-pulse" cx="150" cy="44" r="20" />
    ${clip(`<path class="s1 ia-wave" stroke-width="5" d="M-40 132c20-10 40 10 60 0s40 10 60 0 40 10 60 0 40 10 60 0 40 10 60 0" />
    <path class="s3 ia-wave" style="--d:3.4s" stroke-width="4" opacity="0.7" d="M-40 146c20-8 40 8 60 0s40 8 60 0 40 8 60 0 40 8 60 0 40 8 60 0" />`)}
    <g class="ia-sway" style="--o:50% 100%">
      <path class="s3" stroke-width="7" d="M70 128c4-30 0-60 10-84" />
      <path class="f1" d="M80 44c-20-10-40-4-48 10 18-6 32-4 48-10ZM80 44c10-18 30-22 46-14-18 2-30 6-46 14ZM80 44c-8-16-26-24-40-20 16 4 28 10 40 20ZM80 44c18-4 36 6 40 20-14-10-26-14-40-20Z" />
    </g>`,
};

/** Fallback for a vibe outside the families (a raw genre name, "Wide Open"). */
function genericScene(): string {
  return `${eqBars(36, 130, 9, 6, 9, 90, ['f1', 'f2', 'f3'])}
    ${sparkle(40, 30, 8, 'fw', 0)}${sparkle(160, 40, 10, 'f2', 1)}`;
}

export function styleIllustration(label: string): string {
  const build = STYLE_SCENES[label];
  return scene(build ? build() : genericScene(), `Illustration for ${label}`);
}

export function vibeIllustration(label: string): string {
  const build = VIBE_SCENES[label];
  return scene(build ? build() : genericScene(), `Illustration for ${label}`);
}

/** The intro's bouncing equaliser, under the year. */
export function introIllustration(): string {
  return `<svg class="story-ill story-ill-eq" viewBox="0 0 200 60" aria-hidden="true">${eqBars(8, 58, 16, 4, 8.25, 54, ['f1', 'f2', 'f3'])}</svg>`;
}

/** A clock face whose hand never stops sweeping, for the time-listened slide. */
export function minutesIllustration(): string {
  return `<svg class="story-ill story-ill-sm" viewBox="0 0 200 160" aria-hidden="true" fill="none" stroke-linecap="round">
    <circle class="f1 ia-ripple" cx="100" cy="80" r="50" opacity="0.25" />
    <circle class="f3" cx="100" cy="80" r="52" opacity="0.6" />
    <circle class="s1" stroke-width="5" cx="100" cy="80" r="52" />
    ${Array.from({ length: 12 }, (_, i) => `<path class="sw" stroke-width="${i % 3 ? 2 : 4}" opacity="${i % 3 ? 0.4 : 0.8}" transform="rotate(${i * 30} 100 80)" d="M100 34v${i % 3 ? 5 : 9}" />`).join('')}
    <g class="ia-spin" style="--d:60s"><circle cx="100" cy="80" r="52" /><path class="sw" stroke-width="6" d="M100 80V54" /></g>
    <g class="ia-spin" style="--d:5s"><circle cx="100" cy="80" r="52" /><path class="s2" stroke-width="3" d="M100 86V38" /></g>
    <circle class="fw" cx="100" cy="80" r="5" />
    ${note(170, 40, 's2', 0)}${note(30, 56, 'sw', 1, 0.9)}${note(166, 118, 's1', 2, 0.8)}
  </svg>`;
}

// ── Icons (24×24, stroke) ──────────────────────────────────────────────────

export const ICONS = {
  sun: '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/>',
  sunrise: '<path d="M17 18a5 5 0 0 0-10 0"/><path d="M12 3v6M4.2 10.2l1.4 1.4M18.4 11.6l1.4-1.4M2 18h2M20 18h2M22 22H2M8 6l4-4 4 4"/>',
  sunset: '<path d="M17 18a5 5 0 0 0-10 0"/><path d="M12 9V3M4.2 10.2l1.4 1.4M18.4 11.6l1.4-1.4M2 18h2M20 18h2M22 22H2M16 5l-4 4-4-4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
  week: '<rect x="3" y="4" width="18" height="17" rx="3"/><path d="M8 2v4M16 2v4M3 10h18"/><circle cx="8" cy="15" r="1.2" fill="currentColor"/><circle cx="12" cy="15" r="1.2" fill="currentColor"/><circle cx="16" cy="15" r="1.2" fill="currentColor"/>',
  month: '<path d="M3 20h18"/><rect x="4" y="12" width="3" height="6" rx="1"/><rect x="10.5" y="6" width="3" height="12" rx="1"/><rect x="17" y="9" width="3" height="9" rx="1"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7Z"/>',
  flame: '<path d="M12 22c4 0 7-3 7-7 0-5-4-7-5-12-3 2-4 5-4 7-1-1-2-2-2-4-2 2-3 5-3 9 0 4 3 7 7 7Z"/>',
  calendarCheck: '<rect x="3" y="4" width="18" height="17" rx="3"/><path d="M8 2v4M16 2v4M3 10h18M9 15.5l2 2 4-4"/>',
} as const;

export function icon(name: keyof typeof ICONS, cls = 'story-icon'): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}
