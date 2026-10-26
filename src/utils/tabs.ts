import { themeColorForTab, themeBottomColorForTab } from './tabTheme';
import { writeLocal } from './storage';
import { colorToCss, parseColor, type Rgba } from './motion';

export const TAB_ORDER = ['dashboard', 'rankings', 'recents', 'statistics'] as const;
export type TabId = (typeof TAB_ORDER)[number];
const topColors = TAB_ORDER.map(tab => parseColor(themeColorForTab(tab))!);
const topMix: Rgba = { r: 0, g: 0, b: 0, a: 0 };
let lastTop = '';

function mixInto(colors: Rgba[], weights: readonly number[], total: number, out: Rgba): Rgba {
  out.r = out.g = out.b = out.a = 0;
  for (let i = 0; i < colors.length; i++) {
    const w = (weights[i] ?? 0) / total;
    out.r += colors[i].r * w;
    out.g += colors[i].g * w;
    out.b += colors[i].b * w;
    out.a += colors[i].a * w;
  }
  return out;
}

/** The variable lives on the shield itself: written on <html> it is
 *  inherited by every element, so each frame of a glide restyled the page. */
function setStatusBarColor(color: string): void {
  if (color === lastTop) return;
  lastTop = color;
  document.querySelector<HTMLElement>('.status-bar-shield')?.style.setProperty('--status-bar-color', color);
}

/** The safe-area shield follows the same per-tab weights as the wash, so a
 *  direct A→B glide never passes through the tabs in between. Called every
 *  frame, so it touches nothing but that one strip. */
export function applyThemeWeights(weights: readonly number[]): void {
  const total = weights.reduce((sum, w) => sum + w, 0) || 1;
  setStatusBarColor(colorToCss(mixInto(topColors, weights, total, topMix)));
}

/** Browser chrome and the page base move once per decision, not per frame:
 *  theme-color repaints the browser UI and the root background repaints the
 *  whole viewport. The root background's own CSS transition carries the fade. */
export function applyChromeColors(tab: string): void {
  const topColor = themeColorForTab(tab);
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    if (meta.content !== topColor) meta.content = topColor;
  }
  document.documentElement.style.backgroundColor = themeBottomColorForTab(tab);
}

export function applyPanelStates(tab: string): void {
  const targetIndex = TAB_ORDER.indexOf(tab as TabId);
  if (targetIndex === -1) return;

  document.querySelectorAll('.panel-section').forEach((sec) => {
    const secId = sec.getAttribute('id')?.replace('view-', '') ?? '';
    const secIndex = TAB_ORDER.indexOf(secId as TabId);
    sec.classList.remove('active', 'inactive-left', 'inactive-right');
    if (secIndex < targetIndex) {
      sec.classList.add('inactive-left');
    } else if (secIndex > targetIndex) {
      sec.classList.add('inactive-right');
    } else {
      sec.classList.add('active');
    }
  });
}

export function applyNavButtonStates(tab: string): void {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tab);
  });
}

export function getActiveTab(): TabId {
  const active = document.querySelector('.panel-section.active');
  const id = active?.getAttribute('id')?.replace('view-', '') ?? 'dashboard';
  return TAB_ORDER.includes(id as TabId) ? (id as TabId) : 'dashboard';
}

// Points theme-color at the top of the active tab's wash so the PWA title bar
// and mobile status bar blend into the page instead of framing it.
export function applyThemeColor(tab: string): void {
  applyChromeColors(tab);
  setStatusBarColor(themeColorForTab(tab));
}

/** Drives the ambient background gradient crossfade. */
export function applyTabAccent(tab: string): void {
  if (TAB_ORDER.indexOf(tab as TabId) === -1) return;
  document.body.dataset.activeTab = tab;
  applyThemeColor(tab);
}

export function setActiveTab(tab: string): void {
  applyPanelStates(tab);
  applyNavButtonStates(tab);
  applyTabAccent(tab);
}

export function navigateToTab(tab: string): void {
  if (TAB_ORDER.indexOf(tab as TabId) === -1) return;

  setActiveTab(tab);

  writeLocal('last-music-stats-tab', tab);

  window.dispatchEvent(new CustomEvent('tab-navigated', { detail: { tab } }));
}
