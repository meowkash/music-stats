export interface InfiniteScrollOptions<T> {
  container: HTMLElement;
  items: T[];
  chunkSize: number;
  renderItem: (item: T, index: number) => string;
  root?: Element | null;
  rootMargin?: string;
  sentinelClass?: string;
  /**
   * Receives only the rows this chunk inserted. Scoping matters: passing the
   * whole container made post-render work triangular — chunk 20 of a 1,000-row
   * list re-queried the 950 rows already handled.
   */
  onChunkRendered?: (added: Element[]) => void;
}

export interface InfiniteScrollController {
  reset: (items: unknown[]) => void;
  destroy: () => void;
}

export function createInfiniteScroll<T>(options: InfiniteScrollOptions<T>): InfiniteScrollController {
  const {
    container,
    chunkSize,
    renderItem,
    root = null,
    rootMargin = '600px 0px',
    sentinelClass = 'scroll-sentinel',
    onChunkRendered,
  } = options;

  let items = options.items;
  let renderedCount = 0;
  let sentinel: HTMLDivElement | null = null;
  let destroyed = false;

  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        renderNextChunk();
      }
    },
    { root, rootMargin },
  );

  function ensureSentinel() {
    if (sentinel) return;
    sentinel = document.createElement('div');
    sentinel.className = sentinelClass;
    sentinel.setAttribute('aria-hidden', 'true');
    container.appendChild(sentinel);
    observer.observe(sentinel);
  }

  function hideSentinel() {
    if (!sentinel) return;
    observer.unobserve(sentinel);
    sentinel.remove();
    sentinel = null;
  }

  /** Nodes between the insertion point and `stop`, exclusive. */
  function collectAfter(marker: ChildNode | null, stop: ChildNode | null): Element[] {
    const added: Element[] = [];
    let node = marker ? marker.nextSibling : container.firstChild;
    while (node && node !== stop) {
      if (node.nodeType === Node.ELEMENT_NODE) added.push(node as Element);
      node = node.nextSibling;
    }
    return added;
  }

  function renderNextChunk() {
    if (destroyed) return;
    if (renderedCount >= items.length) {
      hideSentinel();
      return;
    }

    const nextSlice = items.slice(renderedCount, renderedCount + chunkSize);
    const startIndex = renderedCount;
    const html = nextSlice.map((item, i) => renderItem(item, startIndex + i)).join('');

    // insertAdjacentHTML avoids the wrapper-div parse + child-move dance.
    const marker = sentinel ? sentinel.previousSibling : container.lastChild;
    if (sentinel) {
      sentinel.insertAdjacentHTML('beforebegin', html);
    } else {
      container.insertAdjacentHTML('beforeend', html);
    }
    const added = onChunkRendered ? collectAfter(marker, sentinel) : null;

    renderedCount += nextSlice.length;
    if (added) onChunkRendered?.(added);

    if (renderedCount >= items.length) hideSentinel();
    else ensureSentinel();
  }

  function reset(newItems: unknown[]) {
    items = newItems as T[];
    renderedCount = 0;
    hideSentinel();
    // Clear existing rows without destroying a reused sentinel we just hid.
    container.replaceChildren();
    renderNextChunk();
  }

  /**
   * Callers churn controllers (a new one per search keystroke), so the observer
   * needs an explicit release rather than being left watching a detached
   * sentinel until GC gets round to it.
   */
  function destroy() {
    destroyed = true;
    hideSentinel();
    observer.disconnect();
  }

  renderNextChunk();

  return { reset, destroy };
}
