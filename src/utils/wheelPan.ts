/**
 * Trackpad two-finger pans arrive as `wheel` events, not touches, so laptops
 * would otherwise miss every swipe gesture in the app. This turns a burst of
 * wheel events into the same start/move/end shape a finger drag produces:
 * `delta` is cumulative travel in the finger's direction (px) and `velocity`
 * is px/ms, matching the touch handlers' units.
 */

/** Wheel bursts have no "up" event — this much quiet ends the gesture. */
const IDLE_END_MS = 110;
/** deltaMode 1 reports lines; ~16px is the usual line height. */
const LINE_HEIGHT_PX = 16;

export interface WheelPanOptions {
  element: HTMLElement;
  /** Gesture axis. Cross-axis-dominant wheels are left alone (normal scroll). */
  axis: 'x' | 'y';
  enabled?: () => boolean;
  /**
   * Extra gate applied to the first event of a burst, given travel in the
   * finger's direction. Use it to claim only one direction so panning the
   * other way still scrolls normally.
   */
  shouldClaim?: (primary: number) => boolean;
  onStart?: () => void;
  onMove?: (delta: number, velocity: number) => void;
  onEnd?: (delta: number, velocity: number) => void;
}

function pixels(value: number, mode: number): number {
  if (mode === 1) return value * LINE_HEIGHT_PX;
  if (mode === 2) return value * window.innerHeight;
  return value;
}

export function bindWheelPan(options: WheelPanOptions): () => void {
  const { element, axis, enabled, shouldClaim, onStart, onMove, onEnd } = options;

  let active = false;
  let total = 0;
  let velocity = 0;
  let lastTime = 0;
  let endTimer: ReturnType<typeof setTimeout> | null = null;

  function finish() {
    endTimer = null;
    if (!active) return;
    active = false;
    const delta = total;
    const v = velocity;
    total = 0;
    velocity = 0;
    onEnd?.(delta, v);
  }

  function onWheel(e: WheelEvent) {
    if (enabled && !enabled()) return;

    const dx = pixels(e.deltaX, e.deltaMode);
    const dy = pixels(e.deltaY, e.deltaMode);
    // Wheel deltas point the way the content moves; the finger goes the other way.
    const primary = axis === 'x' ? -dx : -dy;
    const cross = axis === 'x' ? dy : dx;

    if (!active) {
      // Claim the gesture only once it is clearly along our axis. This also
      // keeps mouse wheels (deltaY only) out of horizontal pagers.
      if (Math.abs(primary) < 1 || Math.abs(primary) <= Math.abs(cross)) return;
      if (shouldClaim && !shouldClaim(primary)) return;
      active = true;
      total = 0;
      velocity = 0;
      lastTime = performance.now();
      onStart?.();
    }

    // Stops the browser's own swipe-back / overscroll from stealing the pan.
    if (e.cancelable) e.preventDefault();

    const now = performance.now();
    const dt = now - lastTime;
    if (dt > 0) {
      velocity = velocity * 0.2 + (primary / dt) * 0.8;
      lastTime = now;
    }

    total += primary;
    onMove?.(total, velocity);

    if (endTimer) clearTimeout(endTimer);
    endTimer = setTimeout(finish, IDLE_END_MS);
  }

  element.addEventListener('wheel', onWheel, { passive: false });

  return () => {
    if (endTimer) clearTimeout(endTimer);
    element.removeEventListener('wheel', onWheel);
  };
}
