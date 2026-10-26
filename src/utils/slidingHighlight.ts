import {
  colorToCss,
  rafTween,
  lerpColorInto,
  parseColor,
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
  /** Uniform scale around the pill centre — used for the drag "grab" effect. */
  scale?: number;
  /** Jelly deformation: grows the main axis by this fraction and thins the
   *  cross axis to suit, as a fast-moving lens does. */
  stretch?: number;
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
    const across = scale / (1 + stretch * 0.6);
    const scaleX = horizontal ? along : across;
    const scaleY = horizontal ? across : along;
    const x = rect.left - (rect.width * (scaleX - 1)) / 2;
    const y = rect.top - (rect.height * (scaleY - 1)) / 2;

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

  function render(fraction: number, renderOptions: PillRenderOptions = {}) {
    if (rects.length === 0) return null;

    const clamped = Math.min(Math.max(fraction, 0), rects.length - 1);
    appliedFraction = clamped;
    const i0 = Math.floor(clamped);
    const i1 = Math.min(i0 + 1, rects.length - 1);
    const t = clamped - i0;
    const pose = place(lerpRect(rects[i0], rects[i1], t), renderOptions);

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
    renderRect,
    applied: () => appliedFraction,
  };
}

export interface SlidingHighlightOptions {
  highlightEl: HTMLElement;
  buttons: NodeListOf<Element> | Element[];
  accentFor?: (btn: HTMLElement) => PillAccent | null;
  onSync?: (btn: HTMLElement) => void;
  durationMs?: number;
  draggable?: boolean;
}

/** Scale a segmented pill lifts to while held. */
const LIFT_SCALE = 1.4;

/** One interruptible painted pose for tap, keyboard, hold and drag. Expensive
 * selection callbacks run on release; dragging only paints the small control. */
export function createSlidingHighlight(options: SlidingHighlightOptions): {
  sync: (btn: HTMLElement, animate?: boolean) => void;
  scrub: (fraction: number) => void;
  observe: () => ResizeObserver;
  destroy: () => void;
} {
  const { highlightEl, onSync, durationMs = 190 } = options;
  const buttons = [...options.buttons] as HTMLElement[];
  const group = highlightEl.parentElement!;
  const track = createPillTrack({ highlightEl, buttons, accentFor: options.accentFor });
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let currentIndex = Math.max(0, buttons.findIndex(btn => btn.matches('.active, .is-active')));
  let paintedRect: Rect | null = null, scale = 1;
  let cancel: (() => void) | null = null;
  let resizeRaf = 0, liftRaf = 0;
  let pointer: number | null = null, dragging = false;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let startX = 0, startY = 0, originX = 0, originY = 0, grabX = 0, fraction = currentIndex;
  let suppressUntil = 0;

  const lens = createLiquidLens({ host: highlightEl, buttons, rectAt: track.rectAt, profile: SEGMENT_LENS });

  group.classList.add('segmented-control');
  /** Lens strength follows the lift, so the optics ease in and out with it. */
  function lensStrength() { return Math.min(Math.max((scale - 1) / (LIFT_SCALE - 1), 0), 1); }
  function stretchAt(rect: Rect) {
    return lens.stretchFor(rect.left + rect.width / 2);
  }
  function paintTo(rect: Rect, index: number, nextScale = 1) {
    scale = nextScale;
    paintedRect = { ...rect };
    lens.paint(track.renderRect(rect, index, { scale, stretch: stretchAt(rect) }), lensStrength());
  }
  function stopLift() { cancelAnimationFrame(liftRaf); liftRaf = 0; }
  function finish() {
    group.classList.remove('segmented-lens', 'segmented-dragging');
    lens.clear();
  }
  function sync(btn: HTMLElement, animate = true) {
    const index = buttons.indexOf(btn);
    if (index < 0) return;
    cancel?.(); cancel = null;
    stopLift();
    track.measure();
    const to = track.rectAt(index);
    currentIndex = index;
    buttons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === index)));
    onSync?.(btn);
    if (!to?.width || !to.height) return;
    const from = paintedRect ?? to, fromScale = scale;
    if (!animate || reduced.matches) { paintTo(to, index); finish(); return; }
    cancel = rafTween(0, 1, durationMs, progress => {
      paintTo(lerpRect(from, to, progress), index, fromScale + (1 - fromScale) * progress);
    }, () => { cancel = null; finish(); });
  }
  function scrub(value: number) {
    cancel?.(); cancel = null;
    if (!track.count()) track.measure();
    fraction = Math.max(0, Math.min(buttons.length - 1, value));
    const lo = Math.floor(fraction), hi = Math.ceil(fraction);
    const a = track.rectAt(lo), b = track.rectAt(hi);
    if (!a || !b) return;
    paintedRect = lerpRect(a, b, fraction - lo);
    const pose = track.render(fraction, { scale, stretch: stretchAt(paintedRect) });
    if (pose) lens.paint(pose, lensStrength());
  }
  function fractionAtPoint(x: number, y: number): number {
    const rects = buttons.map((_, i) => track.rectAt(i)!);
    const nearestRow = rects.reduce((best, rect) => Math.abs(rect.top + rect.height / 2 - y) < Math.abs(best.top + best.height / 2 - y) ? rect : best);
    const row = rects.map((rect, index) => ({ rect, index })).filter(({ rect }) => Math.abs(rect.top - nearestRow.top) < 2);
    if (x <= row[0].rect.left + row[0].rect.width / 2) return row[0].index;
    for (let i = 1; i < row.length; i++) {
      const a = row[i - 1], b = row[i];
      const lo = a.rect.left + a.rect.width / 2, hi = b.rect.left + b.rect.width / 2;
      if (x <= hi) return a.index + (b.index - a.index) * (x - lo) / (hi - lo);
    }
    return row[row.length - 1].index;
  }
  function beginDrag() {
    if (pointer === null || dragging) return;
    clearTimeout(holdTimer);
    cancel?.(); cancel = null;
    track.measure();
    const rect = group.getBoundingClientRect();
    originX = rect.left + group.clientLeft; originY = rect.top + group.clientTop;
    const current = paintedRect ?? track.rectAt(currentIndex)!;
    grabX = current.left + current.width / 2 - (startX - originX);
    fraction = fractionAtPoint(current.left + current.width / 2, current.top + current.height / 2);
    dragging = true;
    group.classList.add('segmented-lens', 'segmented-dragging');
    group.setPointerCapture(pointer);
    const start = performance.now(), fromScale = scale;
    function lift(now: number) {
      const progress = Math.min(1, (now - start) / 150);
      scale = reduced.matches ? 1 : fromScale + (LIFT_SCALE - fromScale) * (1 - (1 - progress) ** 3);
      scrub(fraction);
      if (progress < 1 && dragging) liftRaf = requestAnimationFrame(lift);
    }
    liftRaf = requestAnimationFrame(lift);
  }
  function onDown(event: PointerEvent) {
    if (event.button !== 0 || !event.isPrimary || pointer !== null) return;
    pointer = event.pointerId; startX = event.clientX; startY = event.clientY;
    holdTimer = setTimeout(beginDrag, 140);
  }
  function onMove(event: PointerEvent) {
    if (event.pointerId !== pointer) return;
    const dx = event.clientX - startX, dy = event.clientY - startY;
    if (!dragging) {
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx) * 1.2) { clearTimeout(holdTimer); pointer = null; return; }
      if (Math.abs(dx) < 8) return;
      beginDrag();
    }
    if (event.cancelable) event.preventDefault();
    const decay = Math.max(0, 1 - Math.abs(dx) / 100);
    scrub(fractionAtPoint(event.clientX - originX + grabX * decay, event.clientY - originY));
  }
  function end(event: PointerEvent, cancelled = false) {
    if (event.pointerId !== pointer) return;
    clearTimeout(holdTimer);
    const id = pointer; pointer = null;
    if (!dragging) return;
    dragging = false; stopLift();
    if (group.hasPointerCapture(id)) group.releasePointerCapture(id);
    group.classList.remove('segmented-dragging');
    suppressUntil = performance.now() + 500;
    // A press held in place is a slow tap: it picks the segment under the
    // finger, not the one the lens lifted from.
    const held = Math.abs(event.clientX - startX) < 8 && Math.abs(event.clientY - startY) < 8;
    const target = cancelled ? currentIndex
      : Math.round(held ? fractionAtPoint(startX - originX, startY - originY) : fraction);
    if (!cancelled) buttons[target].click();
    // A selected button's handler may deliberately be a no-op.
    if (!cancel || currentIndex !== target) sync(buttons[target]);
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
    resizeRaf = requestAnimationFrame(() => { if (!cancel && !dragging) sync(buttons[currentIndex], false); });
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
      clearTimeout(holdTimer); cancel?.(); stopLift(); cancelAnimationFrame(resizeRaf); ro.disconnect(); finish();
      group.removeEventListener('pointerdown', onDown); group.removeEventListener('pointermove', onMove);
      group.removeEventListener('pointerup', end); group.removeEventListener('pointercancel', onCancel);
      group.removeEventListener('click', onClick, true); group.removeEventListener('keydown', onKey);
    },
  };
}
