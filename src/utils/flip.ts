import { IOS_SPRING_POINTS } from './motion';

/**
 * FLIP reordering for list re-sorts.
 *
 * The lists are rebuilt from scratch on every re-sort (innerHTML, not node
 * moves), so the identity that survives a repaint is the row's data attributes
 * rather than the node itself. Capture offsets before the repaint, match them
 * up by key afterwards, and play the difference.
 *
 * offsetTop rather than getBoundingClientRect(): it is unaffected by the
 * scroll position, so a capture taken before a repaint stays comparable to one
 * taken after even though the repaint changes the container's scroll height.
 */

const EASING = `cubic-bezier(${IOS_SPRING_POINTS.join(', ')})`;

/** Rows further than this outside the viewport are not worth animating. */
const OFFSCREEN_SLACK_PX = 200;

export interface FlipOptions {
  durationMs?: number;
  /** Per-row delay, capped so a long list doesn't animate for seconds. */
  staggerMs?: number;
  maxStaggerMs?: number;
  /** Scroll container used to skip rows the user cannot see. */
  viewport?: HTMLElement | null;
}

export type FlipCapture = Map<string, number>;

function rowKey(el: HTMLElement): string | null {
  const type = el.dataset.type;
  const id = el.dataset.id;
  if (!type || id === undefined) return null;
  return `${type}:${id}`;
}

export function captureRowPositions(container: HTMLElement, selector = '.scrobble-row'): FlipCapture {
  const capture: FlipCapture = new Map();
  for (const el of container.querySelectorAll<HTMLElement>(selector)) {
    const key = rowKey(el);
    if (key !== null) capture.set(key, el.offsetTop);
  }
  return capture;
}

/**
 * Plays rows from where they were to where they now are. Rows with no entry in
 * `before` are treated as entering and get a fade instead of a slide, so an
 * Artists rollup change (where the entities themselves differ) still reads as
 * a deliberate transition rather than a repaint.
 */
export function playFlip(
  container: HTMLElement,
  before: FlipCapture,
  options: FlipOptions = {},
): void {
  if (typeof container.animate !== 'function') return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const { durationMs = 420, staggerMs = 12, maxStaggerMs = 180, viewport } = options;

  const scrollTop = viewport?.scrollTop ?? 0;
  const viewHeight = viewport?.clientHeight ?? window.innerHeight;
  const visibleTop = scrollTop - OFFSCREEN_SLACK_PX;
  const visibleBottom = scrollTop + viewHeight + OFFSCREEN_SLACK_PX;

  let index = 0;
  for (const el of container.querySelectorAll<HTMLElement>('.scrobble-row')) {
    const newTop = el.offsetTop;
    if (newTop < visibleTop || newTop > visibleBottom) continue;

    const key = rowKey(el);
    const oldTop = key === null ? undefined : before.get(key);
    const delay = Math.min(index * staggerMs, maxStaggerMs);
    index++;

    if (oldTop === undefined) {
      el.animate(
        [
          { opacity: 0, transform: 'translate3d(0, 8px, 0)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: durationMs, delay, easing: EASING, fill: 'backwards' },
      );
      continue;
    }

    const delta = oldTop - newTop;
    if (Math.abs(delta) < 1) continue;

    el.animate(
      [{ transform: `translate3d(0, ${delta}px, 0)` }, { transform: 'none' }],
      { duration: durationMs, delay, easing: EASING, fill: 'backwards' },
    );
  }
}
