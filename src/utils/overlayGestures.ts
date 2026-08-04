export interface SwipeDismissOptions {
  panel: HTMLElement;
  scrollContainer: HTMLElement;
  onDismiss: () => void;
  /** Backdrop faded out in step with the drag, if provided. */
  backdrop?: HTMLElement | null;
  threshold?: number;
  /**
   * Touches that begin this many px from the left edge are reserved for the
   * iOS-style edge-swipe back gesture. Pass a function when the reserve width
   * depends on runtime state (e.g. only while the overlay has history).
   */
  reserveLeftEdgePx?: number | (() => number);
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
    // Leave the left edge for the interactive back gesture when reserved.
    const edgePx = typeof reserveLeftEdgePx === 'function' ? reserveLeftEdgePx() : reserveLeftEdgePx;
    if (edgePx > 0 && e.touches[0].clientX <= edgePx) return;

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
    const dy = y - startY;
    const dx = e.touches[0].clientX - startX;

    if (!engaged) {
      // Leave horizontal gestures (year/category paging) alone.
      if (Math.abs(dx) > Math.abs(dy)) {
        tracking = false;
        return;
      }
      if (dy < ENGAGE_DISTANCE) return;

      engaged = true;
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
    if (dt > 0) velocityY = (y - lastY) / dt;
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

export interface EdgeSwipeBackOptions {
  /** Listens for the edge gesture — typically the sheet panel. */
  gestureEl: HTMLElement;
  /**
   * In-sheet content regions that slide during navigation (header + body).
   * The sheet panel itself must not move.
   */
  contentEls: HTMLElement[];
  /** True when there is navigation history to pop (chevron back). */
  canGoBack: () => boolean;
  /**
   * Pop one level. Called only after a committed swipe, with content already
   * painted at the "back out" end state so the incoming slide can continue.
   */
  onBack: () => void;
  /** Width of the invisible left-edge hit target. */
  edgeWidth?: number;
  /** Max slide distance in px — keep in sync with OVERLAY_SLIDE_PX. */
  slidePx?: number;
}

const EDGE_ENGAGE = 8;
const EDGE_FLICK = 0.45;
const EDGE_COMMIT = 0.28;
/** Finger travel that maps to a full content slide-out. */
const EDGE_FULL_DX = 120;

/**
 * iOS-style interactive edge swipe for in-sheet navigation: the content slides
 * out under the finger (reverse of the forward push), while the sheet stays put.
 * Pull-down remains the only way to dismiss the sheet.
 */
export function bindEdgeSwipeBack(options: EdgeSwipeBackOptions): void {
  const {
    gestureEl,
    contentEls,
    canGoBack,
    onBack,
    edgeWidth = 22,
    slidePx = 28,
  } = options;

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
    const x = progress * slidePx;
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
    if (e.touches[0].clientX > edgeWidth) return;
    if (!canGoBack()) return;

    tracking = true;
    engaged = false;
    startX = e.touches[0].clientX;
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
      if (Math.abs(dy) > Math.abs(dx) || dx < 0) {
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

    pendingProgress = Math.min(Math.max(dx, 0) / EDGE_FULL_DX, 1);
    if (dragRafId === null) dragRafId = requestAnimationFrame(flush);
  }

  function onEnd() {
    if (!tracking) return;
    tracking = false;
    cancelPending(true);

    if (!engaged) return;
    engaged = false;

    const commit = progress > EDGE_COMMIT || velocityX > EDGE_FLICK;
    if (commit && canGoBack()) {
      // Hold the content at the fully slid-out state; onBack continues into
      // the normal "slide previous content in from the left" animation.
      paint(1);
      for (const el of contentEls) el.style.transition = 'none';
      onBack();
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
