import { TAB_ORDER, type TabId } from './tabs';

interface DeckPanel {
  el: HTMLElement;
  index: number;
  visible: boolean | null;
  lastOffset: number;
}

export interface DeckSlider {
  measure: () => void;
  /** Main-axis page size — width on mobile, height on desktop sidebar layout. */
  stride: () => number;
  isVertical: () => boolean;
  /** Takes the panels off their CSS transitions for JS-driven positioning. */
  begin: () => void;
  /** Starts a direct glide to `target` from whatever is on screen now. Only
   *  the panels in view and the destination move; tabs in between are never
   *  revealed, so a long jump costs the same as a neighbouring one. Returns
   *  the glide's travel in pages (every moving panel shifts by it). */
  glide: (target: number) => number;
  /** Positions the current glide at progress 0..1. */
  setGlide: (progress: number) => void;
  /** Hands pointer-events back without dropping compositor layers. */
  end: () => void;
  /** Resting pose after a settle — keeps GPU layers, hides far panels. */
  settle: (index: number) => void;
  isActive: () => boolean;
}

// Panels move only once a destination is chosen, straight from what is on
// screen to that destination.
export function createDeckSlider(): DeckSlider | null {
  const deck = document.querySelector('.view-deck') as HTMLElement | null;
  if (!deck) return null;
  const deckEl = deck;

  const panels: DeckPanel[] = ([...deckEl.querySelectorAll('.panel-section')] as HTMLElement[])
    .map((el) => ({
      el,
      index: TAB_ORDER.indexOf(el.id.replace('view-', '') as TabId),
      visible: null,
      lastOffset: Number.NaN,
    }))
    .filter((panel) => panel.index !== -1);

  let deckWidth = deckEl.clientWidth || window.innerWidth;
  let deckHeight = deckEl.clientHeight || window.innerHeight;
  let active = false;
  /** Offsets in page strides at the start and end of the current glide. */
  let gliding: { panel: DeckPanel; from: number; to: number }[] = [];

  const desktopQuery = window.matchMedia('(min-width: 768px)');

  function isVertical() {
    return desktopQuery.matches;
  }

  function stride() {
    return isVertical() ? deckHeight : deckWidth;
  }

  function measure() {
    deckWidth = deckEl.clientWidth || window.innerWidth;
    deckHeight = deckEl.clientHeight || window.innerHeight;
  }

  function show(panel: DeckPanel) {
    if (panel.visible === true) return;
    panel.visible = true;
    panel.el.style.visibility = 'visible';
  }

  function hideFar(center: number) {
    for (const panel of panels) {
      if (Math.abs(panel.index - center) <= 1) continue;
      if (panel.visible === false) continue;
      panel.visible = false;
      panel.el.style.visibility = 'hidden';
    }
  }

  function paintOffset(panel: DeckPanel, offset: number, vertical: boolean) {
    if (Math.abs(offset - panel.lastOffset) < 0.1) return;
    panel.lastOffset = offset;
    panel.el.style.transform = vertical
      ? `translate3d(0, ${offset}px, 0)`
      : `translate3d(${offset}px, 0, 0)`;
  }

  function begin() {
    if (active) return;
    active = true;
    measure();
    deckEl.classList.add('tab-dragging');
    for (const panel of panels) panel.el.style.pointerEvents = 'none';
  }

  function glide(target: number) {
    begin();
    const pageSize = stride() || 1;
    const offsetOf = (panel: DeckPanel) =>
      Number.isNaN(panel.lastOffset) ? panel.index - target : panel.lastOffset / pageSize;
    const onScreen = panels.filter((p) => p.visible === true && Math.abs(offsetOf(p)) < 0.999);
    const anchor = onScreen.reduce<DeckPanel | null>(
      (best, p) => (!best || Math.abs(offsetOf(p)) < Math.abs(offsetOf(best)) ? p : best),
      null,
    );
    const goal = panels.find((p) => p.index === target);
    if (!goal) return 0;

    // The destination enters from its own side, butted against whatever is
    // on screen there, unless it is already in view. Everything moves by the
    // same amount, so a glide retargeted mid-flight never overlaps panels.
    const side = anchor && target < anchor.index ? -1 : 1;
    const offsets = onScreen.map(offsetOf);
    const enter = onScreen.includes(goal)
      ? offsetOf(goal)
      : offsets.length === 0
        ? side
        : side > 0
          ? Math.max(...offsets) + 1
          : Math.min(...offsets) - 1;
    gliding = [{ panel: goal, from: enter, to: 0 }];
    for (const panel of onScreen) {
      if (panel === goal) continue;
      const from = offsetOf(panel);
      let to = from - enter;
      if (Math.abs(to) < 1) to = to < 0 || (to === 0 && enter > 0) ? -1 : 1;
      gliding.push({ panel, from, to });
    }
    show(goal);
    return enter;
  }

  function setGlide(progress: number) {
    const vertical = isVertical();
    const pageSize = stride();
    for (const { panel, from, to } of gliding) {
      paintOffset(panel, (from + (to - from) * progress) * pageSize, vertical);
    }
  }

  function end() {
    if (!active) return;
    active = false;
    gliding = [];
    deckEl.classList.remove('tab-dragging');
  }

  function settle(index: number) {
    end();
    measure();
    const vertical = isVertical();
    const pageSize = stride();
    for (const panel of panels) {
      const nearby = Math.abs(panel.index - index) <= 1;
      if (nearby) show(panel);
      paintOffset(panel, (panel.index - index) * pageSize, vertical);
      panel.el.style.pointerEvents = panel.index === index ? '' : 'none';
    }
    hideFar(index);
  }

  window.addEventListener('resize', () => {
    measure();
    if (!active) {
      const current = panels.find((p) => p.el.classList.contains('active'));
      if (current) settle(current.index);
    }
  });
  desktopQuery.addEventListener('change', measure);

  const initial = panels.find((p) => p.el.classList.contains('active'));
  if (initial) settle(initial.index);

  return {
    measure,
    stride,
    isVertical,
    begin,
    glide,
    setGlide,
    end,
    settle,
    isActive: () => active,
  };
}
