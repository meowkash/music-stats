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
  /** Positions the deck at a fractional tab index. */
  setPosition: (fraction: number) => void;
  /** Hands the panels back to their class-driven transforms. */
  end: () => void;
  isActive: () => boolean;
}

/**
 * Reveal destination panels as soon as a gesture begins to prevent mid-frame paint spikes.
 */
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
  let prepared = false;

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

  function begin() {
    if (active) return;
    active = true;
    prepared = false;
    measure();
    deckEl.classList.add('tab-dragging');
    for (const panel of panels) {
      panel.visible = null;
      panel.lastOffset = Number.NaN;
      panel.el.style.pointerEvents = 'none';
    }
  }

  function setPosition(fraction: number) {
    if (!active) return;

    const vertical = isVertical();
    const pageSize = stride();

    if (!prepared) {
      const center = Math.round(fraction);
      for (const panel of panels) {
        if (Math.abs(panel.index - center) <= 1) show(panel);
      }
      prepared = true;
    } else {
      const lo = Math.floor(fraction);
      const hi = Math.ceil(fraction);
      for (const panel of panels) {
        if (panel.index === lo || panel.index === hi) show(panel);
      }
    }

    for (const panel of panels) {
      if (panel.visible !== true) continue;
      const offset = (panel.index - fraction) * pageSize;
      if (Math.abs(offset - panel.lastOffset) < 0.1) continue;
      panel.lastOffset = offset;
      panel.el.style.transform = vertical
        ? `translate3d(0, ${offset}px, 0)`
        : `translate3d(${offset}px, 0, 0)`;
    }
  }

  function end() {
    if (!active) return;
    active = false;
    prepared = false;
    for (const panel of panels) {
      panel.el.style.transform = '';
      panel.el.style.visibility = '';
      panel.el.style.pointerEvents = '';
      panel.visible = null;
      panel.lastOffset = Number.NaN;
    }
    deckEl.classList.remove('tab-dragging');
  }

  window.addEventListener('resize', measure);
  desktopQuery.addEventListener('change', measure);

  return {
    measure,
    stride,
    isVertical,
    begin,
    setPosition,
    end,
    isActive: () => active,
  };
}
