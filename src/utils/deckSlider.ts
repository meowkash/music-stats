import { TAB_ORDER, type TabId } from './tabs';

interface DeckPanel {
  el: HTMLElement;
  index: number;
  visible: boolean | null;
  lastX: number;
}

export interface DeckSlider {
  measure: () => void;
  width: () => number;
  /** Takes the panels off their CSS transitions for JS-driven positioning. */
  begin: () => void;
  /** Positions the deck at a fractional tab index. */
  setPosition: (fraction: number) => void;
  /** Hands the panels back to their class-driven transforms. */
  end: () => void;
  isActive: () => boolean;
}

/**
 * Reveal the destination panel as soon as the gesture starts toward it, and
 * never flip visibility mid-frame after that. Avoids a full-panel paint spike
 * during the settle.
 */
export function createDeckSlider(): DeckSlider | null {
  const deck = document.querySelector('.view-deck') as HTMLElement | null;
  if (!deck) return null;

  const panels: DeckPanel[] = ([...deck.querySelectorAll('.panel-section')] as HTMLElement[])
    .map((el) => ({
      el,
      index: TAB_ORDER.indexOf(el.id.replace('view-', '') as TabId),
      visible: null,
      lastX: Number.NaN,
    }))
    .filter((panel) => panel.index !== -1);

  let deckWidth = deck.clientWidth || window.innerWidth;
  let active = false;
  let prepared = false;

  function measure() {
    deckWidth = deck.clientWidth || window.innerWidth;
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
    deck.classList.add('tab-dragging');
    for (const panel of panels) {
      panel.visible = null;
      panel.lastX = Number.NaN;
      panel.el.style.pointerEvents = 'none';
    }
  }

  function setPosition(fraction: number) {
    if (!active) return;

    if (!prepared) {
      // Reveal the current panel and its immediate neighbours once. Mid-gesture
      // visibility flips are what cause the stuttery paint spikes.
      const center = Math.round(fraction);
      for (const panel of panels) {
        if (Math.abs(panel.index - center) <= 1) show(panel);
      }
      prepared = true;
    } else {
      // If the user drags past a neighbour, bring the next one in early — but
      // only when crossing an integer boundary, not every frame.
      const lo = Math.floor(fraction);
      const hi = Math.ceil(fraction);
      for (const panel of panels) {
        if (panel.index === lo || panel.index === hi) show(panel);
      }
    }

    for (const panel of panels) {
      if (panel.visible !== true) continue;
      const x = (panel.index - fraction) * deckWidth;
      // Skip sub-pixel no-ops.
      if (Math.abs(x - panel.lastX) < 0.1) continue;
      panel.lastX = x;
      panel.el.style.transform = `translate3d(${x}px, 0, 0)`;
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
      panel.lastX = Number.NaN;
    }
    deck.classList.remove('tab-dragging');
  }

  window.addEventListener('resize', measure);

  return {
    measure,
    width: () => deckWidth,
    begin,
    setPosition,
    end,
    isActive: () => active,
  };
}
