// Progress is a CSS animation per segment, not a JS timer: the fill stays on the
// compositor, `animationend` advances so timing can't drift, pause is one property.
// A slide may declare `data-steps="n"`: it then plays as n equal phases inside
// one segment (a tap moves a phase, not a slide), with only the phase boundary
// itself on a timer.

export interface StoryPlayerOptions {
  /** Receives pointer/keyboard input and hosts the slides. */
  root: HTMLElement;
  /** Container the segment elements are (re)built into. */
  progressBar: HTMLElement;
  slides: HTMLElement[];
  durationMs?: number;
  /** Fired as a slide becomes active — the hook for per-slide animations. */
  onEnter?: (index: number, slide: HTMLElement) => void;
  /**
   * Applies a phase to a multi-step slide. `animate` is false when the slide is
   * entered (reset to its first phase) and true for a live phase change. The
   * default just writes `data-step`.
   */
  onStep?: (slide: HTMLElement, step: number, animate: boolean) => void;
  onExit?: () => void;
  /** Fired when advancing past the final slide. */
  onComplete?: () => void;
}

export interface StoryPlayer {
  start(index?: number): void;
  stop(): void;
  next(): void;
  previous(): void;
  pause(): void;
  resume(): void;
  destroy(): void;
  readonly index: number;
}

/** Below this a press is a tap; at or above it, it's a hold-to-pause. */
const HOLD_THRESHOLD_MS = 220;
/** Vertical travel that commits to a dismiss. */
const DISMISS_DISTANCE_PX = 110;
/** Horizontal travel beyond which a gesture is a scrub, not a tap. */
const TAP_SLOP_PX = 12;

export function createStoryPlayer(options: StoryPlayerOptions): StoryPlayer {
  const { root, progressBar, slides, durationMs = 20_000, onEnter, onStep, onExit, onComplete } = options;
  const applyStep =
    onStep ??
    ((slide: HTMLElement, step: number) => {
      slide.dataset.step = String(step);
    });

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const segments: HTMLElement[] = [];
  let index = 0;
  let step = 0;
  let running = false;
  let paused = false;
  let stepTimer: number | null = null;
  let stepDueAt = 0;
  let stepRemaining = 0;
  let holdTimer: number | null = null;
  let held = false;
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let dragging = false;

  progressBar.replaceChildren();
  for (let i = 0; i < slides.length; i++) {
    const segment = document.createElement('div');
    segment.className = 'story-segment';
    const fill = document.createElement('i');
    fill.className = 'story-segment-fill';
    segment.append(fill);
    progressBar.append(segment);
    segments.push(fill);
  }

  function fillFor(i: number): HTMLElement | undefined {
    return segments[i];
  }

  function clearAnimation(i: number) {
    const fill = fillFor(i);
    if (!fill) return;
    fill.style.animation = '';
    fill.style.animationPlayState = '';
  }

  function paintSegments() {
    segments.forEach((fill, i) => {
      const segment = fill.parentElement as HTMLElement;
      segment.classList.toggle('is-seen', i < index);
      segment.classList.toggle('is-active', i === index);
      if (i !== index) {
        clearAnimation(i);
      }
    });
  }

  function onSegmentEnd(event: AnimationEvent) {
    if (event.animationName !== 'story-progress') return;
    next();
  }

  function stepsOf(slide: HTMLElement | undefined): number {
    return Math.max(1, Number(slide?.dataset.steps) || 1);
  }

  function clearStepTimer() {
    if (stepTimer !== null) {
      clearTimeout(stepTimer);
      stepTimer = null;
    }
  }

  function scheduleStep(delay: number) {
    clearStepTimer();
    if (!running || reduceMotion) return;
    if (step >= stepsOf(slides[index]) - 1) return;
    stepRemaining = delay;
    if (paused) return;
    stepDueAt = performance.now() + delay;
    stepTimer = window.setTimeout(() => {
      stepTimer = null;
      // The fill is already at this boundary, so it keeps running untouched.
      goStep(step + 1, false);
    }, delay);
  }

  /** (Re)starts the active fill partway in, at the current phase's start. */
  function startFill() {
    if (!running) return;
    const fill = fillFor(index);
    if (!fill) return;
    const offset = (step / stepsOf(slides[index])) * durationMs;
    fill.style.animation = 'none';
    // Force reflow so re-assigning the same animation restarts it.
    void fill.offsetWidth;
    fill.style.animation = `story-progress ${durationMs}ms linear ${-offset}ms forwards`;
    if (reduceMotion || paused) fill.style.animationPlayState = 'paused';
  }

  function goStep(target: number, restartFill = true) {
    const slide = slides[index];
    step = target;
    applyStep(slide, step, true);
    if (restartFill) startFill();
    scheduleStep(durationMs / stepsOf(slide));
  }

  function show(target: number) {
    const clamped = Math.max(0, Math.min(target, slides.length - 1));
    slides.forEach((slide, i) => {
      const active = i === clamped;
      slide.classList.toggle('is-active', active);
      // Restarting the slide's entry animations is what makes going back feel
      // like replaying the story rather than revealing a static page.
      if (active) slide.classList.remove('has-played');
    });

    index = clamped;
    step = 0;
    paintSegments();

    const slide = slides[index];
    if (stepsOf(slide) > 1) applyStep(slide, 0, false);
    onEnter?.(index, slide);
    // Next frame, so any animation reset above has actually been committed.
    requestAnimationFrame(() => slide?.classList.add('has-played'));

    startFill();
    scheduleStep(durationMs / stepsOf(slide));
  }

  function next() {
    if (step < stepsOf(slides[index]) - 1) {
      goStep(step + 1);
      return;
    }
    if (index >= slides.length - 1) {
      onComplete?.();
      return;
    }
    show(index + 1);
  }

  function previous() {
    if (step > 0) {
      goStep(step - 1);
      return;
    }
    if (index === 0) {
      show(0);
      return;
    }
    show(index - 1);
  }

  function pause() {
    root.classList.add('is-paused');
    const fill = fillFor(index);
    if (fill) fill.style.animationPlayState = 'paused';
    if (!paused && stepTimer !== null) {
      stepRemaining = Math.max(0, stepDueAt - performance.now());
      clearStepTimer();
    }
    paused = true;
  }

  function resume() {
    if (reduceMotion) return;
    root.classList.remove('is-paused');
    const fill = fillFor(index);
    if (fill) fill.style.animationPlayState = 'running';
    if (paused) {
      paused = false;
      if (step < stepsOf(slides[index]) - 1) scheduleStep(stepRemaining);
    }
  }

  function cancelHold() {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  }

  function onPointerDown(event: PointerEvent) {
    if (pointerId !== null) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    held = false;
    dragging = false;

    holdTimer = window.setTimeout(() => {
      held = true;
      pause();
    }, HOLD_THRESHOLD_MS);
  }

  function onPointerMove(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;

    if (!dragging && Math.abs(dy) > Math.abs(dx) && dy > TAP_SLOP_PX) {
      dragging = true;
      cancelHold();
      pause();
      root.classList.add('is-dismissing');
    }

    if (dragging) {
      // Resisted drag — follows the finger but signals it is a dismiss, not a scroll.
      const travel = Math.max(0, dy);
      root.style.transform = `translate3d(0, ${travel * 0.6}px, 0)`;
      root.style.opacity = String(Math.max(0.4, 1 - travel / 420));
    }
  }

  function endPointer(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    cancelHold();

    const dx = event.clientX - startX;
    const dy = event.clientY - startY;

    if (dragging) {
      root.classList.remove('is-dismissing');
      root.style.transform = '';
      root.style.opacity = '';
      if (dy > DISMISS_DISTANCE_PX) {
        onExit?.();
      } else {
        resume();
      }
      dragging = false;
      return;
    }

    if (held) {
      held = false;
      resume();
      return;
    }

    if (Math.abs(dx) > TAP_SLOP_PX || Math.abs(dy) > TAP_SLOP_PX) {
      resume();
      return;
    }

    // Left third goes back, the rest advances — the convention everywhere else.
    const bounds = root.getBoundingClientRect();
    if (event.clientX - bounds.left < bounds.width / 3) {
      previous();
    } else {
      next();
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (!running) return;
    switch (event.key) {
      case 'ArrowRight':
      case ' ':
        event.preventDefault();
        next();
        break;
      case 'ArrowLeft':
        event.preventDefault();
        previous();
        break;
      case 'Escape':
        event.preventDefault();
        onExit?.();
        break;
    }
  }

  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('pointermove', onPointerMove);
  root.addEventListener('pointerup', endPointer);
  root.addEventListener('pointercancel', endPointer);
  progressBar.addEventListener('animationend', onSegmentEnd);
  window.addEventListener('keydown', onKeyDown);

  return {
    start(from = 0) {
      running = true;
      show(from);
    },
    stop() {
      running = false;
      cancelHold();
      clearStepTimer();
      clearAnimation(index);
      root.classList.remove('is-paused');
    },
    next,
    previous,
    pause,
    resume,
    destroy() {
      running = false;
      cancelHold();
      clearStepTimer();
      root.removeEventListener('pointerdown', onPointerDown);
      root.removeEventListener('pointermove', onPointerMove);
      root.removeEventListener('pointerup', endPointer);
      root.removeEventListener('pointercancel', endPointer);
      progressBar.removeEventListener('animationend', onSegmentEnd);
      window.removeEventListener('keydown', onKeyDown);
    },
    get index() {
      return index;
    },
  };
}
