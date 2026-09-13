/**
 * One place that knows whether a modal surface is on top of the app.
 *
 * Pull-to-refresh and the nav-bar drag both need this and both used to read
 * body classes directly, which gets it wrong twice: the recap story sets no
 * body class at all, and every class is dropped synchronously at the *start*
 * of a close — so for the length of the dismiss animation the app looked idle
 * while a sheet was still sliding away under the user's finger.
 *
 * Closing therefore keeps the surface "active" for a settle window rather than
 * releasing it immediately.
 */

/** Covers --duration-sheet (380ms) plus a frame of slack. */
const CLOSE_SETTLE_MS = 420;

/**
 * Keyed rather than counted. The detail overlay calls its open path again on
 * every entity switch without an intervening close, so a counter drifted up
 * and never came back down — leaving the app permanently "overlay open" and
 * pull-to-refresh dead for the rest of the session. A set is idempotent, so
 * repeat opens of the same surface are free.
 */
const openSurfaces = new Set<string>();
let settledAt = 0;

export function setOverlayOpen(key: string, open: boolean, settleMs = CLOSE_SETTLE_MS): void {
  if (open) {
    openSurfaces.add(key);
    settledAt = 0;
    return;
  }
  if (!openSurfaces.delete(key)) return;
  if (openSurfaces.size === 0) settledAt = performance.now() + settleMs;
}

/** True while any modal surface is open, or still animating closed. */
export function isOverlayActive(): boolean {
  if (openSurfaces.size > 0) return true;
  return settledAt > 0 && performance.now() < settledAt;
}

/** Selector for every surface that should swallow a gesture rather than pass it through. */
export const OVERLAY_SURFACE_SELECTOR = '.app-sheet-panel, .app-sheet-backdrop, .story-viewer';

export function isOverlaySurface(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest(OVERLAY_SURFACE_SELECTOR);
}
