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

/**
 * The per-tab ambient background wash. This is the single source of truth:
 * Layout.astro renders the `.bg-layer` custom properties from it at build time,
 * and `themeColorForTab` derives the browser theme-color from the same numbers.
 *
 * Keeping both off one record is what makes the desktop PWA title bar blend
 * into the page — previously theme-color was a hardcoded #000 that matched no
 * tab, so the title bar read as a black band above a tinted UI.
 */
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

/**
 * Flattens a wash onto the page background. The browser paints theme-color as
 * an opaque fill, so it has to be the *composited* result, not the wash itself.
 */
function composite([r, g, b, a]: Wash): string {
  const blend = (channel: number) => channel * a + PAGE_BASE * (1 - a);
  return `#${toHex(blend(r))}${toHex(blend(g))}${toHex(blend(b))}`;
}

/**
 * theme-color matches the *top* of the wash specifically: that is the edge the
 * browser chrome (desktop PWA title bar, mobile status bar) sits against.
 */
// Derived from TAB_SURFACES rather than TAB_ORDER: tabs.ts imports this module,
// so importing a runtime value back from it would be a cycle.
export const TAB_THEME_COLORS: Record<TabId, string> = Object.fromEntries(
  Object.entries(TAB_SURFACES).map(([tab, surface]) => [tab, composite(surface.top)]),
) as Record<TabId, string>;

export const DEFAULT_THEME_COLOR = TAB_THEME_COLORS.dashboard;

export function themeColorForTab(tab: string): string {
  return TAB_THEME_COLORS[tab as TabId] ?? DEFAULT_THEME_COLOR;
}
