import { refreshAppData, revalidateCriticalData } from './dataStore';
import { isStandalonePwa } from './pwaInstall';

let initialized = false;
let splashHidden = false;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let refreshing = false;
let suppressUpdateToasts = false;

const PULL_THRESHOLD = 72;
const MAX_PULL = 120;

export function hideSplashScreen(): void {
  if (splashHidden) return;
  splashHidden = true;
  document.getElementById('pwa-splash-screen')?.classList.add('hidden');
}

function showUpdateToast(message = 'Data updated'): void {
  const toast = document.getElementById('data-update-toast');
  if (!toast) return;

  toast.textContent = message;
  toast.classList.add('visible');

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('visible');
  }, 2800);
}

export function pulseRefreshAnimation(): void {
  const shell = document.getElementById('app-shell');
  if (!shell) return;
  shell.classList.remove('data-refresh-pulse');
  void shell.offsetWidth;
  shell.classList.add('data-refresh-pulse');
}

function handleDataUpdated(): void {
  if (suppressUpdateToasts) return;
  showUpdateToast();
  pulseRefreshAnimation();
}

function getActivePanel(): HTMLElement | null {
  return document.querySelector('.panel-section.active');
}

function getPullIndicator(): HTMLElement | null {
  return document.getElementById('pull-refresh-indicator');
}

function setPullOffset(offset: number): void {
  const indicator = getPullIndicator();
  if (!indicator) return;

  const progress = Math.min(offset / PULL_THRESHOLD, 1);
  indicator.style.setProperty('--pull-offset', `${offset}px`);
  indicator.style.setProperty('--pull-progress', String(progress));
  indicator.classList.toggle('pull-ready', offset >= PULL_THRESHOLD);
}

function resetPullUi(): void {
  const indicator = getPullIndicator();
  indicator?.classList.remove('pull-ready', 'refreshing', 'visible');
  indicator?.style.removeProperty('--pull-offset');
  indicator?.style.removeProperty('--pull-progress');
}

async function runManualRefresh(): Promise<void> {
  if (refreshing || !navigator.onLine) {
    resetPullUi();
    if (!navigator.onLine) showUpdateToast('Offline — showing cached data');
    return;
  }

  refreshing = true;
  suppressUpdateToasts = true;
  const indicator = getPullIndicator();
  indicator?.classList.add('refreshing');

  try {
    const changedCount = await refreshAppData();
    if (changedCount > 0) {
      showUpdateToast('Data updated');
      pulseRefreshAnimation();
    } else {
      showUpdateToast('Already up to date');
    }
  } catch {
    showUpdateToast('Refresh failed');
  } finally {
    suppressUpdateToasts = false;
    refreshing = false;
    resetPullUi();
  }
}

function initPullToRefresh(): void {
  if (!isStandalonePwa()) return;

  let startY = 0;
  let pulling = false;
  let currentPull = 0;

  const onTouchStart = (event: TouchEvent) => {
    if (refreshing) return;
    const panel = getActivePanel();
    if (!panel || panel.scrollTop > 2) return;

    startY = event.touches[0].clientY;
    pulling = true;
    currentPull = 0;
  };

  const onTouchMove = (event: TouchEvent) => {
    if (!pulling || refreshing) return;

    const panel = getActivePanel();
    if (!panel || panel.scrollTop > 2) {
      pulling = false;
      currentPull = 0;
      resetPullUi();
      return;
    }

    const delta = event.touches[0].clientY - startY;
    if (delta <= 0) {
      currentPull = 0;
      resetPullUi();
      return;
    }

    event.preventDefault();
    currentPull = Math.min(delta * 0.45, MAX_PULL);
    getPullIndicator()?.classList.add('visible');
    setPullOffset(currentPull);
  };

  const onTouchEnd = () => {
    if (!pulling) return;
    pulling = false;

    if (currentPull >= PULL_THRESHOLD) {
      setPullOffset(PULL_THRESHOLD);
      void runManualRefresh();
      return;
    }

    currentPull = 0;
    getPullIndicator()?.classList.remove('visible');
    resetPullUi();
  };

  document.addEventListener('touchstart', onTouchStart, { passive: true });
  document.addEventListener('touchmove', onTouchMove, { passive: false });
  document.addEventListener('touchend', onTouchEnd, { passive: true });
  document.addEventListener('touchcancel', onTouchEnd, { passive: true });
}

let resumeTimer: ReturnType<typeof setTimeout> | null = null;

function handleResume(): void {
  if (document.visibilityState !== 'visible' || !navigator.onLine) return;
  if (resumeTimer) clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => {
    void revalidateCriticalData();
  }, 300);
}

export function initDataRefreshUI(): void {
  if (initialized) return;
  initialized = true;

  window.addEventListener('data-updated', handleDataUpdated);
  document.addEventListener('visibilitychange', handleResume);
  window.addEventListener('offline', hideSplashScreen);
  initPullToRefresh();
}

export function initServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;

  const register = () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((reg) => console.log('SW registered successfully:', reg.scope))
      .catch((err) => console.error('SW registration failed:', err));
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', register, { once: true });
  } else {
    register();
  }
}
