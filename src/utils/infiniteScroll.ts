import { disposeArtworkImages } from './ui';
export interface InfiniteScrollOptions<T> {
  container: HTMLElement;
  items: T[];
  chunkSize: number;
  axis?: 'x' | 'y';
  renderItem: (item: T, index: number) => string;
  root?: Element | null;
  rootMargin?: string;
  sentinelClass?: string;
  onChunkRendered?: (added: Element[]) => void;
}
export interface InfiniteScrollController { reset: (items: unknown[]) => void; destroy: () => void }

/** A fixed-size window with spacers preserves the entire scroll range. Rows in
 * this app have one-line text and fixed thumbnails, so one measured row stride
 * remains accurate; ResizeObserver remeasures after breakpoint/font changes. */
export function createInfiniteScroll<T>(options: InfiniteScrollOptions<T>): InfiniteScrollController {
  const { container, renderItem, onChunkRendered } = options;
  const root = options.root instanceof HTMLElement ? options.root : container.parentElement!;
  const horizontal = options.axis === 'x';
  let gap = horizontal ? parseFloat(getComputedStyle(container).columnGap) || 0 : 0;
  const maxRows = Math.max(60, options.chunkSize * 3);
  let items = options.items, start = -1, end = -1, stride = 0, frame = 0, destroyed = false;
  const top = document.createElement('div'), bottom = document.createElement('div');
  top.className = bottom.className = 'virtual-scroll-spacer';
  top.setAttribute('aria-hidden', 'true'); bottom.setAttribute('aria-hidden', 'true');
  top.style.cssText = bottom.style.cssText = 'flex:none;pointer-events:none;';
  container.replaceChildren(top, bottom);
  const rows = new Map<number, HTMLElement>();
  function schedule(): void { if (!destroyed && !frame) frame = requestAnimationFrame(paint); }
  function measure(): void {
    const row = rows.values().next().value as HTMLElement | undefined;
    if (!row) return;
    if (horizontal) gap = parseFloat(getComputedStyle(container).columnGap) || 0;
    const style = getComputedStyle(row);
    // Press/FLIP transforms must not change the virtual scroll range. Computed
    // layout sizes retain fractional pixels without including those transforms.
    const span = parseFloat(horizontal ? style.width : style.height);
    const size = Number.isFinite(span) ? span : horizontal ? row.offsetWidth : row.offsetHeight;
    const height = horizontal ? size + gap : size + parseFloat(style.marginTop || '0') + parseFloat(style.marginBottom || '0');
    if (height > 0 && Math.abs(height - stride) > 0.1) { stride = height; start = -1; schedule(); }
  }
  function paint(): void {
    frame = 0; if (destroyed) return;
    const origin = root === container ? 0 : (horizontal ? container.getBoundingClientRect().left - root.getBoundingClientRect().left + root.scrollLeft : container.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop);
    const offset = Math.max(0, (horizontal ? root.scrollLeft : root.scrollTop) - origin);
    const overscan = Math.min(options.chunkSize, 20);
    const visible = stride ? Math.ceil((horizontal ? root.clientWidth : root.clientHeight) / stride) : options.chunkSize;
    const windowSize = Math.min(maxRows, Math.max(options.chunkSize, visible + 2 * overscan));
    const nextStart = stride ? Math.max(0, Math.min(items.length - windowSize, Math.floor(offset / stride) - overscan)) : 0;
    const nextEnd = Math.min(items.length, nextStart + windowSize);
    if (nextStart === start && nextEnd === end) return;
    start = nextStart; end = nextEnd;
    for (const [index, row] of rows) if (index < start || index >= end) {
      disposeArtworkImages(row); row.remove(); rows.delete(index);
    }
    const added: Element[] = [];
    for (let index = end - 1; index >= start; index--) {
      let row = rows.get(index);
      if (!row) {
        const template = document.createElement('template'); template.innerHTML = renderItem(items[index], index);
        row = template.content.firstElementChild as HTMLElement;
        row.style.contentVisibility = 'visible';
        row.setAttribute('aria-posinset', String(index + 1)); row.setAttribute('aria-setsize', String(items.length));
        rows.set(index, row); added.push(row);
      }
      const next = rows.get(index + 1) ?? bottom;
      if (row.nextSibling !== next) container.insertBefore(row, next);
    }
    const dimension = horizontal ? 'width' : 'height';
    const remaining = Math.max(0, items.length - end);
    top.style.display = horizontal && start === 0 ? 'none' : '';
    bottom.style.display = horizontal && remaining === 0 ? 'none' : '';
    // Keep the real CSS gap. A nonempty spacer replaces N cards and their
    // internal gaps; the flex gap next to it supplies the final separation.
    top.style[dimension] = `${Math.max(0, start * stride - (horizontal ? gap : 0))}px`;
    bottom.style[dimension] = `${Math.max(0, remaining * stride - (horizontal ? gap : 0))}px`;
    if (added.length) onChunkRendered?.(added);
    measure();
  }
  const observer = new ResizeObserver(() => { measure(); schedule(); });
  observer.observe(root);
  root.addEventListener('scroll', schedule, { passive: true });
  function reset(next: unknown[]): void {
    disposeArtworkImages(container);
    items = next as T[]; rows.clear(); start = end = -1;
    container.replaceChildren(top, bottom); paint();
  }
  function destroy(): void {
    destroyed = true; cancelAnimationFrame(frame);
    observer.disconnect(); root.removeEventListener('scroll', schedule);
    disposeArtworkImages(container); rows.clear();
  }
  paint();
  return { reset, destroy };
}
