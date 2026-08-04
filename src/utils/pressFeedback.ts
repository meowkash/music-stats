/**
 * App-like press feedback for touch / pen.
 *
 * CSS :hover and :active stick on mobile (and WebKit even "hovers" rows as
 * content scrolls under a lingering touch). Hover stays behind
 * `(hover: hover) and (pointer: fine)`; this helper adds a short-lived
 * `.is-pressed` that clears as soon as the finger moves, scrolls, or lifts.
 */

const PRESS_SELECTOR = [
  '.scrobble-row.clickable-entity',
  '.carousel-item.clickable-entity',
  '.hover-scale',
  '.range-btn',
  '.sub-tab-btn',
  '.tab-btn',
  '.nav-circle-btn',
  '.overlay-album-card',
  '.dropdown-item',
  '.dropdown-trigger',
  '.years-info-btn',
  '.checkbox-label',
  '.overlay-link',
].join(',');

const MOVE_CANCEL_PX = 8;

export function initPressFeedback(): void {
  let pressed: HTMLElement | null = null;
  let startX = 0;
  let startY = 0;

  const clear = () => {
    if (!pressed) return;
    pressed.classList.remove('is-pressed');
    pressed = null;
  };

  document.addEventListener(
    'pointerdown',
    (e) => {
      // Mouse keeps native :active under the fine-pointer media query.
      if (e.pointerType === 'mouse') return;
      if (e.pointerType === 'touch' && e.isPrimary === false) return;

      const target = (e.target as Element | null)?.closest?.(PRESS_SELECTOR) as
        | HTMLElement
        | null;
      if (!target) return;

      clear();
      pressed = target;
      startX = e.clientX;
      startY = e.clientY;
      target.classList.add('is-pressed');
    },
    { passive: true },
  );

  document.addEventListener(
    'pointermove',
    (e) => {
      if (!pressed) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (dx * dx + dy * dy > MOVE_CANCEL_PX * MOVE_CANCEL_PX) clear();
    },
    { passive: true },
  );

  document.addEventListener('pointerup', clear, { passive: true });
  document.addEventListener('pointercancel', clear, { passive: true });
  document.addEventListener('scroll', clear, { passive: true, capture: true });
  // Overlay / tab transitions should never leave a row looking pressed.
  document.addEventListener('visibilitychange', clear);
  window.addEventListener('open-entity-details', clear);
}
