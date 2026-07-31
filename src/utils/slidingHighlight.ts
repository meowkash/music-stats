export interface SlidingHighlightOptions {
  highlightEl: HTMLElement;
  buttons: NodeListOf<Element> | Element[];
  colorMap?: (btn: HTMLElement) => { color: string; glow: string } | null;
  onSync?: (btn: HTMLElement) => void;
}

export function syncPillHighlight(
  highlightEl: HTMLElement,
  activeBtn: HTMLElement,
  colorMap?: (btn: HTMLElement) => { color: string; glow: string } | null,
): void {
  highlightEl.style.transform = `translate3d(${activeBtn.offsetLeft}px, ${activeBtn.offsetTop}px, 0)`;
  highlightEl.style.width = `${activeBtn.offsetWidth}px`;
  highlightEl.style.height = `${activeBtn.offsetHeight}px`;

  const colors = colorMap?.(activeBtn);
  if (colors) {
    highlightEl.style.setProperty('--hl-color', colors.color);
    highlightEl.style.setProperty('--hl-glow', colors.glow);
  }
}

export function createSlidingHighlight(options: SlidingHighlightOptions): {
  sync: (btn: HTMLElement) => void;
  observe: () => ResizeObserver;
} {
  const { highlightEl, buttons, colorMap, onSync } = options;

  function sync(btn: HTMLElement) {
    syncPillHighlight(highlightEl, btn, colorMap);
    onSync?.(btn);
  }

  const ro = new ResizeObserver(() => {
    const active = [...buttons].find((b) => b.classList.contains('active')) as HTMLElement | undefined;
    if (active) sync(active);
  });

  return {
    sync,
    observe: () => {
      buttons.forEach((btn) => ro.observe(btn));
      return ro;
    },
  };
}
