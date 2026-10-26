export function onReady(fn: () => void): void {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn);
  } else {
    fn();
  }
}

/** Runs `fn` after the longest tab or segment glide (~280ms) has settled and
 *  the main thread is free, so deferred work never lands in its frames: an
 *  idle callback alone fires in the first gap between them. Safari has no
 *  requestIdleCallback, so there the settle delay is the whole wait. */
export function whenIdle(fn: () => void, settleMs = 320): void {
  const ric = (window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
  }).requestIdleCallback;
  setTimeout(() => (ric ? ric(fn, { timeout: 500 }) : fn()), settleMs);
}
