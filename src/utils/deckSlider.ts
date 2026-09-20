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
  /** Hands pointer-events back without dropping compositor layers. */
  end: () => void;
  /** Resting pose after a settle — keeps GPU layers, hides far panels. */
  settle: (index: number) => void;
  isActive: () => boolean;
}

// Reveal destination panels as the gesture begins, to avoid mid-frame paint spikes.
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
    prepared = false;
    measure();
    deckEl.classList.add('tab-dragging');
    for (const panel of panels) {
      panel.visible = null;
      panel.el.style.pointerEvents = 'none';
    }
  }

  function setPosition(fraction: number) {
    const vertical = isVertical();
    const pageSize = stride();

    if (active) {
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
    }

    for (const panel of panels) {
      if (active && panel.visible !== true) continue;
      paintOffset(panel, (panel.index - fraction) * pageSize, vertical);
    }
  }

  function end() {
    if (!active) return;
    active = false;
    prepared = false;
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
    setPosition,
    end,
    settle,
    isActive: () => active,
  };
}
