let deferredPrompt: Event | null = null;

export function isStandalonePwa(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function canInstallPwa(): boolean {
  return deferredPrompt !== null;
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
        : 'Use your browser\'s Install or "Add to Dock" option (address bar menu).';
  }

  btn.textContent = mode === 'native' ? 'Install app' : 'Got it';
}

function hideInstallUi(): void {
  getInstallBanner()?.classList.add('hidden');
}

function shouldOfferInstall(): boolean {
  if (isStandalonePwa()) return false;
  try {
    if (localStorage.getItem('pwa-install-dismissed') === '1') return false;
  } catch {
    /* ignore */
  }
  return true;
}

export function initPwaInstall(): void {
  const btn = getInstallBtn();
  btn?.addEventListener('click', async () => {
    const banner = getInstallBanner();
    const mode = banner?.dataset.mode;

    if (mode === 'manual') {
      try {
        localStorage.setItem('pwa-install-dismissed', '1');
      } catch {
        /* ignore */
      }
      hideInstallUi();
      return;
    }

    const outcome = await promptPwaInstall();
    if (outcome === 'dismissed') {
      try {
        localStorage.setItem('pwa-install-dismissed', '1');
      } catch {
        /* ignore */
      }
    }
  });

  document.getElementById('pwa-install-dismiss')?.addEventListener('click', () => {
    try {
      localStorage.setItem('pwa-install-dismissed', '1');
    } catch {
      /* ignore */
    }
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

  // Desktop Safari/Firefox won't fire beforeinstallprompt — show manual hint once SW is ready.
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
