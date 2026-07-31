export interface SwipeDismissOptions {
  panel: HTMLElement;
  scrollContainer: HTMLElement;
  onDismiss: () => void;
  threshold?: number;
}

export function bindSwipeDismiss(options: SwipeDismissOptions): void {
  const { panel, scrollContainer, onDismiss, threshold = 100 } = options;

  let startY = 0;
  let currentY = 0;
  let isDragging = false;
  let isDismissing = false;
  let pendingDragY: number | null = null;
  let dragRafId: number | null = null;

  function flushDragFrame() {
    dragRafId = null;
    if (pendingDragY === null) return;
    panel.style.transform = `translate3d(0, ${pendingDragY}px, 0)`;
  }

  function cancelPendingDragFrame() {
    if (dragRafId !== null) {
      cancelAnimationFrame(dragRafId);
      dragRafId = null;
    }
    pendingDragY = null;
  }

  function handleTouchStart(e: TouchEvent) {
    if (window.innerWidth >= 768) return;
    if (scrollContainer.scrollTop > 5) return;

    startY = e.touches[0].clientY;
    currentY = startY;
    isDragging = true;
    isDismissing = false;
    panel.style.transition = 'none';
  }

  function handleTouchMove(e: TouchEvent) {
    if (!isDragging) return;
    currentY = e.touches[0].clientY;
    const diffY = currentY - startY;

    if (diffY > 0) {
      isDismissing = true;
      if (e.cancelable) e.preventDefault();
      pendingDragY = diffY;
      if (dragRafId === null) {
        dragRafId = requestAnimationFrame(flushDragFrame);
      }
    } else {
      isDismissing = false;
    }
  }

  function handleTouchEnd() {
    if (!isDragging) return;
    isDragging = false;
    cancelPendingDragFrame();
    panel.style.transition = '';

    const diffY = currentY - startY;
    if (isDismissing && diffY > threshold) {
      onDismiss();
    } else {
      panel.style.transform = '';
    }
    isDismissing = false;
  }

  panel.addEventListener('touchstart', handleTouchStart, { passive: true });
  panel.addEventListener('touchmove', handleTouchMove, { passive: false });
  panel.addEventListener('touchend', handleTouchEnd);
}
