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

  function syncSentinel() {
    if (sentinel) {
      observer.unobserve(sentinel);
      sentinel.remove();
      sentinel = null;
    }

    if (renderedCount >= items.length) return;

    sentinel = document.createElement('div');
    sentinel.className = sentinelClass;
    sentinel.setAttribute('aria-hidden', 'true');
    container.appendChild(sentinel);
    observer.observe(sentinel);
  }

  function renderNextChunk() {
    if (renderedCount >= items.length) return;

    const nextSlice = items.slice(renderedCount, renderedCount + chunkSize);
    const startIndex = renderedCount;

    const fragment = document.createElement('div');
    fragment.innerHTML = nextSlice
      .map((item, i) => renderItem(item, startIndex + i))
      .join('');

    while (fragment.firstChild) {
      container.insertBefore(fragment.firstChild, sentinel);
    }

    renderedCount += nextSlice.length;
    onChunkRendered?.();
    syncSentinel();
  }

  function reset(newItems: unknown[]) {
    items = newItems as T[];
    renderedCount = 0;
    if (sentinel) {
      observer.unobserve(sentinel);
      sentinel.remove();
      sentinel = null;
    }
    renderNextChunk();
  }

  renderNextChunk();

  return { reset, renderNextChunk };
}
