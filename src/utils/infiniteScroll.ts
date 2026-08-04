export interface InfiniteScrollOptions<T> {
  container: HTMLElement;
  items: T[];
  chunkSize: number;
  renderItem: (item: T, index: number) => string;
  root?: Element | null;
  rootMargin?: string;
  sentinelClass?: string;
  onChunkRendered?: () => void;
}

export interface InfiniteScrollController {
  reset: (items: unknown[]) => void;
  renderNextChunk: () => void;
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

  function renderNextChunk() {
    if (renderedCount >= items.length) {
      hideSentinel();
      return;
    }

    const nextSlice = items.slice(renderedCount, renderedCount + chunkSize);
    const startIndex = renderedCount;
    const html = nextSlice.map((item, i) => renderItem(item, startIndex + i)).join('');

    // insertAdjacentHTML avoids the wrapper-div parse + child-move dance.
    if (sentinel) {
      sentinel.insertAdjacentHTML('beforebegin', html);
    } else {
      container.insertAdjacentHTML('beforeend', html);
    }

    renderedCount += nextSlice.length;
    onChunkRendered?.();

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

  renderNextChunk();

  return { reset, renderNextChunk };
}
