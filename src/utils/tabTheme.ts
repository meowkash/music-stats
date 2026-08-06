import type { TabId } from './tabs';

export interface TabAccent {
  /** Absolute colour so JS can interpolate it — keep in sync with Layout.astro. */
  color: string;
  glowAlpha: number;
}

export const TAB_ACCENTS: Record<TabId, TabAccent> = {
  dashboard: { color: '#ff2d55', glowAlpha: 0.4 },
  recaps: { color: '#eab308', glowAlpha: 0.4 },
  rankings: { color: '#00f0ff', glowAlpha: 0.4 },
  recents: { color: '#8b5cf6', glowAlpha: 0.4 },
  statistics: { color: '#22c55e', glowAlpha: 0.4 },
};

/** Resting colour of an unselected tab button (matches --text-secondary). */
export const TAB_IDLE_COLOR = 'rgba(255, 255, 255, 0.8)';
