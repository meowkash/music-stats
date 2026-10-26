import { SMOOTH_EASE_CSS } from './motion';

/** Cross-dissolve for in-sheet navigation, on the app's spring curve. A
 *  little under the full spring: the outgoing page only has to clear. */
export const OVERLAY_CROSSFADE_MS = 360;
export const OVERLAY_EASE = SMOOTH_EASE_CSS;
export const OVERLAY_SLIDE_PX = 28;

export type OverlayNavDirection = 'forward' | 'back';

export function slideTransform(direction: OverlayNavDirection, phase: 'out' | 'in-start' | 'in-end'): string {
  const sign = direction === 'forward' ? 1 : -1;
  if (phase === 'out') return `translate3d(${-sign * OVERLAY_SLIDE_PX}px, 0, 0)`;
  if (phase === 'in-start') return `translate3d(${sign * OVERLAY_SLIDE_PX}px, 0, 0)`;
  return 'translate3d(0, 0, 0)';
}

export function dualLayerTransition(durationMs: number): string {
  return `opacity ${durationMs}ms ${OVERLAY_EASE}, transform ${durationMs}ms ${OVERLAY_EASE}`;
}
