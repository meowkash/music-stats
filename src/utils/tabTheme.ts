import type { TabId } from './tabs';

export interface TabAccent {
  /** Absolute colour so JS can interpolate it — keep in sync with Layout.astro. */
  color: string;
  glowAlpha: number;
}

export const TAB_ACCENTS: Record<TabId, TabAccent> = {
  dashboard: { color: '#ff2d55', glowAlpha: 0.4 },
  rankings: { color: '#00f0ff', glowAlpha: 0.4 },
  recents: { color: '#8b5cf6', glowAlpha: 0.4 },
  statistics: { color: '#22c55e', glowAlpha: 0.4 },
};

/** Resting colour of an unselected tab button (matches --text-secondary). */
export const TAB_IDLE_COLOR = 'rgba(255, 255, 255, 0.8)';

type Wash = [r: number, g: number, b: number, a: number];

export interface TabSurface {
  top: Wash;
  mid: Wash;
  bottom: Wash;
}

// Single source for the wash: Layout.astro renders .bg-layer properties from it
// and theme-color derives from the same numbers, so chrome can't drift from page.
export const TAB_SURFACES: Record<TabId, TabSurface> = {
  dashboard: {
    top: [255, 45, 85, 0.12],
    mid: [255, 45, 85, 0.03],
    bottom: [255, 45, 85, 0.1],
  },
  rankings: {
    top: [0, 240, 255, 0.1],
    mid: [37, 99, 235, 0.025],
    bottom: [37, 99, 235, 0.09],
  },
  recents: {
    top: [139, 92, 246, 0.12],
    mid: [139, 92, 246, 0.03],
    bottom: [217, 70, 239, 0.1],
  },
  statistics: {
    top: [34, 197, 94, 0.11],
    mid: [13, 148, 136, 0.025],
    bottom: [13, 148, 136, 0.09],
  },
};

/** The page sits on solid black, so the wash composites against that. */
const PAGE_BASE = 0;

export function cssWash([r, g, b, a]: Wash): string {
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function toHex(value: number): string {
  return Math.round(value).toString(16).padStart(2, '0');
}

// theme-color is painted as an opaque fill, so it needs the *composited* result
// rather than the translucent wash itself.
function composite([r, g, b, a]: Wash): string {
  const blend = (channel: number) => channel * a + PAGE_BASE * (1 - a);
  return `#${toHex(blend(r))}${toHex(blend(g))}${toHex(blend(b))}`;
}

// Matches the *top* of the wash — the edge browser chrome sits against. Derived
// from TAB_SURFACES, not TAB_ORDER: tabs.ts imports this, so that would cycle.
export const TAB_THEME_COLORS: Record<TabId, string> = Object.fromEntries(
  Object.entries(TAB_SURFACES).map(([tab, surface]) => [tab, composite(surface.top)]),
) as Record<TabId, string>;

export const TAB_BOTTOM_COLORS: Record<TabId, string> = Object.fromEntries(
  Object.entries(TAB_SURFACES).map(([tab, surface]) => [tab, composite(surface.bottom)]),
) as Record<TabId, string>;

export const DEFAULT_THEME_COLOR = TAB_THEME_COLORS.dashboard;
export const DEFAULT_BOTTOM_COLOR = TAB_BOTTOM_COLORS.dashboard;

export function themeColorForTab(tab: string): string {
  return TAB_THEME_COLORS[tab as TabId] ?? DEFAULT_THEME_COLOR;
}

export function themeBottomColorForTab(tab: string): string {
  return TAB_BOTTOM_COLORS[tab as TabId] ?? DEFAULT_BOTTOM_COLOR;
}

// The lens has no real backdrop to refract: panels end above the nav zone, so
// the only thing behind the bar is this tab's wash. That makes the refraction
// a constant per tab, built once here and crossfaded by navBar.ts in step with
// the wash itself. A convex lens flips what it sees at its rim, so the wash's
// bottom hue gathers along the top edge and its top hue along the bottom, and
// the centre stays clear.
export function lensRefractionCss(tab: TabId): string {
  const { top, bottom } = TAB_SURFACES[tab];
  const rgb = ([r, g, b]: Wash) => `${r}, ${g}, ${b}`;
  const lo = rgb(bottom);
  const hi = rgb(top);
  return [
    `radial-gradient(ellipse closest-side at 50% 50%, rgba(${lo}, 0) 60%, rgba(${lo}, 0.05) 76%, rgba(${lo}, 0.14) 94%, rgba(${lo}, 0.09) 100%)`,
    `linear-gradient(to bottom, rgba(${lo}, 0.12) 0%, rgba(${lo}, 0) 34%, rgba(${hi}, 0) 66%, rgba(${hi}, 0.09) 100%)`,
  ].join(', ');
}
