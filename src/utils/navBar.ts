import { createDeckSlider } from './deckSlider';
import { isOverlayOpen } from './overlayState';
import { ENGAGE_DISTANCE, isAxisClaimed } from './gesture';
import {
  colorToCss,
  createCssPaintCache,
  parseColor,
  springTween,
  SPRING_NAV,
  withAlpha,
  type Rgba,
} from './motion';
import { createPillTrack } from './slidingHighlight';
import { TAB_ACCENTS, TAB_IDLE_COLOR } from './tabTheme';
import { TAB_ORDER, getActiveTab, navigateToTab, type TabId } from './tabs';

/** While held, the pill lifts into a lens that spills past the bar's edges. */
const DRAG_SCALE = 1.55;
/** Time for the pill to lift into the lens once a drag engages. Matches
 *  --duration-normal, the fade the lens layers use on the way in. */
const LIFT_MS = 240;
/** Extra lens swell at the midpoint of a tap-driven glide. */
const TAP_LENS_SWELL = 0.3;
/** Glide progress at which the lens starts crossfading back into the pill. */
const LENS_HANDBACK = 0.45;
/** How much the lens enlarges the icon directly beneath it. */
const LENS_MAG = 0.22;
/** Distance over which an off-centre grab is pulled onto the finger. */
const GRAB_DECAY_DISTANCE = 140;
const TAP_STIFFNESS_PER_TAB = 48;
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

// Owns every nav interaction (taps, pill drag, panel deck) so the pill, tab
// colours and page move as one rAF animation rather than three transitions.
export function initNavBar(): void {
  const bar = document.querySelector('.main-tab-bar') as HTMLElement | null;
  const navZone = document.querySelector('.bottom-nav-container') as HTMLElement | null;
  const highlight = document.getElementById('navSliderHighlight');
  const buttons = [...document.querySelectorAll('.tab-btn')] as HTMLElement[];
  if (!bar || !navZone || !highlight || buttons.length === 0) return;
  const barEl = bar;
  const navZoneEl = navZone;

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

  // The lens refracts the wash behind the bar, so its per-tab layers fade on
  // exactly the same weights as the wash and never disagree with it.
  const lensLayers = TAB_ORDER.map(
    (tab) => highlight.querySelector(`.lens-refraction[data-tab="${tab}"]`) as HTMLElement | null,
  );

  function beginBackgroundPaint() {
    for (const layer of bgLayers) {
      if (layer) layer.style.transition = 'none';
    }
  }

  const paintedBg = bgLayers.map(() => -1);

  function paintBackground(value: number) {
    for (let i = 0; i < bgLayers.length; i++) {
      const opacity = Math.round(Math.max(0, 1 - Math.abs(value - i)) * 40) / 40;
      if (opacity === paintedBg[i]) continue;
      paintedBg[i] = opacity;
      const css = String(opacity);
      const layer = bgLayers[i];
      if (layer) layer.style.opacity = css;
      const lens = lensLayers[i];
      if (lens) lens.style.opacity = css;
    }
  }

  function clearBackgroundPaint() {
    for (let i = 0; i < bgLayers.length; i++) {
      paintedBg[i] = -1;
      const layer = bgLayers[i];
      if (layer) {
        layer.style.transition = '';
        layer.style.opacity = '';
      }
      lensLayers[i]?.style.removeProperty('opacity');
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
  /** Scale last painted, so a re-grab mid-settle lifts from where it is. */
  let currentScale = 1;
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

  const paintedMag = buttons.map(() => 1);

  // The lens magnifies whatever sits under it, so each button's content grows
  // with its overlap. Scale is mapped back to 0..1 lens strength first, so a
  // resting pill (scale 1) never magnifies anything.
  function paintLens(value: number, scale: number) {
    const lens = Math.min(Math.max((scale - 1) / (DRAG_SCALE - 1), 0), 1);
    for (let i = 0; i < buttons.length; i++) {
      const overlap = Math.max(0, 1 - Math.abs(value - i));
      const mag = Math.round((1 + LENS_MAG * lens * overlap) * 200) / 200;
      if (mag === paintedMag[i]) continue;
      paintedMag[i] = mag;
      if (mag === 1) buttons[i].style.removeProperty('--lens-mag');
      else buttons[i].style.setProperty('--lens-mag', String(mag));
    }
  }

  function clearButtonPaint() {
    for (let i = 0; i < buttons.length; i++) {
      paintedButtons[i] = -1;
      lastButtonColor[i] = '';
      buttons[i].style.color = '';
      paintedMag[i] = 1;
      buttons[i].style.removeProperty('--lens-mag');
    }
  }

  function render(value: number, scale = 1) {
    fraction = value;
    currentScale = scale;
    track.render(value, { scale });
    paintButtons(value);
    paintLens(value, scale);
    paintBackground(value);
    deck?.setPosition(value);
  }

  function commit(index: number) {
    activeIndex = index;
    fraction = index;
    settleFromScale = 1;
    currentScale = 1;

    barEl.classList.remove('nav-animating', 'nav-lens');
    navigateToTab(TAB_ORDER[index]);
    deck?.settle(index);
    clearButtonPaint();
    clearBackgroundPaint();
    track.render(index);
    paint.reset();
  }

  function animateTo(index: number, flingVelocity = 0) {
    cancelTween?.();
    barEl.classList.add('nav-animating');
    beginBackgroundPaint();
    deck?.begin();

    const from = fraction;
    const startScale = settleFromScale;
    const span = index - from;
    const distance = Math.max(Math.abs(span), 0.35);
    // A tap glides as a lens too: it swells mid-flight and settles back into
    // the pill on arrival. A released drag is already a lens and just shrinks.
    const tapSwell = startScale === 1 && span !== 0 ? TAP_LENS_SWELL : 0;
    let lensUp = startScale > 1 || tapSwell > 0;
    if (lensUp) barEl.classList.add('nav-lens');

    cancelTween = springTween(
      from,
      index,
      (value) => {
        const progress = Math.min(Math.max(span === 0 ? 1 : (value - from) / span, 0), 1);
        const swell = tapSwell * Math.sin(Math.PI * progress);
        render(value, startScale + (1 - startScale) * progress + swell);
        // Hand back to the pill partway in, so its face eases in over the
        // tail of the glide instead of snapping on once the spring rests.
        if (lensUp && progress >= LENS_HANDBACK) {
          lensUp = false;
          barEl.classList.remove('nav-lens');
        }
      },
      () => {
        cancelTween = null;
        commit(index);
      },
      {
        ...SPRING_NAV,
        stiffness: SPRING_NAV.stiffness - TAP_STIFFNESS_PER_TAB * Math.min(distance, 3),
        velocity: flingVelocity,
        restDelta: 0.002,
      },
    );
  }

  function selectTab(index: number) {
    if (index < 0 || index >= buttons.length) return;
    if (index === activeIndex) {
      track.render(index);
      return;
    }
    settleFromScale = 1;
    animateTo(index);
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
    barEl.classList.remove('nav-lens');
    clearButtonPaint();
    track.render(index);
    deck?.settle(index);
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
  let liftScale = 1;
  let liftRafId: number | null = null;

  // Grows the pill into the lens over LIFT_MS with a slight overshoot. Runs
  // on its own rAF so the lift finishes even if the finger holds still.
  function startLift() {
    const t0 = performance.now();
    const fromScale = currentScale;
    const step = (now: number) => {
      if (!engaged) {
        liftRafId = null;
        return;
      }
      const p = Math.min((now - t0) / LIFT_MS, 1);
      // A gentle easeOutBack: decelerates into a barely-there overshoot, so
      // the swell reads as one smooth motion rather than a pop.
      const q = p - 1;
      const eased = 1 + 1.6 * q * q * q + 0.6 * q * q;
      liftScale = fromScale + (DRAG_SCALE - fromScale) * eased;
      if (pendingPos === null) render(fraction, liftScale);
      liftRafId = p < 1 ? requestAnimationFrame(step) : null;
    };
    liftRafId = requestAnimationFrame(step);
  }

  function stopLift() {
    if (liftRafId !== null) cancelAnimationFrame(liftRafId);
    liftRafId = null;
  }

  const desktopLayoutQuery = window.matchMedia('(min-width: 768px)');

  function isVerticalNav() {
    return desktopLayoutQuery.matches;
  }

  function flushDrag() {
    dragRafId = null;
    if (pendingPos === null) return;

    const delta = pendingPos - (isVerticalNav() ? startY : startX);
    const decay = Math.max(0, 1 - Math.abs(delta) / GRAB_DECAY_DISTANCE);
    render(track.fractionAt(pendingPos - barOrigin + grabOffset * decay), liftScale);
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
      if (Math.abs(dx) < ENGAGE_DISTANCE && Math.abs(dy) < ENGAGE_DISTANCE) return;
      // Claim only when the gesture runs along the bar's own axis.
      if (!(vertical ? isAxisClaimed(dy, dx) : isAxisClaimed(dx, dy))) {
        dragging = false;
        return;
      }

      engaged = true;
      suppressClick = true;
      cancelTween?.();
      cancelTween = null;
      track.measure();
      barEl.classList.add('nav-animating', 'nav-dragging', 'nav-lens');
      liftScale = currentScale;
      startLift();
      beginBackgroundPaint();
      deck?.begin();

      const rect = barEl.getBoundingClientRect();
      if (vertical) {
        barOrigin = rect.top + barEl.clientTop;
        grabOffset = track.centerAt(fraction) - (startY - barOrigin);
      } else {
        barOrigin = rect.left + barEl.clientLeft;
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

    stopLift();
    barEl.classList.remove('nav-dragging');
    setTimeout(() => {
      suppressClick = false;
    }, 0);

    const centers = track.centers();
    const spacing = centers.length > 1 ? Math.abs(centers[1] - centers[0]) || 1 : 1;
    const target = Math.min(
      Math.max(Math.round(fraction + (velocity * 90) / spacing), 0),
      buttons.length - 1,
    );

    settleFromScale = liftScale;
    // velocity is px/ms along the bar; convert to tab-index units per second.
    animateTo(target, (velocity * 1000) / spacing);
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

  navZoneEl.addEventListener('touchstart', onTouchStart, { passive: true });
  navZoneEl.addEventListener('touchmove', onTouchMove, { passive: false });
  navZoneEl.addEventListener('touchend', onTouchEnd, { passive: true });
  navZoneEl.addEventListener('touchcancel', onTouchEnd, { passive: true });
  navZoneEl.addEventListener('wheel', onWheel, { passive: false });
}
