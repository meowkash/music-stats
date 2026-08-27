import { createDeckSlider } from './deckSlider';
import {
  colorToCss,
  createCssPaintCache,
  parseColor,
  rafTween,
  withAlpha,
  type Rgba,
} from './motion';
import { createPillTrack } from './slidingHighlight';
import { TAB_ACCENTS, TAB_IDLE_COLOR } from './tabTheme';
import { TAB_ORDER, getActiveTab, navigateToTab, type TabId } from './tabs';

/** Pill swells slightly while held, like the iOS tab bar. */
const DRAG_SCALE = 1.08;
const DRAG_START_THRESHOLD = 6;
/** Distance over which an off-centre grab is pulled onto the finger. */
const GRAB_DECAY_DISTANCE = 140;
const MIN_SETTLE_MS = 200;
const MAX_SETTLE_MS = 420;
const TAP_BASE_MS = 300;
const TAP_PER_TAB_MS = 50;
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

function isOverlayOpen(): boolean {
  return (
    document.body.classList.contains('overlay-open') ||
    document.body.classList.contains('stats-sheet-open')
  );
}

/**
 * Owns every nav interaction — taps, the free-form pill drag and the panel
 * deck — so the pill, the tab colours and the page always move together as one
 * rAF-driven animation instead of three transitions with different timings.
 */
export function initNavBar(): void {
  const bar = document.querySelector('.main-tab-bar') as HTMLElement | null;
  const navZone = document.querySelector('.bottom-nav-container') as HTMLElement | null;
  const highlight = document.getElementById('navSliderHighlight');
  const buttons = [...document.querySelectorAll('.tab-btn')] as HTMLElement[];
  if (!bar || !navZone || !highlight || buttons.length === 0) return;

  const deck = createDeckSlider();
  const paint = createCssPaintCache();

  const accentRgba: Rgba[] = buttons.map((btn) => {
    const accent = TAB_ACCENTS[(btn.dataset.tab || '') as TabId];
    return (accent ? parseColor(accent.color) : null) ?? WHITE;
  });
  // Pre-format once — measure() must not reallocate colour strings.
  const accentCss = accentRgba.map((c) => colorToCss(c));
  const glowCss = accentRgba.map((c) => withAlpha(c, 0.4));
  const idleRgba = parseColor(TAB_IDLE_COLOR) ?? { r: 255, g: 255, b: 255, a: 0.8 };
  const idleCss = colorToCss(idleRgba);

  const bgLayers = TAB_ORDER.map(
    (tab) =>
      document.querySelector(`#app-bg-gradient .bg-layer[data-tab="${tab}"]`) as HTMLElement | null,
  );

  function beginBackgroundPaint() {
    for (const layer of bgLayers) {
      if (layer) layer.style.transition = 'none';
    }
  }

  const paintedBg = bgLayers.map(() => -1);

  function paintBackground(value: number) {
    for (let i = 0; i < bgLayers.length; i++) {
      const layer = bgLayers[i];
      if (!layer) continue;
      const opacity = Math.round(Math.max(0, 1 - Math.abs(value - i)) * 40) / 40;
      if (opacity === paintedBg[i]) continue;
      paintedBg[i] = opacity;
      layer.style.opacity = String(opacity);
    }
  }

  function clearBackgroundPaint() {
    for (let i = 0; i < bgLayers.length; i++) {
      const layer = bgLayers[i];
      paintedBg[i] = -1;
      if (!layer) continue;
      layer.style.transition = '';
      layer.style.opacity = '';
    }
  }

  const accentByBtn = new Map(
    buttons.map((btn, i) => [btn, { color: accentCss[i], glow: glowCss[i] }]),
  );

  const track = createPillTrack({
    highlightEl: highlight,
    buttons,
    accentFor: (btn) => accentByBtn.get(btn) ?? null,
  });

  let activeIndex = Math.max(TAB_ORDER.indexOf(getActiveTab()), 0);
  let fraction = activeIndex;
  let settleFromScale = 1;
  let cancelTween: (() => void) | null = null;

  const paintedButtons = buttons.map(() => -1);
  const lastButtonColor = buttons.map(() => '');

  function paintButtons(value: number) {
    // Only the two nearest tabs can be partially active; skip the rest.
    const lo = Math.max(0, Math.floor(value) - 1);
    const hi = Math.min(buttons.length - 1, Math.ceil(value) + 1);

    for (let i = 0; i < buttons.length; i++) {
      const activeness =
        i < lo || i > hi ? 0 : Math.round(Math.max(0, 1 - Math.abs(value - i)) * 24) / 24;
      if (activeness === paintedButtons[i]) continue;
      paintedButtons[i] = activeness;

      const css =
        activeness === 0
          ? idleCss
          : activeness === 1
            ? accentCss[i]
            : paint.color(idleRgba, accentRgba[i], activeness);

      if (css === lastButtonColor[i]) continue;
      lastButtonColor[i] = css;
      buttons[i].style.color = css;
    }
  }

  function clearButtonPaint() {
    for (let i = 0; i < buttons.length; i++) {
      paintedButtons[i] = -1;
      lastButtonColor[i] = '';
      buttons[i].style.color = '';
    }
  }

  function render(value: number, scale = 1) {
    fraction = value;
    track.render(value, { scale });
    paintButtons(value);
    paintBackground(value);
    deck?.setPosition(value);
  }

  function commit(index: number) {
    activeIndex = index;
    fraction = index;
    settleFromScale = 1;

    // Hand control back in one paint: classes first, then clear inline overrides
    // that exactly match the class-driven end state.
    bar.classList.remove('nav-animating');
    navigateToTab(TAB_ORDER[index]);
    deck?.end();
    clearButtonPaint();
    clearBackgroundPaint();
    track.render(index);
    paint.reset();
  }

  function animateTo(index: number, durationMs: number) {
    cancelTween?.();
    bar.classList.add('nav-animating');
    beginBackgroundPaint();
    deck?.begin();

    const from = fraction;
    const startScale = settleFromScale;

    cancelTween = rafTween(
      0,
      1,
      durationMs,
      (progress) => {
        render(from + (index - from) * progress, startScale + (1 - startScale) * progress);
      },
      () => {
        cancelTween = null;
        commit(index);
      },
    );
  }

  function selectTab(index: number) {
    if (index < 0 || index >= buttons.length) return;
    if (index === activeIndex) {
      track.render(index);
      return;
    }
    const distance = Math.abs(index - fraction);
    animateTo(index, TAP_BASE_MS + TAP_PER_TAB_MS * Math.min(distance, 3));
  }

  track.measure();
  track.render(activeIndex);

  let resizeRaf: number | null = null;
  const resizeObserver = new ResizeObserver(() => {
    if (resizeRaf !== null) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = null;
      track.measure();
      deck?.measure();
      if (!cancelTween) track.render(fraction);
    });
  });
  buttons.forEach((btn) => resizeObserver.observe(btn));

  // ── Taps ────────────────────────────────────────────────────────────────
  let suppressClick = false;

  buttons.forEach((btn, index) => {
    btn.addEventListener('click', () => {
      if (suppressClick) return;
      selectTab(index);
    });
  });

  window.addEventListener('tab-navigated', (e) => {
    const tab = (e as CustomEvent<{ tab: string }>).detail.tab;
    const index = TAB_ORDER.indexOf(tab as TabId);
    if (index === -1 || index === activeIndex) return;

    cancelTween?.();
    cancelTween = null;
    activeIndex = index;
    fraction = index;
    track.render(index);
  });

  // ── Free-form pill drag + desktop wheel ─────────────────────────────────
  let dragging = false;
  let engaged = false;
  let startX = 0;
  let startY = 0;
  let lastPos = 0;
  let lastTime = 0;
  let velocity = 0;
  let grabOffset = 0;
  let barOrigin = 0;
  let pendingPos: number | null = null;
  let dragRafId: number | null = null;

  const desktopLayoutQuery = window.matchMedia('(min-width: 768px)');

  function isVerticalNav() {
    return desktopLayoutQuery.matches;
  }

  function flushDrag() {
    dragRafId = null;
    if (pendingPos === null) return;

    const delta = pendingPos - (isVerticalNav() ? startY : startX);
    const decay = Math.max(0, 1 - Math.abs(delta) / GRAB_DECAY_DISTANCE);
    render(track.fractionAt(pendingPos - barOrigin + grabOffset * decay), DRAG_SCALE);
    pendingPos = null;
  }

  function cancelPendingDrag(flush = false) {
    if (dragRafId !== null) {
      cancelAnimationFrame(dragRafId);
      dragRafId = null;
    }
    if (flush && pendingPos !== null) flushDrag();
    else pendingPos = null;
  }

  function onTouchStart(e: TouchEvent) {
    if (isOverlayOpen() || e.touches.length !== 1) return;

    dragging = true;
    engaged = false;
    velocity = 0;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    lastPos = isVerticalNav() ? startY : startX;
    lastTime = performance.now();
  }

  function onTouchMove(e: TouchEvent) {
    if (!dragging) return;

    const clientX = e.touches[0].clientX;
    const clientY = e.touches[0].clientY;
    const dx = clientX - startX;
    const dy = clientY - startY;
    const vertical = isVerticalNav();

    if (!engaged) {
      if (Math.abs(dx) < DRAG_START_THRESHOLD && Math.abs(dy) < DRAG_START_THRESHOLD) return;
      if (vertical ? Math.abs(dx) > Math.abs(dy) : Math.abs(dy) > Math.abs(dx)) {
        dragging = false;
        return;
      }

      engaged = true;
      suppressClick = true;
      cancelTween?.();
      cancelTween = null;
      track.measure();
      bar.classList.add('nav-animating', 'nav-dragging');
      beginBackgroundPaint();
      deck?.begin();

      const rect = bar.getBoundingClientRect();
      if (vertical) {
        barOrigin = rect.top + bar.clientTop;
        grabOffset = track.centerAt(fraction) - (startY - barOrigin);
      } else {
        barOrigin = rect.left + bar.clientLeft;
        grabOffset = track.centerAt(fraction) - (startX - barOrigin);
      }
    }

    e.preventDefault();

    const clientPos = vertical ? clientY : clientX;
    const now = performance.now();
    const dt = now - lastTime;
    if (dt > 0) {
      velocity = velocity * 0.2 + ((clientPos - lastPos) / dt) * 0.8;
      lastPos = clientPos;
      lastTime = now;
    }

    pendingPos = clientPos;
    if (dragRafId === null) dragRafId = requestAnimationFrame(flushDrag);
  }

  function onTouchEnd() {
    if (!dragging) return;
    dragging = false;
    cancelPendingDrag(true);
    if (!engaged) return;
    engaged = false;

    bar.classList.remove('nav-dragging');
    setTimeout(() => {
      suppressClick = false;
    }, 0);

    const centers = track.centers();
    const spacing = centers.length > 1 ? Math.abs(centers[1] - centers[0]) || 1 : 1;
    const target = Math.min(
      Math.max(Math.round(fraction + (velocity * 90) / spacing), 0),
      buttons.length - 1,
    );

    const distance = Math.abs(target - fraction) * spacing;
    const speed = Math.max(Math.abs(velocity), 0.4);
    const duration = Math.min(Math.max(distance / speed, MIN_SETTLE_MS), MAX_SETTLE_MS);

    settleFromScale = DRAG_SCALE;
    animateTo(target, duration);
  }

  // Touchpad / mouse wheel over the nav — steps through tabs along whichever
  // axis the bar runs (vertical sidebar on desktop, horizontal bar on mobile).
  let wheelAccum = 0;
  let wheelResetTimer: ReturnType<typeof setTimeout> | null = null;
  const WHEEL_THRESHOLD = 55;

  function onWheel(e: WheelEvent) {
    if (isOverlayOpen()) return;

    const vertical = isVerticalNav();
    const primary = vertical ? e.deltaY : e.deltaX;
    const cross = vertical ? e.deltaX : e.deltaY;
    // A pan across the bar's axis is a tab change; anything else is not ours.
    if (Math.abs(primary) <= Math.abs(cross)) return;

    e.preventDefault();

    wheelAccum += primary;
    if (wheelResetTimer) clearTimeout(wheelResetTimer);
    wheelResetTimer = setTimeout(() => {
      wheelAccum = 0;
    }, 180);

    if (Math.abs(wheelAccum) < WHEEL_THRESHOLD) return;

    const direction = wheelAccum > 0 ? 1 : -1;
    wheelAccum = 0;
    selectTab(Math.min(Math.max(activeIndex + direction, 0), buttons.length - 1));
  }

  navZone.addEventListener('touchstart', onTouchStart, { passive: true });
  navZone.addEventListener('touchmove', onTouchMove, { passive: false });
  navZone.addEventListener('touchend', onTouchEnd, { passive: true });
  navZone.addEventListener('touchcancel', onTouchEnd, { passive: true });
  navZone.addEventListener('wheel', onWheel, { passive: false });
}
