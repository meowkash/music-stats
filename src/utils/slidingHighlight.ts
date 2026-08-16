import {
  colorToCss,
  lerpColorInto,
  parseColor,
  rafTween,
  withAlpha,
  type Rgba,
} from './motion';

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
  render: (fraction: number, options?: PillRenderOptions) => void;
  /** Renders the pill at an explicit rect (used for direct A→B glides). */
  renderRect: (rect: Rect, accentIndex?: number, options?: PillRenderOptions) => void;
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

/**
 * Renders a pill highlight at any fractional position between buttons.
 *
 * Geometry is written every call (no style-write cache) so a re-measure can
 * never leave the DOM stuck at translate(0,0) while JS thinks it has moved.
 */
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

  function renderRect(rect: Rect, accentIndex = 0, renderOptions: PillRenderOptions = {}) {
    const scale = renderOptions.scale ?? 1;
    const width = rect.width;
    const height = rect.height;
    const x = rect.left - (width * (scale - 1)) / 2;
    const y = rect.top - (height * (scale - 1)) / 2;

    highlightEl.style.width = `${width}px`;
    highlightEl.style.height = `${height}px`;
    highlightEl.style.transform =
      scale === 1
        ? `translate3d(${x}px, ${y}px, 0)`
        : `translate3d(${x}px, ${y}px, 0) scale(${scale})`;

    paintAccent(accentIndex);
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
    if (rects.length === 0) return;

    const scale = renderOptions.scale ?? 1;
    const clamped = Math.min(Math.max(fraction, 0), rects.length - 1);
    appliedFraction = clamped;
    const i0 = Math.floor(clamped);
    const i1 = Math.min(i0 + 1, rects.length - 1);
    const t = clamped - i0;
    const rect = lerpRect(rects[i0], rects[i1], t);

    const width = rect.width;
    const height = rect.height;
    const x = rect.left - (width * (scale - 1)) / 2;
    const y = rect.top - (height * (scale - 1)) / 2;

    highlightEl.style.width = `${width}px`;
    highlightEl.style.height = `${height}px`;
    highlightEl.style.transform =
      scale === 1
        ? `translate3d(${x}px, ${y}px, 0)`
        : `translate3d(${x}px, ${y}px, 0) scale(${scale})`;

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
}

/**
 * Tap-driven pill that glides directly from its current painted rect to the
 * tapped button's rect. Avoids index-space tweens (which restart at 0 when
 * state is stale) and looks correct across flex-wrapped rows.
 */
export function createSlidingHighlight(options: SlidingHighlightOptions): {
  sync: (btn: HTMLElement, animate?: boolean) => void;
  /** Paint the pill at a fractional index (e.g. while a pager is dragging). */
  scrub: (fraction: number) => void;
  observe: () => ResizeObserver;
} {
  const { highlightEl, onSync, durationMs = 300 } = options;
  const buttons = [...options.buttons] as HTMLElement[];

  const track = createPillTrack({
    highlightEl,
    buttons,
    accentFor: options.accentFor,
  });

  let cancel: (() => void) | null = null;
  let resizeRaf: number | null = null;
  let currentIndex = Math.max(
    0,
    buttons.findIndex((btn) => btn.classList.contains('active')),
  );
  /** Last rect actually painted — source of truth for the next glide's start. */
  let paintedRect: Rect | null = null;

  function paintTo(rect: Rect, accentIndex: number) {
    track.renderRect(rect, accentIndex);
    paintedRect = { ...rect };
  }

  function sync(btn: HTMLElement, animate = true) {
    const index = buttons.indexOf(btn);
    if (index === -1) return;

    cancel?.();
    cancel = null;

    track.measure();
    const toRect = track.rectAt(index);
    if (!toRect || toRect.width <= 0 || toRect.height <= 0) {
      // Layout not ready (hidden panel). Remember selection; place later.
      currentIndex = index;
      return;
    }

    const fromRect = paintedRect ?? track.rectAt(currentIndex) ?? toRect;

    if (!animate || (fromRect.left === toRect.left && fromRect.top === toRect.top && fromRect.width === toRect.width)) {
      currentIndex = index;
      paintTo(toRect, index);
      onSync?.(btn);
      return;
    }

    // Selection updates immediately; the glide catches up visually.
    currentIndex = index;
    paintTo(fromRect, index);

    cancel = rafTween(
      0,
      1,
      durationMs,
      (t) => {
        paintTo(lerpRect(fromRect, toRect, t), index);
      },
      () => {
        cancel = null;
        paintTo(toRect, index);
      },
    );

    onSync?.(btn);
  }

  const ro = new ResizeObserver(() => {
    if (resizeRaf !== null) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = null;
      if (cancel) return;
      track.measure();
      const rect = track.rectAt(currentIndex);
      if (rect && rect.width > 0) paintTo(rect, currentIndex);
    });
  });

  function scrub(fraction: number) {
    cancel?.();
    cancel = null;
    // Measure only when empty — per-frame measure during a pager drag is waste.
    if (track.count() === 0) track.measure();
    if (track.count() === 0) return;

    const clamped = Math.min(Math.max(fraction, 0), buttons.length - 1);
    track.render(clamped);

    // Remember the interpolated rect so the next discrete sync starts here.
    const i0 = Math.floor(clamped);
    const i1 = Math.min(i0 + 1, buttons.length - 1);
    const t = clamped - i0;
    const a = track.rectAt(i0);
    const b = track.rectAt(i1);
    if (a && b) paintedRect = lerpRect(a, b, t);

    currentIndex = Math.round(clamped);
    // Intentionally no onSync here — callers that scrub (pagers) own accent /
    // label colour so it can stay locked to the same fraction as the pill.
  }

  return {
    sync,
    scrub,
    observe: () => {
      buttons.forEach((btn) => ro.observe(btn));
      return ro;
    },
  };
}
