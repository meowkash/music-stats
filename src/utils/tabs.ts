import { themeColorForTab } from './tabTheme';

export const TAB_ORDER = ['dashboard', 'rankings', 'recents', 'statistics'] as const;
export type TabId = (typeof TAB_ORDER)[number];

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

/**
 * Points the browser's theme-color at the top of the active tab's wash, so the
 * desktop PWA title bar and the mobile status bar blend into the page instead
 * of framing it with a black band.
 */
export function applyThemeColor(tab: string): void {
  const color = themeColorForTab(tab);
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    if (meta.content !== color) meta.content = color;
  }
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

  try {
    localStorage.setItem('last-music-stats-tab', tab);
  } catch {
    // localStorage unavailable
  }

  window.dispatchEvent(new CustomEvent('tab-navigated', { detail: { tab } }));
}

export function restoreTabFromStorage(): void {
  try {
    const lastTab = localStorage.getItem('last-music-stats-tab');
    if (lastTab && lastTab !== 'dashboard') {
      applyPanelStates(lastTab);
      applyNavButtonStates(lastTab);
      applyTabAccent(lastTab);
    }
  } catch {
    // localStorage unavailable
  }
}
