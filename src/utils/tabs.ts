import { themeColorForTab, themeBottomColorForTab } from './tabTheme';
import { writeLocal } from './storage';
import { colorToCss, parseColor, type Rgba } from './motion';

export const TAB_ORDER = ['dashboard', 'rankings', 'recents', 'statistics'] as const;
export type TabId = (typeof TAB_ORDER)[number];
const topColors = TAB_ORDER.map(tab => parseColor(themeColorForTab(tab))!);
const bottomColors = TAB_ORDER.map(tab => parseColor(themeBottomColorForTab(tab))!);
const topMix: Rgba = { r: 0, g: 0, b: 0, a: 0 };
const bottomMix: Rgba = { r: 0, g: 0, b: 0, a: 0 };
let lastTop = '', lastBottom = '';

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

/** Browser chrome, safe-area shield and page base follow the same per-tab
 *  weights as the wash, so a direct A→B glide never passes through the tabs
 *  in between. */
export function applyThemeWeights(weights: readonly number[]): void {
  const total = weights.reduce((sum, w) => sum + w, 0) || 1;
  const top = colorToCss(mixInto(topColors, weights, total, topMix));
  const bottom = colorToCss(mixInto(bottomColors, weights, total, bottomMix));
  if (top !== lastTop) {
    lastTop = top;
    document.documentElement.style.setProperty('--status-bar-color', top);
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = top;
  }
  if (bottom !== lastBottom) {
    lastBottom = bottom;
    document.documentElement.style.backgroundColor = bottom;
  }
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
  const topColor = themeColorForTab(tab);
  const bottomColor = themeBottomColorForTab(tab);
  
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    if (meta.content !== topColor) meta.content = topColor;
  }
  document.documentElement.style.backgroundColor = bottomColor;
  document.documentElement.style.setProperty('--status-bar-color', topColor);
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
