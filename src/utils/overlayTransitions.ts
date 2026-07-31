/** iOS-style cross-dissolve timing for in-sheet navigation */
export const OVERLAY_CROSSFADE_MS = 280;
export const OVERLAY_CONTENT_OUT_MS = 90;
export const OVERLAY_EASE = 'cubic-bezier(0.4, 0.0, 0.2, 1)';
export const OVERLAY_SLIDE_PX = 28;

export type OverlayNavDirection = 'forward' | 'back';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function slideTransform(direction: OverlayNavDirection, phase: 'out' | 'in-start' | 'in-end'): string {
  const sign = direction === 'forward' ? 1 : -1;
  if (phase === 'out') return `translate3d(${-sign * OVERLAY_SLIDE_PX}px, 0, 0)`;
  if (phase === 'in-start') return `translate3d(${sign * OVERLAY_SLIDE_PX}px, 0, 0)`;
  return 'translate3d(0, 0, 0)';
}

export function dualLayerTransition(durationMs: number): string {
  return `opacity ${durationMs}ms ${OVERLAY_EASE}, transform ${durationMs}ms ${OVERLAY_EASE}`;
}
