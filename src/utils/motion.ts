export type Easing = (t: number) => number;

/**
 * Single source of truth for the app's motion feel. Mirrors the CSS
 * `--ios-spring` curve so JS-driven and CSS-driven animations match exactly.
 */
export const IOS_SPRING_POINTS = [0.16, 1, 0.3, 1] as const;

function bezierAxis(t: number, p1: number, p2: number): number {
  const inv = 1 - t;
  return 3 * inv * inv * t * p1 + 3 * inv * t * t * p2 + t * t * t;
}

/** Evaluates a CSS cubic-bezier timing function at progress `t`. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): Easing {
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;

    // Solve x(u) = t for u, then evaluate y(u).
    let lo = 0;
    let hi = 1;
    let u = t;
    for (let i = 0; i < 20; i++) {
      const x = bezierAxis(u, x1, x2);
      if (Math.abs(x - t) < 1e-4) break;
      if (x < t) lo = u;
      else hi = u;
      u = (lo + hi) / 2;
    }
    return bezierAxis(u, y1, y2);
  };
}

/** Precomputed iOS-spring samples — avoids solving the cubic every rAF tick. */
const EASE_LUT_SIZE = 128;
const EASE_LUT = (() => {
  const solve = cubicBezier(...IOS_SPRING_POINTS);
  const table = new Float64Array(EASE_LUT_SIZE + 1);
  for (let i = 0; i <= EASE_LUT_SIZE; i++) {
    table[i] = solve(i / EASE_LUT_SIZE);
  }
  return table;
})();

export const easeIos: Easing = (t: number) => {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const scaled = t * EASE_LUT_SIZE;
  const i = scaled | 0;
  const frac = scaled - i;
  return EASE_LUT[i] + (EASE_LUT[i + 1] - EASE_LUT[i]) * frac;
};

export function rafTween(
  from: number,
  to: number,
  durationMs: number,
  onUpdate: (value: number) => void,
  onComplete?: () => void,
  easing: Easing = easeIos,
): () => void {
  if (durationMs <= 0 || from === to) {
    onUpdate(to);
    onComplete?.();
    return () => {};
  }

  const start = performance.now();
  let cancelled = false;
  let rafId = 0;

  const tick = (now: number) => {
    if (cancelled) return;
    const t = Math.min((now - start) / durationMs, 1);
    onUpdate(from + (to - from) * easing(t));
    if (t < 1) {
      rafId = requestAnimationFrame(tick);
    } else {
      onComplete?.();
    }
  };

  rafId = requestAnimationFrame(tick);

  return () => {
    cancelled = true;
    cancelAnimationFrame(rafId);
  };
}

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function parseColor(value: string): Rgba | null {
  const hex = value.trim();

  if (hex.startsWith('#')) {
    const body = hex.slice(1);
    const full =
      body.length === 3
        ? body
            .split('')
            .map((c) => c + c)
            .join('')
        : body;
    if (full.length < 6) return null;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
      a: full.length >= 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1,
    };
  }

  const match = hex.match(/rgba?\(([^)]+)\)/);
  if (!match) return null;
  const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.some(Number.isNaN)) return null;
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
}

/** Mutates `out` — no allocation in the hot path. */
export function lerpColorInto(from: Rgba, to: Rgba, t: number, out: Rgba): Rgba {
  out.r = from.r + (to.r - from.r) * t;
  out.g = from.g + (to.g - from.g) * t;
  out.b = from.b + (to.b - from.b) * t;
  out.a = from.a + (to.a - from.a) * t;
  return out;
}

export function lerpColor(from: Rgba, to: Rgba, t: number): Rgba {
  return lerpColorInto(from, to, t, { r: 0, g: 0, b: 0, a: 0 });
}

/** Formats without `toFixed` allocations; alpha quantised to 1/1000. */
export function colorToCss({ r, g, b, a }: Rgba): string {
  const ai = (a * 1000 + 0.5) | 0;
  return `rgba(${(r + 0.5) | 0}, ${(g + 0.5) | 0}, ${(b + 0.5) | 0}, ${ai / 1000})`;
}

export function withAlpha(color: Rgba, alpha: number): string {
  const ai = (alpha * 1000 + 0.5) | 0;
  return `rgba(${(color.r + 0.5) | 0}, ${(color.g + 0.5) | 0}, ${(color.b + 0.5) | 0}, ${ai / 1000})`;
}

/**
 * Reusable string builders for the gesture hot path. Callers that paint every
 * frame should keep one of these and avoid allocating on quiet ticks.
 */
export function createCssPaintCache() {
  const scratch: Rgba = { r: 0, g: 0, b: 0, a: 0 };
  let lastColorKey = '';
  let lastColorCss = '';
  let lastTx = Number.NaN;
  let lastTy = Number.NaN;
  let lastScale = Number.NaN;
  let lastTransform = '';

  function color(from: Rgba, to: Rgba, t: number): string {
    lerpColorInto(from, to, t, scratch);
    // Quantise to 1/4 channel so near-identical frames reuse the string.
    const key = `${(scratch.r * 4 + 0.5) | 0},${(scratch.g * 4 + 0.5) | 0},${(scratch.b * 4 + 0.5) | 0},${(scratch.a * 40 + 0.5) | 0}`;
    if (key === lastColorKey) return lastColorCss;
    lastColorKey = key;
    lastColorCss = colorToCss(scratch);
    return lastColorCss;
  }

  function translate3d(x: number, y: number, scale = 1): string {
    // Sub-pixel noise below ~0.1px is invisible and just dirties the layer.
    const rx = Math.round(x * 10) / 10;
    const ry = Math.round(y * 10) / 10;
    const rs = Math.round(scale * 1000) / 1000;
    if (rx === lastTx && ry === lastTy && rs === lastScale) return lastTransform;
    lastTx = rx;
    lastTy = ry;
    lastScale = rs;
    lastTransform =
      rs === 1
        ? `translate3d(${rx}px, ${ry}px, 0)`
        : `translate3d(${rx}px, ${ry}px, 0) scale(${rs})`;
    return lastTransform;
  }

  function reset() {
    lastColorKey = '';
    lastColorCss = '';
    lastTx = Number.NaN;
    lastTy = Number.NaN;
    lastScale = Number.NaN;
    lastTransform = '';
  }

  return { scratch, color, translate3d, reset };
}
