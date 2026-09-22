// Body classes get this wrong twice: the recap story sets none, and classes drop
// at the *start* of a close. So closing stays "active" for a settle window.

/** Covers --duration-sheet-out (0.26s) plus a frame of slack. */
const CLOSE_SETTLE_MS = 280;

// Keyed, not counted: the detail overlay re-opens on every entity switch with no
// close between, which drifted a counter up permanently and killed pull-to-refresh.
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

// isOverlayActive() covers the recap story (no body class) and holds through the
// close, so a dismiss gesture can't leak into whatever is watching next.
export function isOverlayOpen(): boolean {
  return (
    isOverlayActive() ||
    document.body.classList.contains('overlay-open') ||
    document.body.classList.contains('stats-sheet-open')
  );
}

/** Selector for every surface that should swallow a gesture rather than pass it through. */
export const OVERLAY_SURFACE_SELECTOR = '.app-sheet-panel, .app-sheet-backdrop, .story-viewer';

export function isOverlaySurface(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest(OVERLAY_SURFACE_SELECTOR);
}
