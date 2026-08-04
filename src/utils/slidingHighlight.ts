import {
  colorToCss,
  createCssPaintCache,
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
  /** Renders the pill at a fractional index. Interpolates geometry and colour. */
  render: (fraction: number, options?: PillRenderOptions) => void;
  /** Fractional index currently on screen. */
  applied: () => number;
}

const MIN_WRITE_DELTA = 0.5;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Renders a pill highlight at any fractional position between buttons.
 *
 * Everything is written as a single `transform` (plus size, only when it
 * actually changes), so callers can drive it from a rAF loop at display
 * refresh rate without touching layout.
 */
export function createPillTrack(options: PillTrackOptions): PillTrack {
  const { highlightEl, buttons, accentFor } = options;
  const paint = createCssPaintCache();
  const mixScratch: Rgba = { r: 0, g: 0, b: 0, a: 0 };

  let rects: Rect[] = [];
  let accents: ResolvedAccent[] = [];
  let centerList: number[] = [];
  let horizontal = true;
  let lastWidth = -1;
  let lastHeight = -1;
  let lastHlColor = '';
  let lastHlGlow = '';
  let lastTransform = '';
  let appliedFraction = 0;
  let measuredOnce = false;

  function measure() {
    if (!measuredOnce) {
      // Position is written every frame from JS; a CSS transition on the same
      // properties would lag behind and make the pill appear to trail.
      highlightEl.style.transition = 'none';
      measuredOnce = true;
    }

    rects = buttons.map((btn) => ({
      left: btn.offsetLeft,
      top: btn.offsetTop,
      width: btn.offsetWidth,
      height: btn.offsetHeight,
    }));

    // Accents are stable for the lifetime of the track; only re-resolve when
    // the callback can return new values (caller can re-measure after theme).
    accents = buttons.map((btn) => {
      const accent = accentFor?.(btn) ?? null;
      return {
        rgba: accent ? parseColor(accent.color) : null,
        color: accent?.color ?? 'rgba(255, 255, 255, 0.25)',
        glow: accent?.glow ?? 'rgba(0, 0, 0, 0.45)',
      };
    });

    // The nav is a row on mobile and a column on desktop.
    horizontal = rects.length < 2 || rects[1].left !== rects[0].left;
    centerList = rects.map((r) => (horizontal ? r.left + r.width / 2 : r.top + r.height / 2));
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

  function render(fraction: number, renderOptions: PillRenderOptions = {}) {
    if (rects.length === 0) return;

    const scale = renderOptions.scale ?? 1;
    const clamped = Math.min(Math.max(fraction, 0), rects.length - 1);
    appliedFraction = clamped;
    const i0 = Math.floor(clamped);
    const i1 = Math.min(i0 + 1, rects.length - 1);
    const t = clamped - i0;

    const a = rects[i0];
    const b = rects[i1];
    const width = lerp(a.width, b.width, t);
    const height = lerp(a.height, b.height, t);
    const left = lerp(a.left, b.left, t);
    const top = lerp(a.top, b.top, t);

    if (Math.abs(width - lastWidth) > MIN_WRITE_DELTA) {
      lastWidth = width;
      highlightEl.style.width = `${width}px`;
    }
    if (Math.abs(height - lastHeight) > MIN_WRITE_DELTA) {
      lastHeight = height;
      highlightEl.style.height = `${height}px`;
    }

    // transform-origin is 0 0, so grow around the centre manually.
    const x = left - (width * (scale - 1)) / 2;
    const y = top - (height * (scale - 1)) / 2;
    const transform = paint.translate3d(x, y, scale);
    if (transform !== lastTransform) {
      lastTransform = transform;
      highlightEl.style.transform = transform;
    }

    const from = accents[i0];
    const to = accents[i1];
    if (from?.rgba && to?.rgba) {
      lerpColorInto(from.rgba, to.rgba, t, mixScratch);
      const color = colorToCss(mixScratch);
      if (color !== lastHlColor) {
        lastHlColor = color;
        highlightEl.style.setProperty('--hl-color', color);
      }
      const glow = withAlpha(mixScratch, 0.4);
      if (glow !== lastHlGlow) {
        lastHlGlow = glow;
        highlightEl.style.setProperty('--hl-glow', glow);
      }
    } else {
      const nearest = t < 0.5 ? from : to;
      if (nearest) {
        if (nearest.color !== lastHlColor) {
          lastHlColor = nearest.color;
          highlightEl.style.setProperty('--hl-color', nearest.color);
        }
        if (nearest.glow !== lastHlGlow) {
          lastHlGlow = nearest.glow;
          highlightEl.style.setProperty('--hl-glow', nearest.glow);
        }
      }
    }
  }

  return {
    measure,
    count: () => rects.length,
    centers,
    centerAt,
    fractionAt,
    render,
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
 * Tap-driven pill that glides to the selected button. The glide is rAF-driven
 * so position and colour always land together.
 */
export function createSlidingHighlight(options: SlidingHighlightOptions): {
  sync: (btn: HTMLElement, animate?: boolean) => void;
  observe: () => ResizeObserver;
} {
  const { highlightEl, onSync, durationMs = 340 } = options;
  const buttons = [...options.buttons] as HTMLElement[];

  const track = createPillTrack({
    highlightEl,
    buttons,
    accentFor: options.accentFor,
  });

  let cancel: (() => void) | null = null;
  let measured = false;
  let resizeRaf: number | null = null;

  function sync(btn: HTMLElement, animate = true) {
    const index = buttons.indexOf(btn);
    if (index === -1) return;

    if (!measured) {
      track.measure();
      measured = true;
    }

    cancel?.();
    cancel = null;

    // Always start from what is actually on screen, so an interrupted or
    // re-entrant sync continues from the pill's current spot.
    const from = track.applied();
    if (!animate || from === index) {
      track.render(index);
    } else {
      cancel = rafTween(
        from,
        index,
        durationMs,
        (value) => track.render(value),
        () => {
          cancel = null;
        },
      );
    }

    onSync?.(btn);
  }

  const ro = new ResizeObserver(() => {
    // Coalesce layout storms (font load, orientation) into one measure/paint.
    if (resizeRaf !== null) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = null;
      track.measure();
      measured = true;
      if (!cancel) track.render(track.applied());
    });
  });

  return {
    sync,
    observe: () => {
      buttons.forEach((btn) => ro.observe(btn));
      return ro;
    },
  };
}
