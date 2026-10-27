import {
  colorToCss,
  createSpringValue,
  lerpColorInto,
  parseColor,
  SPRING_FILL,
  SPRING_LEAD,
  SPRING_PRESS,
  SPRING_RELEASE,
  SPRING_SNAP,
  SPRING_TRAIL,
  withAlpha,
  type Rgba,
} from './motion';
import { createLiquidLens, SEGMENT_LENS } from './liquidGlass';

export interface PillAccent {
  color: string;
  glow: string;
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface ResolvedAccent {
  rgba: Rgba | null;
  color: string;
  glow: string;
}

export interface PillRenderOptions {
  /** Scale around the pill centre — used for the lifted lens. */
  scale?: number;
  /** Cross-axis scale when it differs from `scale`: a lifted lens grows more
   *  across the bar than along it. */
  scaleAcross?: number;
  /** Jelly deformation: grows the main axis by this fraction and thins the
   *  cross axis to suit, as a fast-moving lens does. */
  stretch?: number;
  /** Main-axis span (offset-parent coordinates) the scaled pill must stay
   *  inside: iOS keeps a lifted lens within the bar at its first and last tab. */
  bounds?: { min: number; max: number };
}

/** What render() last wrote: the unscaled rect plus the transform on it. */
export interface PillPose {
  rect: Rect;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}

export interface PillTrackOptions {
  highlightEl: HTMLElement;
  buttons: HTMLElement[];
  accentFor?: (btn: HTMLElement) => PillAccent | null;
}

export interface PillTrack {
  measure: () => void;
  count: () => number;
  /** Main-axis centre of each button, in offset-parent coordinates. */
  centers: () => number[];
  /** Main-axis centre at a fractional index. */
  centerAt: (fraction: number) => number;
  /** Fractional index for a main-axis position; inverse of `centerAt()`. */
  fractionAt: (position: number) => number;
  /** Button rect at an integer index, after measure(). */
  rectAt: (index: number) => Rect | null;
  /** Renders the pill at a fractional index. Interpolates geometry and colour. */
  render: (fraction: number, options?: PillRenderOptions) => PillPose | null;
  /** Renders the pill stretched to cover both fractional positions, as a
   *  pill does mid-hop when its two edges move apart. */
  renderSpan: (from: number, to: number, options?: PillRenderOptions) => PillPose | null;
  /** Renders the pill at an explicit rect (used for direct A→B glides). */
  renderRect: (rect: Rect, accentIndex?: number, options?: PillRenderOptions) => PillPose;
  /** Fractional index currently on screen. */
  applied: () => number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpRect(a: Rect, b: Rect, t: number): Rect {
  return {
    left: lerp(a.left, b.left, t),
    top: lerp(a.top, b.top, t),
    width: lerp(a.width, b.width, t),
    height: lerp(a.height, b.height, t),
  };
}

// Pill highlight at any fractional position. Geometry is written every call so
// a re-measure can't leave the DOM at translate(0,0) while JS thinks it moved.
export function createPillTrack(options: PillTrackOptions): PillTrack {
  const { highlightEl, buttons, accentFor } = options;
  const mixScratch: Rgba = { r: 0, g: 0, b: 0, a: 0 };

  let rects: Rect[] = [];
  let accents: ResolvedAccent[] = [];
  let centerList: number[] = [];
  let horizontal = true;
  let appliedFraction = 0;
  let measuredOnce = false;

  function measure() {
    if (!measuredOnce) {
      highlightEl.style.transition = 'none';
      measuredOnce = true;
    }
    // Belt-and-braces: never let a stylesheet transition chase our writes.
    highlightEl.style.transition = 'none';

    rects = buttons.map((btn) => ({
      left: btn.offsetLeft,
      top: btn.offsetTop,
      width: btn.offsetWidth,
      height: btn.offsetHeight,
    }));

    accents = buttons.map((btn) => {
      const accent = accentFor?.(btn) ?? null;
      return {
        rgba: accent ? parseColor(accent.color) : null,
        color: accent?.color ?? 'rgba(255, 255, 255, 0.25)',
        glow: accent?.glow ?? 'rgba(0, 0, 0, 0.45)',
      };
    });

    horizontal = rects.length < 2 || rects[1].left !== rects[0].left;
    centerList = rects.map((r) => (horizontal ? r.left + r.width / 2 : r.top + r.height / 2));
  }

  function paintAccent(index: number, t = 0) {
    const i0 = Math.min(Math.max(index, 0), Math.max(accents.length - 1, 0));
    const i1 = Math.min(i0 + 1, Math.max(accents.length - 1, 0));
    const from = accents[i0];
    const to = accents[i1];
    if (from?.rgba && to?.rgba) {
      lerpColorInto(from.rgba, to.rgba, t, mixScratch);
      highlightEl.style.setProperty('--hl-color', colorToCss(mixScratch));
      highlightEl.style.setProperty('--hl-glow', withAlpha(mixScratch, 0.4));
    } else if (from) {
      highlightEl.style.setProperty('--hl-color', from.color);
      highlightEl.style.setProperty('--hl-glow', from.glow);
    }
  }

  function place(rect: Rect, renderOptions: PillRenderOptions): PillPose {
    const scale = renderOptions.scale ?? 1;
    const stretch = renderOptions.stretch ?? 0;
    const along = scale * (1 + stretch);
    // A travelling pill keeps (nearly) its height while it stretches.
    const across = (renderOptions.scaleAcross ?? scale) / (1 + stretch * 0.15);
    const scaleX = horizontal ? along : across;
    const scaleY = horizontal ? across : along;
    let x = rect.left - (rect.width * (scaleX - 1)) / 2;
    let y = rect.top - (rect.height * (scaleY - 1)) / 2;
    const bounds = renderOptions.bounds;
    if (bounds) {
      const size = horizontal ? rect.width * scaleX : rect.height * scaleY;
      const start = Math.min(Math.max(horizontal ? x : y, bounds.min), Math.max(bounds.min, bounds.max - size));
      if (horizontal) x = start; else y = start;
    }

    highlightEl.style.width = `${rect.width}px`;
    highlightEl.style.height = `${rect.height}px`;
    highlightEl.style.transform =
      scaleX === 1 && scaleY === 1
        ? `translate3d(${x}px, ${y}px, 0)`
        : `translate3d(${x}px, ${y}px, 0) scale(${scaleX}, ${scaleY})`;
    return { rect, x, y, scaleX, scaleY };
  }

  function renderRect(rect: Rect, accentIndex = 0, renderOptions: PillRenderOptions = {}) {
    const pose = place(rect, renderOptions);
    paintAccent(accentIndex);
    return pose;
  }

  function centers(): number[] {
    return centerList;
  }

  function centerAt(fraction: number): number {
    if (centerList.length === 0) return 0;
    const clamped = Math.min(Math.max(fraction, 0), centerList.length - 1);
    const i0 = Math.floor(clamped);
    const i1 = Math.min(i0 + 1, centerList.length - 1);
    return lerp(centerList[i0], centerList[i1], clamped - i0);
  }

  function fractionAt(position: number): number {
    const cs = centerList;
    if (cs.length === 0) return 0;
    if (position <= cs[0]) return 0;
    if (position >= cs[cs.length - 1]) return cs.length - 1;

    for (let i = 0; i < cs.length - 1; i++) {
      if (position <= cs[i + 1]) {
        const span = cs[i + 1] - cs[i] || 1;
        return i + (position - cs[i]) / span;
      }
    }
    return cs.length - 1;
  }

  function rectAt(index: number): Rect | null {
    if (index < 0 || index >= rects.length) return null;
    return { ...rects[index] };
  }

  /** The pill's rect at a fractional index; past either end (a drag
   *  rubber-banding) it carries on along the axis by the end step. */
  function rectAtFraction(fraction: number): Rect {
    const clamped = Math.min(Math.max(fraction, 0), rects.length - 1);
    const i0 = Math.floor(clamped);
    const i1 = Math.min(i0 + 1, rects.length - 1);
    const rect = lerpRect(rects[i0], rects[i1], clamped - i0);
    const over = fraction - clamped;
    if (over && rects.length > 1) {
      const [a, b] = over < 0 ? [rects[0], rects[1]] : [rects[rects.length - 2], rects[rects.length - 1]];
      if (horizontal) rect.left += over * (b.left - a.left);
      else rect.top += over * (b.top - a.top);
    }
    return rect;
  }

  function renderSpan(from: number, to: number, renderOptions: PillRenderOptions = {}) {
    if (rects.length === 0) return null;
    const a = rectAtFraction(from), b = rectAtFraction(to);
    // Rows that wrap (Rankings' range chips) cannot stretch across a line
    // break: the pill keeps the shape of whichever end it is nearer.
    if (Math.abs(a.top - b.top) > 2 && horizontal) return render((from + to) / 2, renderOptions);
    const left = Math.min(a.left, b.left), top = Math.min(a.top, b.top);
    const right = Math.max(a.left + a.width, b.left + b.width), bottom = Math.max(a.top + a.height, b.top + b.height);
    const centre = (from + to) / 2;
    appliedFraction = Math.min(Math.max(centre, 0), rects.length - 1);
    const pose = place({ left, top, width: right - left, height: bottom - top }, renderOptions);
    paintAccent(Math.floor(appliedFraction), appliedFraction - Math.floor(appliedFraction));
    return pose;
  }

  function render(fraction: number, renderOptions: PillRenderOptions = {}) {
    if (rects.length === 0) return null;

    const clamped = Math.min(Math.max(fraction, 0), rects.length - 1);
    appliedFraction = clamped;
    const i0 = Math.floor(clamped);
    const i1 = Math.min(i0 + 1, rects.length - 1);
    const t = clamped - i0;
    const pose = place(rectAtFraction(fraction), renderOptions);

    const from = accents[i0];
    const to = accents[i1];
    if (from?.rgba && to?.rgba) {
      lerpColorInto(from.rgba, to.rgba, t, mixScratch);
      highlightEl.style.setProperty('--hl-color', colorToCss(mixScratch));
      highlightEl.style.setProperty('--hl-glow', withAlpha(mixScratch, 0.4));
    } else {
      const nearest = t < 0.5 ? from : to;
      if (nearest) {
        highlightEl.style.setProperty('--hl-color', nearest.color);
        highlightEl.style.setProperty('--hl-glow', nearest.glow);
      }
    }
    return pose;
  }

  return {
    measure,
    count: () => rects.length,
    centers,
    centerAt,
    fractionAt,
    rectAt,
    render,
    renderSpan,
    renderRect,
    applied: () => appliedFraction,
  };
}

export interface SlidingHighlightOptions {
  highlightEl: HTMLElement;
  buttons: NodeListOf<Element> | Element[];
  accentFor?: (btn: HTMLElement) => PillAccent | null;
  onSync?: (btn: HTMLElement) => void;
  draggable?: boolean;
}

// A lifted segment overflows its track as iOS 26's does (measured from the
// Health app: ~1.42x the pill along the track, ~1.5x across it).
const LIFT_ALONG = 1.42;
const LIFT_ACROSS = 1.5;
/** The lens starts settling back into the pill this close to its segment. */
const DEFLATE_WITHIN = 0.12;
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
/** Most a drag can pull the lens past the first or last segment. */
const RUBBER_LIMIT = 0.35;
/** 0..1: how strongly a dragged lens dwells on segment centres. */
const MAGNET = 0.5;

/** One spring-driven pill for tap, keyboard, hold and drag, as iOS 26 moves
 * a segmented control: a tap sends the pill across as glass at its own height
 * (stretching, bending what is under its edges, its fill clearing mid-hop);
 * a press held ~150ms or a drag lifts it into a lens. It snaps to the chosen
 * segment with a small overshoot and settles back into the pill on arrival.
 * Selection callbacks run on release; dragging only paints the control. */
export function createSlidingHighlight(options: SlidingHighlightOptions): {
  sync: (btn: HTMLElement, animate?: boolean) => void;
  scrub: (fraction: number) => void;
  observe: () => ResizeObserver;
  destroy: () => void;
} {
  const { highlightEl, onSync } = options;
  const buttons = [...options.buttons] as HTMLElement[];
  const group = highlightEl.parentElement!;
  const track = createPillTrack({ highlightEl, buttons, accentFor: options.accentFor });
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let currentIndex = Math.max(0, buttons.findIndex(btn => btn.matches('.active, .is-active')));
  // Leading and trailing edges: the trail chases the lead, so a hop
  // stretches the pill across both segments before it gathers in.
  const pos = createSpringValue(currentIndex, SPRING_SNAP, 0.002);
  const trail = createSpringValue(currentIndex, SPRING_TRAIL, 0.002);
  const glass = createSpringValue(0, SPRING_PRESS, 0.002);
  const lift = createSpringValue(0, SPRING_PRESS, 0.002);
  let raf = 0, resizeRaf = 0, paintedFace = '';
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let pointer: number | null = null, pressed = false, dragging = false;
  let startX = 0, startY = 0, originX = 0, originY = 0, grabX = 0;
  let lastX = Number.NaN, lastTime = 0, speed = 0;
  let suppressUntil = 0;
  // Rankings' range chips wrap onto two rows, where a path through the
  // intermediate indices sweeps over chips the finger never touched (to the
  // row's end, down to the next row's start, then out to the target). There a
  // hop glides straight from where the pill is to the chosen chip, still on
  // the lead spring: `start`..`end` is the stretch of pos.value it covers.
  let glide: { from: Rect; to: Rect; start: number; end: number } | null = null;
  let lastRect: Rect | null = null;

  // Labels take their colour from how much of the pill covers them, so text
  // and pill arrive together; while the lens is lifted the selected look
  // shows only through the glass, as on iOS.
  const labelColors = readLabelColors();
  const labelScratch: Rgba = { r: 0, g: 0, b: 0, a: 0 };
  const paintedLabels = buttons.map(() => '');
  function readLabelColors(): { idle: Rgba; active: Rgba } | null {
    const on = buttons.find(btn => btn.matches('.active, .is-active'));
    const off = buttons.find(btn => btn !== on);
    const active = on && parseColor(getComputedStyle(on).color);
    const idle = off && parseColor(getComputedStyle(off).color);
    return active && idle ? { active, idle } : null;
  }
  const lens = createLiquidLens({
    host: highlightEl, buttons, rectAt: track.rectAt, profile: SEGMENT_LENS,
    copyColor: labelColors ? () => colorToCss(labelColors.active) : undefined,
  });
  function paintLabels(rect: Rect, strength: number) {
    if (!labelColors) return;
    group.classList.add('segmented-animating');
    for (let i = 0; i < buttons.length; i++) {
      const r = track.rectAt(i);
      if (!r?.width || !r.height) continue;
      const ox = Math.min(rect.left + rect.width, r.left + r.width) - Math.max(rect.left, r.left);
      const oy = Math.min(rect.top + rect.height, r.top + r.height) - Math.max(rect.top, r.top);
      const cover = ox > 0 && oy > 0 ? Math.min(1, (ox * oy) / (r.width * r.height)) * (1 - strength) : 0;
      const css = colorToCss(lerpColorInto(labelColors.idle, labelColors.active, Math.round(cover * 24) / 24, labelScratch));
      if (css === paintedLabels[i]) continue;
      paintedLabels[i] = css;
      buttons[i].style.color = css;
    }
  }
  function clearLabels() {
    group.classList.remove('segmented-animating');
    buttons.forEach((btn, i) => {
      if (!paintedLabels[i]) return;
      paintedLabels[i] = '';
      btn.style.removeProperty('color');
    });
  }

  group.classList.add('segmented-control');

  function render() {
    const l = Math.max(lift.value, -0.08);
    const lifted = Math.min(Math.max(l, 0), 1);
    const strength = Math.min(Math.max(Math.max(glass.value, lifted), 0), 1);
    // A dragged lens stretches with its speed; a hop stretches by its edges.
    const speedStretch = lens.stretchFor(track.centerAt((pos.value + trail.value) / 2));
    const renderOptions = {
      scale: 1 + (LIFT_ALONG - 1) * l,
      scaleAcross: 1 + (LIFT_ACROSS - 1) * l,
      stretch: dragging ? speedStretch * strength : 0,
    };
    const pose = glide
      ? track.renderRect(glideSpan(glide), Math.round(pos.target), renderOptions)
      : track.renderSpan(trail.value, pos.value, renderOptions);
    if (!pose) return;
    lastRect = pose.rect;
    const travelling = Math.min(Math.max(glass.value, 0), 1);
    lens.paint(pose, Math.max(lifted, travelling * TAP_REFRACTION), lifted);
    paintLabels(pose.rect, strength);
    const face = (1 - Math.max(lifted, Math.min(Math.max(glass.value, 0), 1) * GLASS_CLEAR)).toFixed(2);
    if (face !== paintedFace) {
      paintedFace = face;
      if (face === '1.00') highlightEl.style.removeProperty('--face');
      else highlightEl.style.setProperty('--face', face);
    }
  }
  /** Both edges along the straight path; they only stretch the pill while
   *  on one row, since a pill cannot span a line break. */
  function glideSpan({ from, to, start, end }: NonNullable<typeof glide>): Rect {
    const at = (value: number) => lerpRect(from, to, end === start ? 1 : (value - start) / (end - start));
    const lead = at(pos.value), back = at(trail.value);
    if (Math.abs(lead.top - back.top) > 2) return lead;
    const left = Math.min(lead.left, back.left);
    return { left, top: lead.top, width: Math.max(lead.left + lead.width, back.left + back.width) - left, height: lead.height };
  }
  function finish() {
    raf = 0;
    lastTick = 0;
    glide = null;
    trail.jump(pos.value);
    group.classList.remove('segmented-lens', 'segmented-dragging');
    lens.clear();
    lastRect = track.render(currentIndex)?.rect ?? lastRect;
    clearLabels();
  }
  let lastTick = 0;
  function tick(now: number) {
    const prev = lastTick && now - lastTick < 100 ? lastTick : now - 1000 / 60;
    lastTick = now;
    // The trailing edge is pulled after the leading one.
    const leadMoving = pos.step(now);
    if (dragging) trail.jump(pos.value);
    else if (Math.abs(trail.target - pos.value) > 1e-4 || leadMoving) trail.to(pos.value, { params: SPRING_TRAIL, at: prev });
    // Glass and lens settle back into the pill as it gathers in on arrival:
    // the front has landed and the back is close.
    if (!pressed && Math.abs(pos.value - pos.target) < DEFLATE_WITHIN && Math.abs(trail.value - pos.target) < GATHERED) {
      if (lift.target > 0) lift.to(0, { params: SPRING_RELEASE });
      if (glass.target > 0) glass.to(0, { params: SPRING_FILL });
    }
    const moving = [leadMoving, trail.step(now), glass.step(now), lift.step(now)].some(Boolean);
    render();
    if (moving || pressed) raf = requestAnimationFrame(tick);
    else finish();
  }
  function run() {
    group.classList.add('segmented-lens');
    if (!raf) raf = requestAnimationFrame(tick);
  }

  function sync(btn: HTMLElement, animate = true) {
    const index = buttons.indexOf(btn);
    if (index < 0) return;
    track.measure();
    currentIndex = index;
    buttons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === index)));
    onSync?.(btn);
    const to = track.rectAt(index);
    if (!to?.width || !to.height || !animate || reduced.matches) {
      cancelAnimationFrame(raf);
      glide = null;
      pos.jump(index); trail.jump(index); glass.jump(0); lift.jump(0);
      if (to?.width && to.height) render();
      finish();
      return;
    }
    // Continues from the pill's current speed (a retarget mid-glide or a
    // released drag) rather than restarting from a standstill.
    // Any glide crosses as glass; a lifted lens just carries on as one.
    if (Math.abs(index - pos.value) > DEFLATE_WITHIN) glass.to(1, { params: SPRING_PRESS });
    glide = wraps() && lastRect && Math.abs(index - pos.value) > 1e-3
      ? { from: { ...lastRect }, to, start: pos.value, end: index }
      : null;
    pos.to(index, { velocity: dragging ? speed : undefined, params: SPRING_LEAD });
    run();
  }
  /** Whether the buttons sit on more than one row (measured). */
  function wraps(): boolean {
    const first = track.rectAt(0);
    return !!first && buttons.some((_, i) => Math.abs((track.rectAt(i)?.top ?? first.top) - first.top) > 2);
  }
  /** Places the pill at a fractional segment index, at rest. */
  function scrub(value: number) {
    glide = null;
    if (!track.count()) track.measure();
    pos.jump(Math.max(0, Math.min(buttons.length - 1, value)));
    trail.jump(pos.value);
    render();
    if (!raf && !pressed) finish();
  }
  /** Fractional segment index at a point. With `overshoot`, a point past
   *  the first or last segment's centre runs on beyond the ends (a drag
   *  rubber-banding), measured in the same steps as between segments. */
  function fractionAtPoint(x: number, y: number, overshoot = false): number {
    const rects = buttons.map((_, i) => track.rectAt(i)!);
    const nearestRow = rects.reduce((best, rect) => Math.abs(rect.top + rect.height / 2 - y) < Math.abs(best.top + best.height / 2 - y) ? rect : best);
    const row = rects.map((rect, index) => ({ rect, index })).filter(({ rect }) => Math.abs(rect.top - nearestRow.top) < 2);
    const centre = (i: number) => row[i].rect.left + row[i].rect.width / 2;
    const step = row.length > 1 ? centre(1) - centre(0) || 1 : 1;
    if (x <= centre(0)) return row[0].index - (overshoot && row[0].index === 0 ? (centre(0) - x) / step : 0);
    for (let i = 1; i < row.length; i++) {
      const lo = centre(i - 1), hi = centre(i);
      if (x <= hi) return row[i - 1].index + (row[i].index - row[i - 1].index) * (x - lo) / (hi - lo);
    }
    const end = row[row.length - 1];
    const past = overshoot && end.index === buttons.length - 1 ? (x - centre(row.length - 1)) / step : 0;
    return end.index + past;
  }
  /** Dwells on segment centres and moves quickly between them; past the
   *  first or last segment it follows with growing resistance. */
  function magnetise(value: number): number {
    const last = buttons.length - 1;
    if (value < 0) return -(RUBBER_LIMIT * -value) / (-value + RUBBER_LIMIT * 2);
    if (value > last) return last + (RUBBER_LIMIT * (value - last)) / (value - last + RUBBER_LIMIT * 2);
    return value - (MAGNET / (2 * Math.PI)) * Math.sin(2 * Math.PI * value);
  }
  /** A held press or a drag lifts the pill into a lens where it is. */
  function liftLens() {
    clearTimeout(holdTimer);
    if (reduced.matches || lift.target > 0) return;
    lift.to(1, { params: SPRING_PRESS });
    run();
  }
  function onDown(event: PointerEvent) {
    if (event.button !== 0 || !event.isPrimary || pointer !== null) return;
    pointer = event.pointerId; startX = event.clientX; startY = event.clientY;
    pressed = true; dragging = false;
    track.measure();
    const rect = group.getBoundingClientRect();
    originX = rect.left + group.clientLeft; originY = rect.top + group.clientTop;
    // A tap never lifts; a press held past HOLD_MS becomes a lens.
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => { if (pressed) liftLens(); }, HOLD_MS);
  }
  function onMove(event: PointerEvent) {
    if (event.pointerId !== pointer) return;
    const dx = event.clientX - startX, dy = event.clientY - startY;
    if (!dragging) {
      // A vertical move is the page scrolling: let go and settle.
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx) * 1.2) { clearTimeout(holdTimer); pointer = null; pressed = false; sync(buttons[currentIndex]); return; }
      if (Math.abs(dx) < 8) return;
      dragging = true;
      liftLens();
      lastX = Number.NaN; speed = 0;
      group.classList.add('segmented-dragging');
      if (pointer !== null) group.setPointerCapture(pointer);
      grabX = track.centerAt(pos.value) - (startX - originX);
    }
    if (event.cancelable) event.preventDefault();
    const decay = Math.max(0, 1 - Math.abs(dx) / 100);
    const raw = fractionAtPoint(event.clientX - originX + grabX * decay, event.clientY - originY, true);
    const now = performance.now();
    if (!Number.isNaN(lastX) && now > lastTime) speed = speed * 0.3 + ((raw - lastX) / (now - lastTime)) * 700;
    lastX = raw; lastTime = now;
    glide = null;
    pos.jump(magnetise(raw));
    trail.jump(pos.value);
  }
  function end(event: PointerEvent, cancelled = false) {
    if (event.pointerId !== pointer) return;
    const id = pointer; pointer = null;
    const wasDragging = dragging;
    clearTimeout(holdTimer);
    pressed = false;
    if (group.hasPointerCapture(id)) group.releasePointerCapture(id);
    group.classList.remove('segmented-dragging');
    const now = performance.now();
    suppressUntil = now + 500;
    // Speed only counts if the finger was still moving when it lifted; a
    // pause before release leaves the last move's speed behind.
    if (now - lastTime > 50) speed = 0;
    // A tap, quick or held, picks the segment under the finger; so does a
    // drag, wherever the lens is resting.
    const target = cancelled ? currentIndex
      : Math.max(0, Math.min(buttons.length - 1, Math.round(wasDragging ? pos.value : fractionAtPoint(startX - originX, startY - originY))));
    if (!cancelled) buttons[target].click();
    // A selected button's handler may deliberately be a no-op.
    if (currentIndex !== target || pos.target !== target || lift.target !== 0) sync(buttons[target]);
    dragging = false;
  }
  function onCancel(event: PointerEvent) { end(event, true); }
  function onClick(event: MouseEvent) {
    if (event.isTrusted && event.detail > 0 && performance.now() < suppressUntil) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }
  function onKey(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, currentIndex + (event.key === 'ArrowRight' ? 1 : -1)));
    buttons[index].focus(); buttons[index].click();
  }
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => { if (!raf && !pressed) sync(buttons[currentIndex], false); });
  });
  if (options.draggable !== false) {
    group.addEventListener('pointerdown', onDown);
    group.addEventListener('pointermove', onMove);
    group.addEventListener('pointerup', end);
    group.addEventListener('pointercancel', onCancel);
    group.addEventListener('click', onClick, true);
    group.addEventListener('keydown', onKey);
  }
  return {
    sync, scrub,
    observe: () => { buttons.forEach(btn => ro.observe(btn)); return ro; },
    destroy: () => {
      clearTimeout(holdTimer); cancelAnimationFrame(raf); cancelAnimationFrame(resizeRaf); ro.disconnect(); finish();
      group.removeEventListener('pointerdown', onDown); group.removeEventListener('pointermove', onMove);
      group.removeEventListener('pointerup', end); group.removeEventListener('pointercancel', onCancel);
      group.removeEventListener('click', onClick, true); group.removeEventListener('keydown', onKey);
    },
  };
}
