import { SPRING_SMOOTH } from './motion';

/** Delay between neighbouring bars when a new set rises from the baseline. */
const RISE_STAGGER_MS = 16;

export interface ChartSeries {
  labels: string[];
  current: number[];
  previous: number[];
  currentColor: [number, number, number, number];
  previousColor: [number, number, number, number];
}

interface BarInstance {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface ReportsChart {
  setData: (series: ChartSeries, animate?: boolean) => void;
  resize: () => void;
  destroy: () => void;
}

/* Y-axis gutter — keep first bars aligned with the range pill track. */
const PAD_L = 44;
const PAD_R = 8;
const PAD_T = 10;
const PAD_B = 6;

function niceMax(value: number): number {
  if (value <= 0) return 10;
  const mag = 10 ** Math.floor(Math.log10(value));
  const n = value / mag;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return nice * mag;
}

function layoutBars(
  series: ChartSeries,
  width: number,
  height: number,
  currentH: number[],
  previousH: number[],
): { bars: BarInstance[]; yMax: number; ticks: Array<{ y: number; label: string }> } {
  const plotW = Math.max(1, width - PAD_L - PAD_R);
  const plotH = Math.max(1, height - PAD_T - PAD_B);
  const n = series.labels.length;
  const groupW = plotW / Math.max(n, 1);
  const barW = Math.min(18, Math.max(4, groupW * 0.32));
  const gap = Math.min(6, barW * 0.28);
  const pair = barW * 2 + gap;
  const yMax = niceMax(Math.max(1, ...series.current, ...series.previous) * 1.08);
  const ticks: Array<{ y: number; label: string }> = [];
  const steps = 3;
  for (let i = 0; i <= steps; i++) {
    const value = (yMax * i) / steps;
    ticks.push({
      y: PAD_T + plotH * (1 - i / steps),
      label: Number.isInteger(value) ? String(value) : value.toFixed(0),
    });
  }

  const bars: BarInstance[] = [];
  const [pr, pg, pb, pa] = series.previousColor;
  const [cr, cg, cb, ca] = series.currentColor;

  for (let i = 0; i < n; i++) {
    const cx = PAD_L + groupW * i + groupW / 2;
    const prevH = (previousH[i] / yMax) * plotH;
    const curH = (currentH[i] / yMax) * plotH;
    bars.push({
      x: cx - pair / 2,
      y: PAD_T + plotH - prevH,
      w: barW,
      h: Math.max(prevH, 0.5),
      r: pr,
      g: pg,
      b: pb,
      a: pa,
    });
    bars.push({
      x: cx - pair / 2 + barW + gap,
      y: PAD_T + plotH - curH,
      w: barW,
      h: Math.max(curH, 0.5),
      r: cr,
      g: cg,
      b: cb,
      a: ca,
    });
  }

  return { bars, yMax, ticks };
}

function createCanvasRenderer(canvas: HTMLCanvasElement): {
  draw: (bars: BarInstance[], width: number, height: number, dpr: number) => void;
  destroy: () => void;
} {
  const ctx = canvas.getContext('2d');
  return {
    draw(bars, width, height, dpr) {
      if (!ctx) return;
      const w = Math.max(1, Math.round(width * dpr));
      const h = Math.max(1, Math.round(height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      for (const bar of bars) {
        ctx.fillStyle = `rgba(${(bar.r * 255 + 0.5) | 0}, ${(bar.g * 255 + 0.5) | 0}, ${(bar.b * 255 + 0.5) | 0}, ${bar.a})`;
        const radius = Math.min(6, Math.min(bar.w, bar.h) * 0.45);
        ctx.beginPath();
        ctx.roundRect(bar.x, bar.y, bar.w, bar.h, radius);
        ctx.fill();
      }
    },
    destroy() {},
  };
}

export function createReportsChart(
  canvas: HTMLCanvasElement,
  yAxisEl: HTMLElement,
): ReportsChart {
  // A small bar chart does not need a GPU context or context-loss lifecycle.
  const renderer = createCanvasRenderer(canvas);

  let series: ChartSeries | null = null;
  let currentH: number[] = [];
  let previousH: number[] = [];
  let targetCurrent: number[] = [];
  let targetPrevious: number[] = [];
  let velCurrent: number[] = [];
  let velPrevious: number[] = [];
  let rafId = 0;
  let last = 0;
  /** When the current rise began; 0 while bars morph in place together. */
  let riseStart = 0;

  function cssSize() {
    const rect = canvas.getBoundingClientRect();
    return { width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
  }

  let axisKey = "";
  let size = { width: 1, height: 1 };
  function paint() {
    if (!series) return;
    const { width, height } = size;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const { bars, ticks } = layoutBars(series, width, height, currentH, previousH);
    renderer.draw(bars, width, height, dpr);

    const maxTick = ticks[ticks.length - 1];
    const nextAxisKey = JSON.stringify(ticks);
    if (axisKey !== nextAxisKey) yAxisEl.innerHTML = ticks
      .map((tick) => {
        const top = (tick.y / height) * 100;
        return `<span class="reports-y-tick" style="top:${top.toFixed(2)}%">${tick.label}</span>`;
      })
      .join('');
    axisKey = nextAxisKey;
    void maxTick;
  }

  function tick(now: number) {
    rafId = 0;
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    const { stiffness, damping } = SPRING_SMOOTH;
    let moving = false;
    for (let i = 0; i < currentH.length; i++) {
      // A rise cascades left to right; each bar holds at the baseline until
      // its turn, which reads as one motion travelling across the chart.
      if (riseStart && now - riseStart < i * RISE_STAGGER_MS) {
        moving = true;
        continue;
      }
      const ac = -stiffness * (currentH[i] - targetCurrent[i]) - damping * velCurrent[i];
      velCurrent[i] += ac * dt;
      currentH[i] += velCurrent[i] * dt;
      const ap = -stiffness * (previousH[i] - targetPrevious[i]) - damping * velPrevious[i];
      velPrevious[i] += ap * dt;
      previousH[i] += velPrevious[i] * dt;
      if (Math.abs(currentH[i] - targetCurrent[i]) > 0.15 || Math.abs(velCurrent[i]) > 0.4) moving = true;
      if (Math.abs(previousH[i] - targetPrevious[i]) > 0.15 || Math.abs(velPrevious[i]) > 0.4) moving = true;
    }
    paint();
    if (moving) rafId = requestAnimationFrame(tick);
    else {
      riseStart = 0;
      currentH = targetCurrent.slice();
      previousH = targetPrevious.slice();
      paint();
    }
  }

  function setData(next: ChartSeries, animate = true) {
    series = next;
    size = cssSize();
    const n = next.labels.length;
    if (!animate) {
      riseStart = 0;
      currentH = next.current.slice();
      previousH = next.previous.slice();
      targetCurrent = next.current.slice();
      targetPrevious = next.previous.slice();
      velCurrent = Array(n).fill(0);
      velPrevious = Array(n).fill(0);
      paint();
      return;
    }
    // A different bucket count (week → month → year) has no bars to morph
    // from, so the new ones rise from the baseline rather than snapping in.
    if (currentH.length !== n) {
      currentH = Array(n).fill(0);
      previousH = Array(n).fill(0);
      velCurrent = Array(n).fill(0);
      velPrevious = Array(n).fill(0);
      riseStart = performance.now();
    }
    targetCurrent = next.current.slice();
    targetPrevious = next.previous.slice();
    if (!rafId) {
      last = performance.now();
      rafId = requestAnimationFrame(tick);
    }
  }

  function resize() {
    size = cssSize();
    paint();
  }

  function destroy() {
    if (rafId) cancelAnimationFrame(rafId);
    renderer.destroy();
  }

  return { setData, resize, destroy };
}
