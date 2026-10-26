export type Easing = (t: number) => number;

// The app's one motion: a near-critically damped spring. It leaves rest
// gently, so nothing lurches on its first frame (an ease-out covers a quarter
// of the distance there and reads as a jump), is visibly moving within two
// frames, and lands softly with no visible bounce (0.15% overshoot). JS springs,
// CSS transitions (--ios-spring) and WAAPI all share it: tune the feel here.
export const SMOOTH_RESPONSE = 0.46;
export const SMOOTH_DAMPING_RATIO = 0.9;
const OMEGA = (2 * Math.PI) / SMOOTH_RESPONSE;
const OMEGA_D = OMEGA * Math.sqrt(1 - SMOOTH_DAMPING_RATIO ** 2);
export const SPRING_SMOOTH = {
  stiffness: OMEGA ** 2,
  damping: 2 * SMOOTH_DAMPING_RATIO * OMEGA,
} as const;

/** Step response of SPRING_SMOOTH from rest, `seconds` after it starts. */
function smoothStep(seconds: number): number {
  const decay = Math.exp(-SMOOTH_DAMPING_RATIO * OMEGA * seconds);
  return 1 - decay * (Math.cos(OMEGA_D * seconds) + ((SMOOTH_DAMPING_RATIO * OMEGA) / OMEGA_D) * Math.sin(OMEGA_D * seconds));
}

/** How long the spring takes to settle within 0.2%: the CSS duration that
 *  reproduces it exactly (--duration-smooth). Derived, so tuning the spring
 *  above keeps CSS in step. */
export const SMOOTH_MS = (() => {
  let settledSince = 0;
  for (let ms = 0; ms < 3000; ms++) {
    if (Math.abs(1 - smoothStep(ms / 1000)) > 0.002) settledSince = ms + 1;
    else if (ms - settledSince > 300) break;
  }
  return settledSince;
})();

/** SPRING_SMOOTH as a 0..1 easing over SMOOTH_MS. */
export const easeSmooth: Easing = (t) => {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return smoothStep((t * SMOOTH_MS) / 1000) / smoothStep(SMOOTH_MS / 1000);
};

/** easeSmooth for CSS: sampled densely where it curves, sparsely in the tail. */
export const SMOOTH_EASE_LINEAR = `linear(${[0, 0.02, 0.05, 0.08, 0.12, 0.16, 0.2, 0.25, 0.3, 0.36, 0.43, 0.5, 0.6, 0.72, 0.86, 1]
  .map((t) => `${easeSmooth(t).toFixed(4)} ${(t * 100).toFixed(0)}%`)
  .join(', ')})`;
/** Closest cubic-bezier to easeSmooth (0.6% RMS) for engines without linear(). */
export const SMOOTH_EASE_FALLBACK = 'cubic-bezier(0.3, 0.3, 0.25, 1)';

/** The easing string for transitions and WAAPI written from script. */
export const SMOOTH_EASE_CSS =
  typeof CSS !== 'undefined' && CSS.supports?.('transition-timing-function', 'linear(0, 1)')
    ? SMOOTH_EASE_LINEAR
    : SMOOTH_EASE_FALLBACK;

export function rafTween(
  from: number,
  to: number,
  durationMs: number,
  onUpdate: (value: number) => void,
  onComplete?: () => void,
  easing: Easing = easeSmooth,
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
    // A throw from onUpdate must not skip the reschedule: that strands the
    // animation, skips onComplete and leaves caller state inconsistent.
    try {
      onUpdate(from + (to - from) * easing(t));
    } catch (err) {
      console.error('[Motion] rafTween onUpdate threw:', err);
    }
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

export interface SpringOptions {
  stiffness?: number;
  damping?: number;
  /** Units per second. Gesture flings should pass their last velocity here. */
  velocity?: number;
  /** Distance from the target that counts as arrived, in the value's units. */
  restDelta?: number;
}

/** Stops a spring; `velocity()` is its speed right now, in units per second,
 *  so whatever replaces it can carry the motion on instead of restarting. */
export type SpringStop = (() => void) & { velocity: () => number };

// Closed form rather than per-frame integration: the pose depends only on the
// time since the start, so it matches the CSS curve exactly and a slow frame
// never slows the motion down. Interrupting it hands its velocity on.
export function springTween(
  from: number,
  to: number,
  onUpdate: (value: number) => void,
  onComplete?: () => void,
  options: SpringOptions = {},
): SpringStop {
  const stiffness = options.stiffness ?? SPRING_SMOOTH.stiffness;
  const damping = options.damping ?? SPRING_SMOOTH.damping;
  const restDelta = options.restDelta ?? Math.max(0.001, Math.abs(to - from) * 0.001);
  const omega = Math.sqrt(stiffness);
  const zeta = damping / (2 * omega);
  const x0 = from - to;
  const v0 = options.velocity ?? 0;
  const start = performance.now();
  let cancelled = false;
  let rafId = 0;

  /** [offset from target, velocity] at `t` seconds. */
  function state(t: number): [number, number] {
    if (zeta < 1) {
      const wd = omega * Math.sqrt(1 - zeta * zeta);
      const a = x0;
      const b = (v0 + zeta * omega * x0) / wd;
      const e = Math.exp(-zeta * omega * t);
      const cos = Math.cos(wd * t);
      const sin = Math.sin(wd * t);
      return [e * (a * cos + b * sin), e * ((b * wd - zeta * omega * a) * cos - (a * wd + zeta * omega * b) * sin)];
    }
    // Critically damped (over-damping is treated as critical: same rest, no ring).
    const b = v0 + omega * x0;
    const e = Math.exp(-omega * t);
    return [e * (x0 + b * t), e * (b - omega * (x0 + b * t))];
  }

  const stop = (() => {
    cancelled = true;
    cancelAnimationFrame(rafId);
  }) as SpringStop;
  stop.velocity = () => (cancelled ? 0 : state((performance.now() - start) / 1000)[1]);

  if (Math.abs(x0) < restDelta && Math.abs(v0) * 0.05 < restDelta) {
    onUpdate(to);
    onComplete?.();
    cancelled = true;
    return stop;
  }

  const tick = (now: number) => {
    if (cancelled) return;
    const [offset, velocity] = state(Math.max(0, now - start) / 1000);
    // Arrived once it is within restDelta and would not leave it in 50ms.
    const settled = Math.abs(offset) < restDelta && Math.abs(velocity) * 0.05 < restDelta;
    try {
      onUpdate(settled ? to : to + offset);
    } catch (err) {
      console.error('[Motion] springTween onUpdate threw:', err);
    }
    if (settled) {
      cancelled = true;
      onComplete?.();
      return;
    }
    rafId = requestAnimationFrame(tick);
  };

  rafId = requestAnimationFrame(tick);
  return stop;
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

// Reusable string builders for the gesture hot path: callers painting every
// frame keep one and avoid allocating on quiet ticks.
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

export interface SpringParams {
  /** Seconds for one undamped oscillation: lower is quicker. */
  response: number;
  /** 1 lands without overshoot; below 1 overshoots once, which reads as bounce. */
  dampingRatio: number;
}

// Measured from iOS 26's Liquid Glass tab bar (60fps recording): the
// selection snaps across in ~130ms and overshoots ~4%, the bar swells 4.3%
// within ~100ms of touch-down, and on release dips just under rest size.
/** Selection glide to a tab or segment: quick, with one small overshoot. */
export const SPRING_SNAP: SpringParams = { response: 0.24, dampingRatio: 0.72 };
// A tapped pill moves as two edges (fitted to iOS 26 frame by frame): the
// leading edge leaps almost straight to the new tab, and the trailing edge is
// pulled after it, so the pill stretches across both tabs and then gathers
// itself in on arrival — the stretch carries the bounce, not the centre.
/** The pill's leading edge on a tap. */
export const SPRING_LEAD: SpringParams = { response: 0.065, dampingRatio: 0.8 };
/** The trailing edge, chasing the leading one. */
export const SPRING_TRAIL: SpringParams = { response: 0.3, dampingRatio: 1 };
/** A travelling pill's fill returning once it has landed. */
export const SPRING_FILL: SpringParams = { response: 0.22, dampingRatio: 1 };
/** Touch-down: the bar swells and the pill lifts into a lens at once. */
export const SPRING_PRESS: SpringParams = { response: 0.18, dampingRatio: 0.86 };
/** Release: the lens settles back into the pill with a slight undershoot. */
export const SPRING_RELEASE: SpringParams = { response: 0.3, dampingRatio: 0.72 };

/** A value that springs toward a target which can change at any time; each
 *  retarget continues from the current position and velocity. */
export interface SpringValue {
  readonly value: number;
  readonly velocity: number;
  readonly target: number;
  /** Springs toward `target`; `velocity` (units/s) replaces the current one.
   *  `at` is when this leg starts (defaults to now): a value retargeted every
   *  frame passes the previous frame's time so it still advances. */
  to: (target: number, options?: { velocity?: number; params?: SpringParams; at?: number }) => void;
  /** Places the value instantly, at rest. */
  jump: (value: number) => void;
  /** Advances to `now`; returns whether it is still moving. */
  step: (now: number) => boolean;
}

export function createSpringValue(initial: number, params: SpringParams, restDelta = 0.001): SpringValue {
  let value = initial, velocity = 0, target = initial;
  let x0 = 0, v0 = 0, start = 0, omega = 1, zeta = 1, resting = true;

  function to(next: number, options: { velocity?: number; params?: SpringParams; at?: number } = {}) {
    const p = options.params ?? params;
    if (options.velocity !== undefined) velocity = options.velocity;
    target = next;
    x0 = value - target;
    v0 = velocity;
    omega = (2 * Math.PI) / p.response;
    zeta = p.dampingRatio;
    start = options.at ?? performance.now();
    resting = Math.abs(x0) < restDelta && Math.abs(v0) * 0.05 < restDelta;
    if (resting) { value = target; velocity = 0; }
  }

  function step(now: number): boolean {
    if (resting) return false;
    const t = Math.max(0, now - start) / 1000;
    let offset: number;
    if (zeta < 1) {
      const wd = omega * Math.sqrt(1 - zeta * zeta);
      const b = (v0 + zeta * omega * x0) / wd;
      const e = Math.exp(-zeta * omega * t);
      const cos = Math.cos(wd * t), sin = Math.sin(wd * t);
      offset = e * (x0 * cos + b * sin);
      velocity = e * ((b * wd - zeta * omega * x0) * cos - (x0 * wd + zeta * omega * b) * sin);
    } else {
      const b = v0 + omega * x0;
      const e = Math.exp(-omega * t);
      offset = e * (x0 + b * t);
      velocity = e * (b - omega * (x0 + b * t));
    }
    value = target + offset;
    if (Math.abs(offset) < restDelta && Math.abs(velocity) * 0.05 < restDelta) {
      value = target;
      velocity = 0;
      resting = true;
    }
    return !resting;
  }

  return {
    get value() { return value; },
    get velocity() { return velocity; },
    get target() { return target; },
    to,
    jump(next: number) { value = target = next; velocity = 0; resting = true; },
    step,
  };
}

// iOS 26 glass buttons swell under the finger and spring back with a small
// bounce. As a CSS curve: a quick underdamped spring sampled into linear()
// (values past 1 are the overshoot), with a cubic-bezier fallback.
const BOUNCE_OMEGA = (2 * Math.PI) / 0.3;
const BOUNCE_ZETA = 0.62;
const BOUNCE_MS = 420;
function bounceStep(seconds: number): number {
  const wd = BOUNCE_OMEGA * Math.sqrt(1 - BOUNCE_ZETA ** 2);
  const decay = Math.exp(-BOUNCE_ZETA * BOUNCE_OMEGA * seconds);
  return 1 - decay * (Math.cos(wd * seconds) + ((BOUNCE_ZETA * BOUNCE_OMEGA) / wd) * Math.sin(wd * seconds));
}
/** The bounce curve and the duration it is sampled over. */
export const BOUNCE_EASE_LINEAR = `linear(${Array.from({ length: 25 }, (_, i) => i / 24)
  .map((t) => `${(t === 1 ? 1 : bounceStep((t * BOUNCE_MS) / 1000)).toFixed(4)} ${(t * 100).toFixed(1)}%`)
  .join(', ')})`;
export const BOUNCE_EASE_FALLBACK = 'cubic-bezier(0.34, 1.4, 0.64, 1)';
export const BOUNCE_DURATION_MS = BOUNCE_MS;
