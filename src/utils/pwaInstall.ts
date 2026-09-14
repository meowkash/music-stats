import { readLocal, writeLocal } from './storage';

let deferredPrompt: Event | null = null;

export function isStandalonePwa(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export async function promptPwaInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!deferredPrompt) return 'unavailable';
  const prompt = deferredPrompt as Event & {
    prompt: () => Promise<unknown>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
  };
  deferredPrompt = null;
  hideInstallUi();
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  return outcome;
}

function getInstallBanner(): HTMLElement | null {
  return document.getElementById('pwa-install-banner');
}

function getInstallBtn(): HTMLButtonElement | null {
  return document.getElementById('pwa-install-btn') as HTMLButtonElement | null;
}

function showInstallUi(mode: 'native' | 'manual'): void {
  const banner = getInstallBanner();
  const btn = getInstallBtn();
  if (!banner || !btn) return;

  banner.classList.remove('hidden');
  banner.dataset.mode = mode;

  const hint = banner.querySelector('.pwa-install-hint');
  if (hint) {
    hint.textContent =
      mode === 'native'
        ? 'Install for offline access and faster launch.'
        : 'Tap Share, then "Add to Home Screen".';
  }

  btn.textContent = mode === 'native' ? 'Install app' : 'Got it';
}

function hideInstallUi(): void {
  getInstallBanner()?.classList.add('hidden');
}

const PWA_DISMISSED_KEY = 'pwa-install-dismissed';

const isInstallDismissed = () => readLocal(PWA_DISMISSED_KEY) === '1';
const setInstallDismissed = () => writeLocal(PWA_DISMISSED_KEY, '1');

// Mobile-only: desktop already has an address-bar control / "Add to Dock".
// Coarse pointer so a narrow desktop window doesn't count as a phone.
function isMobileViewport(): boolean {
  return (
    window.matchMedia('(max-width: 767px)').matches &&
    window.matchMedia('(pointer: coarse)').matches
  );
}

function shouldOfferInstall(): boolean {
  if (isStandalonePwa()) return false;
  if (!isMobileViewport()) return false;
  return !isInstallDismissed();
}

export function initPwaInstall(): void {
  const btn = getInstallBtn();
  btn?.addEventListener('click', async () => {
    const banner = getInstallBanner();
    const mode = banner?.dataset.mode;

    if (mode === 'manual') {
      setInstallDismissed();
      hideInstallUi();
      return;
    }

    const outcome = await promptPwaInstall();
    if (outcome === 'dismissed') {
      setInstallDismissed();
    }
  });

  document.getElementById('pwa-install-dismiss')?.addEventListener('click', () => {
    setInstallDismissed();
    hideInstallUi();
  });

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (shouldOfferInstall()) showInstallUi('native');
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    hideInstallUi();
  });

  // iOS Safari never fires beforeinstallprompt — show the manual hint once the SW is ready.
  if (!shouldOfferInstall()) return;

  const showManualHint = () => {
    if (deferredPrompt || isStandalonePwa()) return;
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.ready.then(() => {
      if (!deferredPrompt && shouldOfferInstall()) {
        showInstallUi('manual');
      }
    });
  };

  if (document.readyState === 'complete') {
    setTimeout(showManualHint, 2500);
  } else {
    window.addEventListener('load', () => setTimeout(showManualHint, 2500), { once: true });
  }
}
