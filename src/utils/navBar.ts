import { createDeckSlider } from './deckSlider';
import { isOverlayOpen } from './overlayState';
import { ENGAGE_DISTANCE, isAxisClaimed } from './gesture';
import {
  colorToCss,
  createCssPaintCache,
  createSpringValue,
  parseColor,
  SPRING_PRESS,
  SPRING_FILL,
  SPRING_LEAD,
  SPRING_RELEASE,
  SPRING_SNAP,
  SPRING_TRAIL,
  springTween,
  withAlpha,
  type Rgba,
  type SpringParams,
  type SpringStop,
} from './motion';
import { createLiquidLens, NAV_LENS } from './liquidGlass';
import { createPillTrack } from './slidingHighlight';
import { TAB_ACCENTS, TAB_IDLE_COLOR } from './tabTheme';
import { TAB_ORDER, applyChromeColors, applyThemeWeights, getActiveTab, navigateToTab, type TabId } from './tabs';

// Proportions and timing follow iOS 26's Liquid Glass tab bars, measured from
// 60fps recordings. A tap sends the pill across as glass at its own height:
// it stretches, bends what is under its edges, clears its fill mid-hop and
// fills back in on landing. Only a press held ~150ms (or a drag) lifts it into
// a magnifying lens ~1.26x the pill along the bar that just clears the bar
// across it, and swells the whole bar 4.3%.
const LIFT_ALONG = 1.26;
const LIFT_ACROSS = 1.42;
const BAR_SWELL = 0.043;
/** How close (in tabs) the back edge must be before the pill fills in again. */
const GATHERED = 0.35;
/** A quick hop bends what is under its edges more gently than a held lens
 *  (iOS): this share of the lens's refraction and rim shows while it glides. */
const TAP_REFRACTION = 0.45;
/** A press held this long without lifting off becomes a lens. */
const HOLD_MS = 150;
/** How far a travelling pill's fill clears: iOS keeps most of it, so a
 *  hop reads as the dark pill bending at its edges rather than as glass. */
const GLASS_CLEAR = 0.5;
/** Most a drag can pull the lens past the first or last tab, in tabs. */
const RUBBER_LIMIT = 0.35;
/** The lens starts settling back into the pill this close to its tab. */
const DEFLATE_WITHIN = 0.12;
/** 0..1: how strongly a dragged lens dwells on tab centres. */
const MAGNET = 0.5;
/** The page follows the decision on a heavier, bounce-free spring. */
const SPRING_PAGE: SpringParams = { response: 0.36, dampingRatio: 0.94 };
/** Distance over which an off-centre grab is pulled onto the finger. */
const GRAB_DECAY_DISTANCE = 140;
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

// Owns every nav interaction (taps, pill drag, panel deck). The control is
// three springs on one frame loop — where the pill is, how far it has lifted
// into a lens, and how much the bar has swelled — so touch-down answers at
// once, the selection snaps across with a little bounce, and the lens settles
// back into the pill as it arrives. The page (deck, wash, browser chrome)
// moves only once a tab is chosen, so scrubbing the lens across the bar never
// reveals, paints or loads a panel.
export function initNavBar(): void {
  const bar = document.querySelector('.main-tab-bar') as HTMLElement | null;
  const navZone = document.querySelector('.bottom-nav-container') as HTMLElement | null;
  const highlight = document.getElementById('navSliderHighlight');
  const buttons = [...document.querySelectorAll('.tab-btn')] as HTMLElement[];
  if (!bar || !navZone || !highlight || buttons.length === 0) return;
  const barEl = bar;
  const navZoneEl = navZone;
  const pillEl = highlight;

  const deck = createDeckSlider();
  const paint = createCssPaintCache();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

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

  function paintBackground(weights: readonly number[]) {
    for (let i = 0; i < bgLayers.length; i++) {
      const opacity = Math.round((weights[i] ?? 0) * 40) / 40;
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

  // Under the lens every tab shows its selected look; outside it, none do.
  const lens = createLiquidLens({
    host: highlight, buttons, rectAt: track.rectAt, profile: NAV_LENS,
    copyColor: (i) => accentCss[i],
  });

  const oneHot = (index: number): number[] => TAB_ORDER.map((_, i) => (i === index ? 1 : 0));

  /** Committed tab: the panel that is active and interactive. */
  let activeIndex = Math.max(TAB_ORDER.indexOf(getActiveTab()), 0);
  /** Tab the page is gliding to; equals activeIndex once it lands. */
  let pageTarget = activeIndex;
  /** Wash and chrome weights currently on screen, one per tab. */
  let pageWeights = oneHot(activeIndex);
  /** The pill's leading and trailing edges (tab index; the trail chases the
   *  lead, so a hop stretches the pill), glass (0..1: edge refraction and
   *  the selected look under the pill, on for any glide), lens lift (0..1:
   *  size and magnification, only when held) and bar swell (0..1). */
  const pos = createSpringValue(activeIndex, SPRING_SNAP, 0.002);
  const trail = createSpringValue(activeIndex, SPRING_TRAIL, 0.002);
  const glass = createSpringValue(0, SPRING_PRESS, 0.002);
  const lift = createSpringValue(0, SPRING_PRESS, 0.002);
  const swell = createSpringValue(0, SPRING_PRESS, 0.002);
  let controlRaf = 0;
  let cancelPage: SpringStop | null = null;
  /** Pages the deck's running glide travels, to express its speed in pages. */
  let pageTravel = 1;
  /** Finger down on the nav, and whether a drag has claimed it. */
  let pressed = false;
  let engaged = false;

  const paintedButtons = buttons.map(() => -1);
  const lastButtonColor = buttons.map(() => '');

  /** Tab colours follow the pill, and drain away while the lens is lifted:
   *  then the selected look shows only through the glass. */
  function paintButtons(value: number, strength: number) {
    for (let i = 0; i < buttons.length; i++) {
      const near = Math.max(0, 1 - Math.abs(value - i)) * (1 - strength);
      const activeness = Math.round(near * 24) / 24;
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

  let paintedSwell = 0;
  function paintSwell(value: number) {
    const scale = Math.round((1 + BAR_SWELL * value) * 10000) / 10000;
    if (scale === paintedSwell) return;
    paintedSwell = scale;
    barEl.style.transform = scale === 1 ? '' : `scale(${scale})`;
  }

  let paintedFace = '';
  // The control alone: cheap enough to run every frame of a drag.
  function renderControl() {
    const value = (pos.value + trail.value) / 2;
    // A lift that overshoots reads as a bubble; one that dips below zero on
    // release briefly tucks the pill in, as the bar does.
    const l = Math.max(lift.value, -0.08);
    const lifted = Math.min(Math.max(l, 0), 1);
    const strength = Math.min(Math.max(Math.max(glass.value, lifted), 0), 1);
    // A dragged lens stretches with its speed; a hop stretches by its edges.
    const speedStretch = lens.stretchFor(track.centerAt(value));
    // A lifted lens stays inside the bar at the first and last tab (the swell
    // scales the bar and the lens together, so the bar's own box is enough).
    const extent = isVerticalNav() ? barEl.clientHeight : barEl.clientWidth;
    const pose = track.renderSpan(trail.value, pos.value, {
      scale: 1 + (LIFT_ALONG - 1) * l,
      scaleAcross: 1 + (LIFT_ACROSS - 1) * l,
      stretch: engaged ? speedStretch * strength : 0,
      bounds: lifted > 0 ? { min: 0, max: extent } : undefined,
    });
    paintButtons(value, strength);
    const travelling = Math.min(Math.max(glass.value, 0), 1);
    if (pose) lens.paint(pose, Math.max(lifted, travelling * TAP_REFRACTION), lifted);
    // The dark fill clears as the pill turns to glass, entirely once lifted.
    const face = (1 - Math.max(lifted, Math.min(Math.max(glass.value, 0), 1) * GLASS_CLEAR)).toFixed(2);
    if (face !== paintedFace) {
      paintedFace = face;
      if (face === '1.00') pillEl.style.removeProperty('--face');
      else pillEl.style.setProperty('--face', face);
    }
    paintSwell(swell.value);
  }

  function paintPage(weights: readonly number[]) {
    pageWeights = weights.slice();
    paintBackground(weights);
    applyThemeWeights(weights);
  }

  // Tab colours stay painted until both motions rest, so they never flash
  // back to the old tab's accent while the page is still on its way.
  function settleIfIdle() {
    if (controlRaf || cancelPage || pressed) return;
    barEl.classList.remove('nav-animating');
    clearButtonPaint();
    paint.reset();
  }

  function finishControl() {
    controlRaf = 0;
    lastTick = 0;
    lens.clear();
    track.render(Math.round(pos.value));
    trail.jump(pos.value);
    paintSwell(0);
    settleIfIdle();
  }

  let lastTick = 0;
  function tick(now: number) {
    const prev = lastTick && now - lastTick < 100 ? lastTick : now - 1000 / 60;
    lastTick = now;
    if (pendingPos !== null) flushDrag();
    // The trailing edge is pulled after the leading one.
    const leadMoving = pos.step(now);
    if (engaged) trail.jump(pos.value);
    else if (Math.abs(trail.target - pos.value) > 1e-4 || leadMoving) trail.to(pos.value, { params: SPRING_TRAIL, at: prev });
    // Glass and lens hold while the pill travels and settle back into it as
    // it gathers in on arrival: the front has landed and the back is close.
    if (!pressed && Math.abs(pos.value - pos.target) < DEFLATE_WITHIN && Math.abs(trail.value - pos.target) < GATHERED) {
      if (lift.target > 0) lift.to(0, { params: SPRING_RELEASE });
      if (glass.target > 0) glass.to(0, { params: SPRING_FILL });
    }
    const moving = [leadMoving, trail.step(now), glass.step(now), lift.step(now), swell.step(now)].some(Boolean);
    renderControl();
    if (moving || pressed) controlRaf = requestAnimationFrame(tick);
    else finishControl();
  }

  function runControl() {
    barEl.classList.add('nav-animating');
    if (!controlRaf) controlRaf = requestAnimationFrame(tick);
  }

  /** A held press or a drag: the bar swells and the pill lifts into a lens
   *  wherever it is right now. */
  function press() {
    clearTimeout(holdTimer);
    if (reducedMotion.matches || lift.target > 0) return;
    track.measure();
    lift.to(1, { params: SPRING_PRESS });
    swell.to(1, { params: SPRING_PRESS });
    runControl();
  }

  /** Snaps the selection to `index`; `velocity` is in tabs per second. */
  function controlTo(index: number, velocity?: number) {
    if (reducedMotion.matches) {
      pos.jump(index); trail.jump(index); glass.jump(0); lift.jump(0); swell.jump(0);
      renderControl(); finishControl();
      return;
    }
    // Any glide crosses as glass; a lifted lens just carries on as one.
    if (Math.abs(index - pos.value) > DEFLATE_WITHIN) glass.to(1, { params: SPRING_PRESS });
    pos.to(index, { velocity, params: SPRING_LEAD });
    swell.to(0, { params: SPRING_RELEASE });
    runControl();
  }

  function commitPage(index: number) {
    activeIndex = index;
    pageTarget = index;
    pageWeights = oneHot(index);
    barEl.classList.remove('nav-paging');
    navigateToTab(TAB_ORDER[index]);
    deck?.settle(index);
    clearBackgroundPaint();
    settleIfIdle();
  }

  // The page moves once per decision, straight from what is on screen.
  function pageTo(index: number) {
    if (index === pageTarget && (cancelPage || index === activeIndex)) return;
    // Speed in pages per second, so a glide retargeted mid-flight keeps it.
    const carried = cancelPage ? cancelPage.velocity() * pageTravel : 0;
    cancelPage?.();
    cancelPage = null;
    pageTarget = index;
    if (reducedMotion.matches) { commitPage(index); return; }

    barEl.classList.add('nav-animating', 'nav-paging');
    beginBackgroundPaint();
    applyChromeColors(TAB_ORDER[index]);
    pageTravel = Math.abs(deck?.glide(index) ?? 1) || 1;
    const from = pageWeights.slice();
    const to = oneHot(index);
    const weights = from.slice();
    cancelPage = springTween(
      0,
      1,
      (progress) => {
        // The wash and chrome are weights: they must not overshoot.
        const p = Math.min(Math.max(progress, 0), 1);
        for (let i = 0; i < weights.length; i++) weights[i] = from[i] + (to[i] - from[i]) * p;
        paintPage(weights);
        deck?.setGlide(progress);
      },
      () => {
        cancelPage = null;
        commitPage(index);
      },
      // Within half a pixel of a phone-width page.
      {
        stiffness: (2 * Math.PI / SPRING_PAGE.response) ** 2,
        damping: (4 * Math.PI * SPRING_PAGE.dampingRatio) / SPRING_PAGE.response,
        velocity: carried / pageTravel,
        restDelta: 0.0015 / pageTravel,
      },
    );
  }

  function selectTab(index: number) {
    if (index < 0 || index >= buttons.length) return;
    controlTo(index);
    if (index !== pageTarget || (!cancelPage && index !== activeIndex)) pageTo(index);
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
      if (!controlRaf) track.render(pos.value);
    });
  });
  buttons.forEach((btn) => resizeObserver.observe(btn));

  // ── Taps ────────────────────────────────────────────────────────────────
  // Touch selects on touchend (below); the click that follows it is ignored,
  // so mouse and keyboard are the only clicks that select.
  let suppressClickUntil = 0;
  const isTouchClick = (e: MouseEvent) => e.isTrusted && e.detail > 0 && performance.now() < suppressClickUntil;

  buttons.forEach((btn, index) => {
    btn.addEventListener('click', (e) => {
      if (isTouchClick(e)) return;
      selectTab(index);
    });
  });

  // While the lens glides it cuts a hole in each tab it covers, and a clipped
  // region is not hit-testable, so a click there lands on the bar. It still
  // means the tab under the pointer.
  barEl.addEventListener('click', (e) => {
    if (isTouchClick(e) || (e.target as Element).closest('.tab-btn')) return;
    selectTab(Math.round(track.fractionAt(localPos(isVerticalNav() ? e.clientY : e.clientX))));
  });

  window.addEventListener('tab-navigated', (e) => {
    const tab = (e as CustomEvent<{ tab: string }>).detail.tab;
    const index = TAB_ORDER.indexOf(tab as TabId);
    if (index === -1 || index === activeIndex) return;

    cancelAnimationFrame(controlRaf);
    controlRaf = 0;
    cancelPage?.();
    cancelPage = null;
    activeIndex = index;
    pageTarget = index;
    pageWeights = oneHot(index);
    pos.jump(index); trail.jump(index); glass.jump(0); lift.jump(0); swell.jump(0);
    paintSwell(0);
    pillEl.style.removeProperty('--face');
    paintedFace = '';
    barEl.classList.remove('nav-animating', 'nav-paging');
    clearBackgroundPaint();
    clearButtonPaint();
    lens.clear();
    track.render(index);
    deck?.settle(index);
  });

  // ── Touch: press, drag, release ─────────────────────────────────────────
  let startX = 0;
  let startY = 0;
  let lastPos = 0;
  let lastTime = 0;
  let velocity = 0;
  let grabOffset = 0;
  let pendingPos: number | null = null;
  /** Bar geometry from touch-down, before the swell changes its box. */
  let barCenter = 0;
  let barHalf = 0;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;

  const desktopLayoutQuery = window.matchMedia('(min-width: 768px)');

  function isVerticalNav() {
    return desktopLayoutQuery.matches;
  }

  function measureBar() {
    const rect = barEl.getBoundingClientRect();
    const vertical = isVerticalNav();
    const scale = 1 + BAR_SWELL * swell.value;
    barCenter = vertical ? rect.top + rect.height / 2 : rect.left + rect.width / 2;
    barHalf = (vertical ? rect.height : rect.width) / scale / 2;
  }

  /** A client coordinate along the bar, in the track's (unswollen) space. */
  function localPos(client: number): number {
    if (!controlRaf || !barHalf) measureBar();
    const scale = 1 + BAR_SWELL * swell.value;
    const border = isVerticalNav() ? barEl.clientTop : barEl.clientLeft;
    return (client - barCenter) / scale + barHalf - border;
  }

  /** Dwells on tab centres and moves quickly between them, so a drag
   *  settles into each tab it passes rather than sliding through. */
  function magnetise(value: number): number {
    return value - (MAGNET / (2 * Math.PI)) * Math.sin(2 * Math.PI * value);
  }

  /** Past the first or last tab the lens follows with growing resistance. */
  function rubberBand(over: number): number {
    return (RUBBER_LIMIT * over) / (over + RUBBER_LIMIT * 2);
  }

  function flushDrag() {
    if (pendingPos === null) return;
    const delta = pendingPos - (isVerticalNav() ? startY : startX);
    const decay = Math.max(0, 1 - Math.abs(delta) / GRAB_DECAY_DISTANCE);
    const at = localPos(pendingPos) + grabOffset * decay;
    const centers = track.centers();
    const last = buttons.length - 1;
    const spacing = centers.length > 1 ? Math.abs(centers[1] - centers[0]) || 1 : 1;
    let value = magnetise(track.fractionAt(at));
    if (at < centers[0]) value = -rubberBand((centers[0] - at) / spacing);
    else if (at > centers[last]) value = last + rubberBand((at - centers[last]) / spacing);
    pos.jump(value);
    trail.jump(value);
    pendingPos = null;
  }

  function onTouchStart(e: TouchEvent) {
    if (isOverlayOpen() || e.touches.length !== 1) return;
    pressed = true;
    engaged = false;
    velocity = 0;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    lastPos = isVerticalNav() ? startY : startX;
    lastTime = performance.now();
    measureBar();
    // A tap never lifts; a press held past HOLD_MS becomes a lens.
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => { if (pressed) press(); }, HOLD_MS);
  }

  function onTouchMove(e: TouchEvent) {
    if (!pressed) return;

    const clientX = e.touches[0].clientX;
    const clientY = e.touches[0].clientY;
    const dx = clientX - startX;
    const dy = clientY - startY;
    const vertical = isVerticalNav();

    if (!engaged) {
      if (Math.abs(dx) < ENGAGE_DISTANCE && Math.abs(dy) < ENGAGE_DISTANCE) return;
      // Claim only when the gesture runs along the bar's own axis.
      if (!(vertical ? isAxisClaimed(dy, dx) : isAxisClaimed(dx, dy))) {
        release(pageTarget);
        return;
      }
      engaged = true;
      barEl.classList.add('nav-dragging');
      press();
      // The lens is picked up where it is, then drawn onto the finger.
      grabOffset = track.centerAt(pos.value) - localPos(vertical ? startY : startX);
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
  }

  /** Lets go: the selection snaps to `target`, the bar deflates, and the
   *  lens settles into the pill as it arrives. */
  function release(target: number, tabsPerSecond?: number) {
    clearTimeout(holdTimer);
    pressed = false;
    engaged = false;
    barEl.classList.remove('nav-dragging');
    controlTo(target, tabsPerSecond);
  }

  function onTouchEnd() {
    if (!pressed) return;
    suppressClickUntil = performance.now() + 600;
    if (pendingPos !== null) flushDrag();
    const vertical = isVerticalNav();
    const centers = track.centers();
    const spacing = centers.length > 1 ? Math.abs(centers[1] - centers[0]) || 1 : 1;
    let target: number;
    let flick: number | undefined;
    if (engaged) {
      // A pause before lifting leaves the last move's speed behind.
      if (performance.now() - lastTime > 50) velocity = 0;
      // velocity is px/ms along the bar; carry it on in tabs per second.
      flick = (velocity * 1000) / spacing;
      target = Math.round(pos.value + (velocity * 90) / spacing);
    } else {
      // A tap, quick or held, picks the tab under the finger.
      target = Math.round(track.fractionAt(localPos(vertical ? startY : startX)));
    }
    target = Math.min(Math.max(target, 0), buttons.length - 1);
    release(target, flick);
    // The choice is made: only now does the page move.
    if (target !== pageTarget || (!cancelPage && target !== activeIndex)) pageTo(target);
  }

  function onTouchCancel() {
    if (!pressed) return;
    pendingPos = null;
    release(pageTarget);
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
    selectTab(Math.min(Math.max(pageTarget + direction, 0), buttons.length - 1));
  }

  navZoneEl.addEventListener('touchstart', onTouchStart, { passive: true });
  navZoneEl.addEventListener('touchmove', onTouchMove, { passive: false });
  navZoneEl.addEventListener('touchend', onTouchEnd, { passive: true });
  navZoneEl.addEventListener('touchcancel', onTouchCancel, { passive: true });
  navZoneEl.addEventListener('wheel', onWheel, { passive: false });
  document.documentElement.dataset.appReady = 'true';
}
