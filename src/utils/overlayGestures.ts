export interface SwipeDismissOptions {
  panel: HTMLElement;
  scrollContainer: HTMLElement;
  onDismiss: () => void;
  /** Backdrop faded out in step with the drag, if provided. */
  backdrop?: HTMLElement | null;
  threshold?: number;
  /**
   * Touches that begin this many px from the left/right edge are reserved for
   * in-sheet edge navigation. Pass a function when the width depends on
   * runtime state (e.g. only while the overlay has back/forward history).
   */
  reserveLeftEdgePx?: number | (() => number);
  reserveRightEdgePx?: number | (() => number);
}

/** Distance the finger must travel before the sheet starts following it. */
const ENGAGE_DISTANCE = 6;
/** Flick speed (px/ms) that dismisses regardless of distance travelled. */
const FLICK_VELOCITY = 0.55;

export function bindSwipeDismiss(options: SwipeDismissOptions): void {
  const {
    panel,
    scrollContainer,
    onDismiss,
    backdrop,
    threshold = 100,
    reserveLeftEdgePx = 0,
    reserveRightEdgePx = 0,
  } = options;

  let startX = 0;
  let startY = 0;
  let currentY = 0;
  let lastY = 0;
  let lastTime = 0;
  let velocityY = 0;
  let tracking = false;
  let engaged = false;
  let pendingDragY: number | null = null;
  let dragRafId: number | null = null;
  /** Measured once per gesture — reading it per frame forces a layout flush. */
  let panelHeight = 0;

  /** Eases past ~60% of the sheet height so it never runs away from the finger. */
  function resist(distance: number): number {
    const soft = panelHeight * 0.6;
    if (distance <= soft) return distance;
    return soft + (distance - soft) * 0.35;
  }

  function flushDragFrame() {
    dragRafId = null;
    if (pendingDragY === null) return;

    const offset = resist(pendingDragY);
    pendingDragY = null;
    panel.style.transform = `translate3d(0, ${offset}px, 0)`;

    if (backdrop) {
      const progress = Math.min(offset / panelHeight, 1);
      backdrop.style.opacity = String(1 - progress * 0.7);
    }
  }

  function cancelPendingDragFrame(flush = false) {
    if (dragRafId !== null) {
      cancelAnimationFrame(dragRafId);
      dragRafId = null;
    }
    if (flush) flushDragFrame();
    else pendingDragY = null;
  }

  function releaseInlineStyles() {
    panel.style.transition = '';
    panel.style.transform = '';
    if (backdrop) backdrop.style.opacity = '';
  }

  function handleTouchStart(e: TouchEvent) {
    if (window.innerWidth >= 768) return;
    if (e.touches.length !== 1) return;
    if (scrollContainer.scrollTop > 5) return;
    // Leave edges for interactive back/forward navigation when reserved.
    const leftPx = typeof reserveLeftEdgePx === 'function' ? reserveLeftEdgePx() : reserveLeftEdgePx;
    const rightPx = typeof reserveRightEdgePx === 'function' ? reserveRightEdgePx() : reserveRightEdgePx;
    const x = e.touches[0].clientX;
    if (leftPx > 0 && x <= leftPx) return;
    if (rightPx > 0 && x >= window.innerWidth - rightPx) return;

    panelHeight = panel.offsetHeight || window.innerHeight;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    currentY = startY;
    lastY = startY;
    lastTime = performance.now();
    velocityY = 0;
    tracking = true;
    engaged = false;
  }

  function handleTouchMove(e: TouchEvent) {
    if (!tracking) return;

    const y = e.touches[0].clientY;
    let dy = y - startY;
    const dx = e.touches[0].clientX - startX;

    if (!engaged) {
      // Leave horizontal gestures (year/category paging) alone.
      if (Math.abs(dx) > Math.abs(dy)) {
        tracking = false;
        return;
      }
      if (dy < ENGAGE_DISTANCE) return;

      engaged = true;
      startY = y - ENGAGE_DISTANCE;
      dy = ENGAGE_DISTANCE;

      panel.classList.add('sheet-dragging');
      panel.style.transition = 'none';
      if (backdrop) backdrop.style.transition = 'none';
    }

    if (dy <= 0) {
      pendingDragY = 0;
    } else {
      pendingDragY = dy;
      if (e.cancelable) e.preventDefault();
    }

    const now = performance.now();
    const dt = now - lastTime;
    if (dt > 0) {
      const v = (y - lastY) / dt;
      velocityY = velocityY === 0 ? v : velocityY * 0.2 + v * 0.8;
    }
    lastY = y;
    lastTime = now;
    currentY = y;

    if (dragRafId === null) {
      dragRafId = requestAnimationFrame(flushDragFrame);
    }
  }

  function handleTouchEnd() {
    if (!tracking) return;
    tracking = false;
    cancelPendingDragFrame(true);

    if (!engaged) return;
    engaged = false;
    panel.classList.remove('sheet-dragging');

    panel.style.transition = '';
    if (backdrop) backdrop.style.transition = '';

    const dy = currentY - startY;
    if (dy > threshold || velocityY > FLICK_VELOCITY) {
      // onDismiss clears the inline transform, so the sheet animates out from
      // wherever the finger left it.
      if (backdrop) backdrop.style.opacity = '';
      onDismiss();
      return;
    }

    releaseInlineStyles();
  }

  function cancelDrag() {
    if (!tracking && !engaged) return;
    tracking = false;
    engaged = false;
    panel.classList.remove('sheet-dragging');
    cancelPendingDragFrame();
    releaseInlineStyles();
    if (backdrop) backdrop.style.transition = '';
  }

  panel.addEventListener('touchstart', handleTouchStart, { passive: true });
  panel.addEventListener('touchmove', handleTouchMove, { passive: false });
  panel.addEventListener('touchend', handleTouchEnd);
  panel.addEventListener('touchcancel', cancelDrag);
  window.addEventListener('orientationchange', cancelDrag);
}

export interface EdgeSwipeNavOptions {
  /** Listens for the edge gesture — typically the sheet panel. */
  gestureEl: HTMLElement;
  /**
   * In-sheet content regions that slide during navigation (header + body).
   * The sheet panel itself must not move.
   */
  contentEls: HTMLElement[];
  /**
   * `back` — left edge, swipe right (pop history).
   * `forward` — right edge, swipe left (redo).
   */
  direction: 'back' | 'forward';
  canNavigate: () => boolean;
  /**
   * Called after a committed swipe with content already at the "out" end
   * state for this direction, so the incoming slide can continue seamlessly.
   */
  onNavigate: () => void;
  edgeWidth?: number;
  /** Max slide distance in px — keep in sync with OVERLAY_SLIDE_PX. */
  slidePx?: number;
}

/** @deprecated Prefer `bindEdgeSwipeNav` with `direction: 'back'`. */
export type EdgeSwipeBackOptions = Omit<EdgeSwipeNavOptions, 'direction' | 'canNavigate' | 'onNavigate'> & {
  canGoBack: () => boolean;
  onBack: () => void;
};

const EDGE_ENGAGE = 8;
const EDGE_FLICK = 0.45;
const EDGE_COMMIT = 0.28;
/** Finger travel that maps to a full content slide-out. */
const EDGE_FULL_DX = 120;

/**
 * iOS-style interactive edge swipe for in-sheet navigation. Content slides
 * under the finger; the sheet stays put. Pull-down still dismisses.
 */
export function bindEdgeSwipeNav(options: EdgeSwipeNavOptions): void {
  const {
    gestureEl,
    contentEls,
    direction,
    canNavigate,
    onNavigate,
    edgeWidth = 22,
    slidePx = 28,
  } = options;

  const goingBack = direction === 'back';
  // Back: content exits to the right (+x). Forward: content exits to the left (−x).
  const slideSign = goingBack ? 1 : -1;

  let tracking = false;
  let engaged = false;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastTime = 0;
  let velocityX = 0;
  let progress = 0;
  let pendingProgress: number | null = null;
  let dragRafId: number | null = null;

  function paint(p: number) {
    progress = Math.min(Math.max(p, 0), 1);
    const x = progress * slidePx * slideSign;
    const opacity = String(1 - progress);
    for (const el of contentEls) {
      el.style.transform = `translate3d(${x}px, 0, 0)`;
      el.style.opacity = opacity;
    }
  }

  function flush() {
    dragRafId = null;
    if (pendingProgress === null) return;
    paint(pendingProgress);
    pendingProgress = null;
  }

  function cancelPending(doFlush = false) {
    if (dragRafId !== null) {
      cancelAnimationFrame(dragRafId);
      dragRafId = null;
    }
    if (doFlush) flush();
    else pendingProgress = null;
  }

  function beginInteractive() {
    for (const el of contentEls) {
      el.classList.add('is-sliding');
      el.style.transition = 'none';
    }
  }

  function clearInteractive() {
    for (const el of contentEls) {
      el.classList.remove('is-sliding');
      el.style.transition = '';
      el.style.transform = '';
      el.style.opacity = '';
    }
  }

  function springCancel() {
    for (const el of contentEls) {
      el.style.transition = `opacity 220ms cubic-bezier(0.32, 0.72, 0, 1), transform 220ms cubic-bezier(0.32, 0.72, 0, 1)`;
      el.style.transform = 'translate3d(0, 0, 0)';
      el.style.opacity = '1';
    }
    window.setTimeout(clearInteractive, 240);
  }

  function onStart(e: TouchEvent) {
    if (window.innerWidth >= 768) return;
    if (e.touches.length !== 1) return;
    if (!canNavigate()) return;

    const x = e.touches[0].clientX;
    const edgeOk = goingBack
      ? x <= edgeWidth
      : x >= window.innerWidth - edgeWidth;
    if (!edgeOk) return;

    tracking = true;
    engaged = false;
    startX = x;
    startY = e.touches[0].clientY;
    lastX = startX;
    lastTime = performance.now();
    velocityX = 0;
    progress = 0;
  }

  function onMove(e: TouchEvent) {
    if (!tracking) return;

    const x = e.touches[0].clientX;
    const y = e.touches[0].clientY;
    const dx = x - startX;
    const dy = y - startY;

    if (!engaged) {
      if (Math.abs(dx) < EDGE_ENGAGE && Math.abs(dy) < EDGE_ENGAGE) return;
      // Must move in the swipe direction for this edge; vertical → abandon.
      const horizontalOk = goingBack ? dx > 0 : dx < 0;
      if (Math.abs(dy) > Math.abs(dx) || !horizontalOk) {
        tracking = false;
        return;
      }

      engaged = true;
      beginInteractive();
    }

    if (e.cancelable) e.preventDefault();

    const now = performance.now();
    const dt = now - lastTime;
    if (dt > 0) {
      velocityX = velocityX * 0.2 + ((x - lastX) / dt) * 0.8;
      lastX = x;
      lastTime = now;
    }

    const travel = goingBack ? Math.max(dx, 0) : Math.max(-dx, 0);
    pendingProgress = Math.min(travel / EDGE_FULL_DX, 1);
    if (dragRafId === null) dragRafId = requestAnimationFrame(flush);
  }

  function onEnd() {
    if (!tracking) return;
    tracking = false;
    cancelPending(true);

    if (!engaged) return;
    engaged = false;

    const flick = goingBack ? velocityX > EDGE_FLICK : velocityX < -EDGE_FLICK;
    const commit = progress > EDGE_COMMIT || flick;
    if (commit && canNavigate()) {
      paint(1);
      for (const el of contentEls) el.style.transition = 'none';
      onNavigate();
      return;
    }

    springCancel();
  }

  function onCancel() {
    if (!tracking && !engaged) return;
    tracking = false;
    engaged = false;
    cancelPending();
    springCancel();
  }

  gestureEl.addEventListener('touchstart', onStart, { passive: true });
  gestureEl.addEventListener('touchmove', onMove, { passive: false });
  gestureEl.addEventListener('touchend', onEnd, { passive: true });
  gestureEl.addEventListener('touchcancel', onCancel, { passive: true });
}

/** Left-edge swipe → go back in the overlay stack. */
export function bindEdgeSwipeBack(options: EdgeSwipeBackOptions): void {
  bindEdgeSwipeNav({
    ...options,
    direction: 'back',
    canNavigate: options.canGoBack,
    onNavigate: options.onBack,
  });
}
