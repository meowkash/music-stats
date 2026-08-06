/** Duration each story card stays visible before auto-advancing. */
export const STORY_DURATION_MS = 15_000;

export interface StoryPlayer {
  start: () => void;
  stop: () => void;
  pause: () => void;
  resume: () => void;
  resetSegment: () => void;
  destroy: () => void;
}

export interface StoryPlayerOptions {
  getIndex: () => number;
  getCount: () => number;
  goTo: (index: number) => void;
  /** Progress 0–1 for the active segment. */
  onProgress: (index: number, progress: number) => void;
  onSegmentComplete?: (index: number) => void;
  /** Return false to freeze the timer (tab hidden, user holding, etc.). */
  isActive: () => boolean;
}

/**
 * Instagram / Spotify-style story timer. Uses rAF so the progress bar stays
 * in sync with the segment duration.
 */
export function createStoryPlayer(options: StoryPlayerOptions): StoryPlayer {
  let rafId = 0;
  let segmentStart = 0;
  let elapsedBeforePause = 0;
  let paused = false;
  let running = false;

  function segmentElapsed(now: number): number {
    if (paused) return elapsedBeforePause;
    return elapsedBeforePause + (now - segmentStart);
  }

  function tick(now: number) {
    if (!running) return;

    if (!options.isActive()) {
      rafId = requestAnimationFrame(tick);
      return;
    }

    const elapsed = segmentElapsed(now);
    const progress = Math.min(elapsed / STORY_DURATION_MS, 1);
    options.onProgress(options.getIndex(), progress);

    if (progress >= 1) {
      const idx = options.getIndex();
      options.onSegmentComplete?.(idx);
      const next = idx + 1;
      if (next < options.getCount()) {
        options.goTo(next);
        resetSegment();
        rafId = requestAnimationFrame(tick);
      } else {
        stop();
      }
      return;
    }

    rafId = requestAnimationFrame(tick);
  }

  function start() {
    if (running) return;
    running = true;
    paused = false;
    segmentStart = performance.now();
    elapsedBeforePause = 0;
    rafId = requestAnimationFrame(tick);
  }

  function stop() {
    running = false;
    paused = false;
    cancelAnimationFrame(rafId);
  }

  function pause() {
    if (paused || !running) return;
    elapsedBeforePause += performance.now() - segmentStart;
    paused = true;
  }

  function resume() {
    if (!paused || !running) return;
    segmentStart = performance.now();
    paused = false;
  }

  function resetSegment() {
    elapsedBeforePause = 0;
    segmentStart = performance.now();
    paused = false;
  }

  function destroy() {
    stop();
  }

  return { start, stop, pause, resume, resetSegment, destroy };
}
