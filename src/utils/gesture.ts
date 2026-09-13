/**
 * Shared constants and helpers for every finger-driven surface in the app:
 * the ranking/monthly pagers, the nav-bar pill drag, the sheet swipe-dismiss
 * and the trackpad equivalents.
 *
 * These used to be per-module magic numbers that had drifted apart — three
 * different engage distances and two different flick thresholds — so the same
 * flick committed on one surface and snapped back on another. One record here
 * means a change to the feel lands everywhere at once.
 */

/** Finger travel before a surface starts following, in px. */
export const ENGAGE_DISTANCE = 8;

/**
 * A gesture is claimed for the cross axis only when it is this much more
 * dominant, so a slightly diagonal swipe still pages instead of scrolling.
 */
export const DIRECTION_BIAS = 1.2;

/** Flick speed (px/ms) that commits regardless of distance travelled. */
export const FLICK_VELOCITY = 0.3;

/** Fraction of a page that commits to the next one on a slow drag. */
export const COMMIT_FRACTION = 0.18;

/** Settle duration for page-sized moves — matches --duration-normal. */
export const SETTLE_MS = 300;

/** Settle duration for sheets — matches --duration-sheet. */
export const SHEET_SETTLE_MS = 380;

/**
 * iOS-style progressive resistance.
 *
 * The previous linear `overscroll * 0.2` felt dead from the very first pixel —
 * a 9px drag moved the surface under 2px, which reads as "nothing happened"
 * rather than "there is nothing past here". This starts near 1:1 and stiffens
 * as it goes, so the edge announces itself immediately and still refuses to
 * travel far. Same curve UIScrollView uses.
 *
 * @param overscroll How far past the edge the finger has travelled (signed).
 * @param dimension  The page/viewport size the resistance is scaled against.
 */
export function rubberBand(overscroll: number, dimension: number, coefficient = 0.55): number {
  if (overscroll === 0 || dimension <= 0) return 0;
  const magnitude = Math.abs(overscroll);
  const damped = (1 - 1 / ((magnitude * coefficient) / dimension + 1)) * dimension;
  return Math.sign(overscroll) * damped;
}

/**
 * Picks the index to settle on from where a gesture left a pager.
 *
 * `exact` is the fractional page position; velocity is px/ms, negative when
 * the content is moving left (i.e. advancing to a higher index).
 */
export function commitIndex(exact: number, velocity: number, moved: boolean): number {
  if (!moved) return Math.round(exact);

  if (velocity < -FLICK_VELOCITY) return Math.ceil(exact);
  if (velocity > FLICK_VELOCITY) return Math.floor(exact);

  let fraction = exact % 1;
  if (fraction < 0) fraction += 1;

  if (fraction > COMMIT_FRACTION && fraction <= 0.5) return Math.ceil(exact);
  if (fraction < 1 - COMMIT_FRACTION && fraction > 0.5) return Math.floor(exact);
  return Math.round(exact);
}

/** True when a gesture's dominant axis is the one the surface cares about. */
export function isAxisClaimed(primary: number, cross: number): boolean {
  return Math.abs(primary) >= Math.abs(cross) / DIRECTION_BIAS;
}
