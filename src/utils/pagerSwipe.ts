import { rafTween } from './motion';

/** Matches --duration-normal so pager slides feel like the rest of the UI. */
const SETTLE_MS = 300;
const DRAG_START_THRESHOLD = 8;
const COMMIT_FRACTION = 0.18;
const VELOCITY_COMMIT = 0.3;
const EDGE_RESISTANCE = 0.2;

export interface PagerSwipeOptions {
  /** Surface that listens for the gesture. */
  gestureEl: HTMLElement;
  /** Flex row holding the pages side by side. */
  trackEl: HTMLElement;
  /** Element whose width defines one page. */
  viewportEl: HTMLElement;
  pageCount: number;
  /** Fired once the slide has settled on `index`. */
  onSettled: (index: number) => void;
  /**
   * Fractional page position, on every drag and settle frame. Use it to keep
   * accompanying UI (labels, accents) in step with the slide.
   */
  onProgress?: (fraction: number) => void;
}

export interface PagerSwipe {
  index: () => number;
  goTo: (index: number, animate?: boolean) => void;
  measure: () => void;
}

/**
 * Finger-tracking horizontal pager. All writes are transform-only and the
 * settle uses the shared easing, so it matches the nav and sheet animations.
 */
export function bindPagerSwipe(options: PagerSwipeOptions): PagerSwipe {
  const { gestureEl, trackEl, viewportEl, pageCount, onSettled, onProgress } = options;

  let index = 0;
  let width = 0;
  let dragging = false;
  let didDrag = false;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastTime = 0;
  let velocity = 0;
  let offset = 0;
  let cancelTween: (() => void) | null = null;
  let pendingOffset: number | null = null;
  let dragRafId: number | null = null;
  let lastPaintX = Number.NaN;
  let dragStartOffset = 0;

  function measure() {
    width = viewportEl.clientWidth || window.innerWidth;
  }

  function paint(x: number) {
    if (Math.abs(x - lastPaintX) < 0.1) return;
    lastPaintX = x;
    trackEl.style.transform = `translate3d(${x}px, 0, 0)`;
    onProgress?.(width > 0 ? -x / width : 0);
  }

  /** Promotes the track to its own layer only while it is actually moving. */
  function setMoving(moving: boolean) {
    trackEl.classList.toggle('pager-moving', moving);
  }

  function flushDrag() {
    dragRafId = null;
    if (pendingOffset === null) return;
    offset = pendingOffset;
    pendingOffset = null;
    paint(restingX() + offset);
  }

  function cancelPendingDrag(flush = false) {
    if (dragRafId !== null) {
      cancelAnimationFrame(dragRafId);
      dragRafId = null;
    }
    if (flush && pendingOffset !== null) flushDrag();
    else pendingOffset = null;
  }

  function restingX(target = index): number {
    return -target * width;
  }

  function clampOffset(value: number): number {
    const absX = restingX(index) + value;
    const minX = restingX(pageCount - 1);
    const maxX = 0;

    if (absX > maxX) {
      const over = absX - maxX;
      return (maxX + over * EDGE_RESISTANCE) - restingX(index);
    }
    if (absX < minX) {
      const over = absX - minX;
      return (minX + over * EDGE_RESISTANCE) - restingX(index);
    }
    return value;
  }

  function goTo(target: number, animate = true) {
    const clamped = Math.min(Math.max(target, 0), pageCount - 1);
    cancelTween?.();

    if (!animate) {
      index = clamped;
      paint(restingX());
      cancelTween = null;
      setMoving(false);
      onSettled(index);
      return;
    }

    setMoving(true);
    const from = Number.isNaN(lastPaintX) ? restingX() + offset : lastPaintX;
    cancelTween = rafTween(from, restingX(clamped), SETTLE_MS, paint, () => {
      cancelTween = null;
      offset = 0;
      index = clamped;
      paint(restingX());
      setMoving(false);
      onSettled(index);
    });
  }

  const onStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) return;
    cancelTween?.();
    cancelTween = null;
    cancelPendingDrag();
    dragging = true;
    didDrag = false;
    
    dragStartOffset = !Number.isNaN(lastPaintX) ? lastPaintX - restingX(index) : 0;
    offset = dragStartOffset;
    velocity = 0;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    lastX = startX;
    lastTime = performance.now();
    // Width only changes on resize/orientation; measuring every touch forces layout.
    if (width <= 0) measure();
  };

  const onMove = (e: TouchEvent) => {
    if (!dragging) return;

    const x = e.touches[0].clientX;
    const dx = x - startX;
    const dy = e.touches[0].clientY - startY;

    if (!didDrag) {
      if (Math.abs(dx) < DRAG_START_THRESHOLD && Math.abs(dy) < DRAG_START_THRESHOLD) return;
      // Vertical bias means the user is scrolling the list, not paging.
      if (Math.abs(dy) > Math.abs(dx) * 1.2) {
        dragging = false;
        return;
      }
      didDrag = true;
      setMoving(true);
    }

    e.preventDefault();

    const now = performance.now();
    const dt = now - lastTime;
    if (dt > 0) {
      velocity = velocity * 0.2 + ((x - lastX) / dt) * 0.8;
      lastX = x;
      lastTime = now;
    }

    pendingOffset = clampOffset(dragStartOffset + dx);
    if (dragRafId === null) dragRafId = requestAnimationFrame(flushDrag);
  };

  const onEnd = () => {
    if (!dragging) return;
    dragging = false;
    cancelPendingDrag(true);

    const absX = restingX(index) + offset;
    const exactPage = -absX / (width || 1);
    
    let target = Math.round(exactPage);

    if (didDrag) {
      if (velocity < -VELOCITY_COMMIT) {
        target = Math.ceil(exactPage);
      } else if (velocity > VELOCITY_COMMIT) {
        target = Math.floor(exactPage);
      } else {
        let posFraction = exactPage % 1;
        if (posFraction < 0) posFraction += 1;
        
        if (posFraction > COMMIT_FRACTION && posFraction <= 0.5) {
          target = Math.ceil(exactPage);
        } else if (posFraction < (1 - COMMIT_FRACTION) && posFraction > 0.5) {
          target = Math.floor(exactPage);
        }
      }
    }

    goTo(target);
  };

  gestureEl.addEventListener('touchstart', onStart, { passive: true });
  gestureEl.addEventListener('touchmove', onMove, { passive: false });
  gestureEl.addEventListener('touchend', onEnd, { passive: true });
  gestureEl.addEventListener('touchcancel', onEnd, { passive: true });
  window.addEventListener('resize', () => {
    measure();
    if (!cancelTween) paint(restingX());
  });

  measure();

  return { index: () => index, goTo, measure };
}
