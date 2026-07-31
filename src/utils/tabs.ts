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

export function setActiveTab(tab: string): void {
  applyPanelStates(tab);
}

export function restoreTabFromStorage(): void {
  try {
    const lastTab = localStorage.getItem('last-music-stats-tab');
    if (lastTab && lastTab !== 'dashboard') {
      applyPanelStates(lastTab);
      applyNavButtonStates(lastTab);
    }
  } catch {
    // localStorage unavailable
  }
}
