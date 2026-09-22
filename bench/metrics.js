// Injected into the page. Everything here runs in the browser, so it must stay
// dependency-free and must not itself cost enough to skew what it measures.

/**
 * Frame recorder. rAF deltas are the closest proxy we have to what the user
 * perceives: a gesture that drops frames shows up here as a long delta whether
 * the cause was layout, script, or a stalled compositor commit.
 */
export const RECORDER_SOURCE = `
window.__bench = {
  frames: [],
  longTasks: [],
  rafId: null,
  lastTs: 0,
  marks: {},

  start() {
    this.frames = [];
    this.longTasks = [];
    this.marks = {};
    this.lastTs = 0;

    try {
      this.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.longTasks.push({ start: entry.startTime, duration: entry.duration });
        }
      });
      this.observer.observe({ entryTypes: ['longtask'] });
    } catch (e) {
      this.observer = null;
    }

    const tick = (ts) => {
      if (this.lastTs) this.frames.push(ts - this.lastTs);
      this.lastTs = ts;
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  },

  mark(name) {
    this.marks[name] = performance.now();
  },

  stop() {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.observer) { this.observer.disconnect(); this.observer = null; }
    return { frames: this.frames.slice(), longTasks: this.longTasks.slice(), marks: this.marks };
  },
};
`;

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

/**
 * Turns raw frame deltas into the handful of numbers worth tracking. p95 is the
 * headline: a gesture is judged by its worst frames, not its average.
 */
export function summarize(raw) {
  // The first delta after start() straddles setup and is not a real frame.
  const frames = raw.frames.slice(1);
  const sorted = [...frames].sort((a, b) => a - b);

  const round = (n) => Math.round(n * 10) / 10;

  return {
    frameCount: frames.length,
    p50Frame: round(percentile(sorted, 50)),
    p95Frame: round(percentile(sorted, 95)),
    maxFrame: round(sorted.length ? sorted[sorted.length - 1] : 0),
    // 20ms rather than 16.7: a 60Hz frame that lands a couple of ms late is not
    // something anyone sees, and counting those makes the metric noise.
    droppedFrames: frames.filter((f) => f > 20).length,
    // A frame this long is a visible hitch, not a dropped frame.
    stalls: frames.filter((f) => f > 50).length,
    longTaskCount: raw.longTasks.length,
    longTaskMs: round(raw.longTasks.reduce((sum, t) => sum + t.duration, 0)),
    marks: Object.fromEntries(Object.entries(raw.marks).map(([k, v]) => [k, round(v)])),
  };
}
