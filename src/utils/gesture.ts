// One record for every finger-driven surface (pagers, nav pill, sheet dismiss).
// These drifted apart as per-module magic numbers and the same flick used to commit on one surface and snap back on another.

/** Finger travel before a surface starts following, in px. */
export const ENGAGE_DISTANCE = 8;

/** How much more dominant the cross axis must be, so diagonal swipes still page. */
export const DIRECTION_BIAS = 1.2;

/** Flick speed (px/ms) that commits regardless of distance travelled. */
export const FLICK_VELOCITY = 0.22;

/** Fraction of a page that commits to the next one on a slow drag. */
export const COMMIT_FRACTION = 0.12;

/** Settle duration for page-sized CSS moves — matches --duration-normal. */
export const SETTLE_MS = 240;

// iOS-style progressive resistance: starts near 1:1 so the edge announces itself,
// then stiffens. Linear damping read as "nothing happened" for the first ~10px.
export function rubberBand(overscroll: number, dimension: number, coefficient = 0.55): number {
  if (overscroll === 0 || dimension <= 0) return 0;
  const magnitude = Math.abs(overscroll);
  const damped = (1 - 1 / ((magnitude * coefficient) / dimension + 1)) * dimension;
  return Math.sign(overscroll) * damped;
}

// `exact` is the fractional page position; velocity is px/ms, negative when
// the content moves left (advancing to a higher index).
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

/** A section fling may land on the current page or one neighbor — never skip. */
export function commitAdjacentIndex(
  current: number,
  exact: number,
  velocity: number,
  moved: boolean,
): number {
  const next = commitIndex(exact, velocity, moved);
  return Math.min(current + 1, Math.max(current - 1, next));
}

/** True when a gesture's dominant axis is the one the surface cares about. */
export function isAxisClaimed(primary: number, cross: number): boolean {
  return Math.abs(primary) >= Math.abs(cross) / DIRECTION_BIAS;
}
