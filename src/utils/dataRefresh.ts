import { revalidateAllCached } from './dataStore';

let initialized = false;
let splashHidden = false;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

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
  // Force reflow so repeated updates retrigger the animation
  void shell.offsetWidth;
  shell.classList.add('data-refresh-pulse');
}

function handleDataUpdated(): void {
  showUpdateToast();
  pulseRefreshAnimation();
}

function handleResume(): void {
  if (document.visibilityState !== 'visible') return;
  void revalidateAllCached();
}

export function initDataRefreshUI(): void {
  if (initialized) return;
  initialized = true;

  window.addEventListener('data-updated', handleDataUpdated);
  document.addEventListener('visibilitychange', handleResume);
  window.addEventListener('online', () => void revalidateAllCached());
  window.addEventListener('offline', hideSplashScreen);
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
