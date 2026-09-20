import { SPRING_PAGE } from './motion';

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

function createGlRenderer(canvas: HTMLCanvasElement): {
  draw: (bars: BarInstance[], width: number, height: number, dpr: number) => void;
  destroy: () => void;
} | null {
  const glCtx = canvas.getContext('webgl2', {
    alpha: true,
    antialias: true,
    premultipliedAlpha: true,
    powerPreference: 'high-performance',
  });
  if (!glCtx) return null;
  const gl = glCtx;

  const vert = `#version 300 es
layout(location=0) in vec2 aUnit;
layout(location=1) in vec4 aRect;
layout(location=2) in vec4 aColor;
uniform vec2 uRes;
out vec2 vUv;
out vec2 vSize;
out vec4 vColor;
void main() {
  vUv = aUnit;
  vSize = aRect.zw;
  vColor = aColor;
  vec2 pos = aRect.xy + aUnit * aRect.zw;
  vec2 clip = vec2((pos.x / uRes.x) * 2.0 - 1.0, 1.0 - (pos.y / uRes.y) * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
}`;

  const frag = `#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vSize;
in vec4 vColor;
out vec4 fragColor;
void main() {
  float radius = min(6.0, min(vSize.x, vSize.y) * 0.45);
  vec2 p = (vUv - 0.5) * vSize;
  vec2 b = max(vSize * 0.5 - vec2(radius), vec2(0.0));
  vec2 q = abs(p) - b;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
  float alpha = vColor.a * (1.0 - smoothstep(-0.8, 0.8, d));
  if (alpha < 0.01) discard;
  fragColor = vec4(vColor.rgb * alpha, alpha);
}`;

  function compile(type: number, src: string): WebGLShader | null {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.warn('[Reports] shader', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  const vs = compile(gl.VERTEX_SHADER, vert);
  const fs = compile(gl.FRAGMENT_SHADER, frag);
  if (!vs || !fs) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn('[Reports] program', gl.getProgramInfoLog(program));
    return null;
  }

  const vao = gl.createVertexArray();
  const quad = gl.createBuffer();
  const rects = gl.createBuffer();
  const colors = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, rects);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(1, 1);

  gl.bindBuffer(gl.ARRAY_BUFFER, colors);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(2, 1);

  const uRes = gl.getUniformLocation(program, 'uRes');

  return {
    draw(bars, width, height, dpr) {
      const w = Math.max(1, Math.round(width * dpr));
      const h = Math.max(1, Math.round(height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(program);
      gl.uniform2f(uRes, width, height);
      gl.bindVertexArray(vao);

      const rectData = new Float32Array(bars.length * 4);
      const colorData = new Float32Array(bars.length * 4);
      for (let i = 0; i < bars.length; i++) {
        const bar = bars[i];
        rectData[i * 4] = bar.x;
        rectData[i * 4 + 1] = bar.y;
        rectData[i * 4 + 2] = bar.w;
        rectData[i * 4 + 3] = bar.h;
        colorData[i * 4] = bar.r;
        colorData[i * 4 + 1] = bar.g;
        colorData[i * 4 + 2] = bar.b;
        colorData[i * 4 + 3] = bar.a;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, rects);
      gl.bufferData(gl.ARRAY_BUFFER, rectData, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, colors);
      gl.bufferData(gl.ARRAY_BUFFER, colorData, gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, bars.length);
    },
    destroy() {
      gl.deleteBuffer(quad);
      gl.deleteBuffer(rects);
      gl.deleteBuffer(colors);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    },
  };
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
  const gl = createGlRenderer(canvas);
  const renderer = gl ?? createCanvasRenderer(canvas);

  let series: ChartSeries | null = null;
  let currentH: number[] = [];
  let previousH: number[] = [];
  let targetCurrent: number[] = [];
  let targetPrevious: number[] = [];
  let velCurrent: number[] = [];
  let velPrevious: number[] = [];
  let rafId = 0;
  let last = 0;

  function cssSize() {
    const rect = canvas.getBoundingClientRect();
    return { width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
  }

  function paint() {
    if (!series) return;
    const { width, height } = cssSize();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const { bars, ticks } = layoutBars(series, width, height, currentH, previousH);
    renderer.draw(bars, width, height, dpr);

    const maxTick = ticks[ticks.length - 1];
    yAxisEl.innerHTML = ticks
      .map((tick) => {
        const top = (tick.y / height) * 100;
        return `<span class="reports-y-tick" style="top:${top.toFixed(2)}%">${tick.label}</span>`;
      })
      .join('');
    void maxTick;
  }

  function tick(now: number) {
    rafId = 0;
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    const { stiffness, damping } = SPRING_PAGE;
    let moving = false;
    for (let i = 0; i < currentH.length; i++) {
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
      currentH = targetCurrent.slice();
      previousH = targetPrevious.slice();
      paint();
    }
  }

  function setData(next: ChartSeries, animate = true) {
    series = next;
    const n = next.labels.length;
    if (!animate || currentH.length !== n) {
      currentH = next.current.slice();
      previousH = next.previous.slice();
      targetCurrent = next.current.slice();
      targetPrevious = next.previous.slice();
      velCurrent = Array(n).fill(0);
      velPrevious = Array(n).fill(0);
      paint();
      return;
    }
    targetCurrent = next.current.slice();
    targetPrevious = next.previous.slice();
    if (!rafId) {
      last = performance.now();
      rafId = requestAnimationFrame(tick);
    }
  }

  function resize() {
    paint();
  }

  function destroy() {
    if (rafId) cancelAnimationFrame(rafId);
    renderer.destroy();
  }

  return { setData, resize, destroy };
}
