import { bindWheelPan } from './wheelPan';

export interface HorizontalSwipeOptions {
  element: HTMLElement;
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  threshold?: number;
}

/** Bind horizontal swipe gestures on an element (category/year toggles, etc.). */
export function bindHorizontalSwipe(options: HorizontalSwipeOptions): () => void {
  const { element, onSwipeLeft, onSwipeRight, threshold = 50 } = options;
  let touchStartX = 0;
  let touchStartY = 0;

  const onStart = (e: TouchEvent) => {
    touchStartX = e.changedTouches[0].screenX;
    touchStartY = e.changedTouches[0].screenY;
  };

  const onEnd = (e: TouchEvent) => {
    const touchEndX = e.changedTouches[0].screenX;
    const touchEndY = e.changedTouches[0].screenY;
    const diffX = touchStartX - touchEndX;
    const diffY = touchStartY - touchEndY;

    if (Math.abs(diffX) > threshold && Math.abs(diffX) > Math.abs(diffY)) {
      if (diffX > 0) onSwipeLeft?.();
      else onSwipeRight?.();
    }
  };

  element.addEventListener('touchstart', onStart, { passive: true });
  element.addEventListener('touchend', onEnd, { passive: true });

  // Trackpad two-finger pans fire the same callbacks. The step is consumed as
  // the pan crosses each threshold, so one long pan can advance more than once.
  let consumed = 0;
  const unbindWheel = bindWheelPan({
    element,
    axis: 'x',
    onStart: () => {
      consumed = 0;
    },
    onMove: (delta) => {
      while (delta - consumed <= -threshold) {
        consumed -= threshold;
        onSwipeLeft?.();
      }
      while (delta - consumed >= threshold) {
        consumed += threshold;
        onSwipeRight?.();
      }
    },
  });

  return () => {
    element.removeEventListener('touchstart', onStart);
    element.removeEventListener('touchend', onEnd);
    unbindWheel();
  };
}
