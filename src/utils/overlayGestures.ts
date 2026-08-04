export interface SwipeDismissOptions {
  panel: HTMLElement;
  scrollContainer: HTMLElement;
  onDismiss: () => void;
  /** Backdrop faded out in step with the drag, if provided. */
  backdrop?: HTMLElement | null;
  threshold?: number;
}

/** Distance the finger must travel before the sheet starts following it. */
const ENGAGE_DISTANCE = 6;
/** Flick speed (px/ms) that dismisses regardless of distance travelled. */
const FLICK_VELOCITY = 0.55;

export function bindSwipeDismiss(options: SwipeDismissOptions): void {
  const { panel, scrollContainer, onDismiss, backdrop, threshold = 100 } = options;

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
