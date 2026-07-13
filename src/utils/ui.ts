export interface ScrobbleRowData {
  type: string;
  id: string | number;
  rank?: number;
  name: string;
  subtitle: string;
  imgUrl: string | null;
  count: number | string;
  color?: string; // Hex or rgb string
}

function escapeHTML(str: string): string {
  if (!str) return '';
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

export function getArtworkUrl(
  type: string,
  name: string,
  artistName: string,
  albumName: string,
  artworkCache: Record<string, string>
): string | null {
  if (type === 'track') {
    return artworkCache[`${name}|${artistName}`] || artworkCache[`${albumName}|${artistName}`] || artworkCache[artistName] || null;
  } else if (type === 'album') {
    return artworkCache[`${name}|${artistName}`] || artworkCache[artistName] || null;
  } else if (type === 'artist') {
    return artworkCache[name] || null;
  }
  return null;
}

export function generateScrobbleRowHTML(data: ScrobbleRowData, showRank: boolean = true): string {
  const highResImg = data.imgUrl ? data.imgUrl.replace('/300x300/', '/500x500/') : null;
  const thumbContent = highResImg 
    ? `<img src="${escapeHTML(highResImg)}" alt="" crossorigin="anonymous" />`
    : `<div style="display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; background: rgba(255, 255, 255, 0.05);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 22px; height: 22px; color: rgba(255,255,255,0.4);"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>`;

  const rankHtml = showRank ? `<span class="scrobble-row-rank">${data.rank}</span>` : '';
  const countColorStyle = data.color ? `color: ${data.color}; text-shadow: 0 0 10px ${data.color}80;` : '';
  
  // Note: we add 'clickable-entity' and data-type/data-id so it can be picked up by event delegation
  return `
    <div class="scrobble-row clickable-entity" data-type="${escapeHTML(data.type)}" data-id="${data.id}">
      ${rankHtml}
      <div class="scrobble-row-thumb">
          ${thumbContent}
      </div>
      <div class="scrobble-row-info">
        <span class="scrobble-row-title">${escapeHTML(data.name)}</span>
        <span class="scrobble-row-subtitle">${escapeHTML(data.subtitle)}</span>
      </div>
      <div class="scrobble-row-right">
        <span class="scrobble-count-val" style="${countColorStyle}">${typeof data.count === 'number' ? data.count.toLocaleString() : escapeHTML(data.count)}</span>
      </div>
    </div>
  `;
}

let colorsCache: Record<string, {r: number, g: number, b: number}> | null = null;
let colorsPromise: Promise<void> | null = null;

export async function loadColorsCache() {
  if (colorsCache) return;
  if (!colorsPromise) {
    colorsPromise = fetch('/data/colors.json')
      .then(res => res.json())
      .then(data => { colorsCache = data; })
      .catch(e => { console.error('Failed to load colors.json', e); colorsCache = {}; });
  }
  await colorsPromise;
}

export function getDominantColor(imgEl: HTMLImageElement, callback: (rgb: {r: number, g: number, b: number}) => void) {
  const fallback = { r: 255, g: 255, b: 255 };
  if (!imgEl.src || imgEl.src.includes('undefined')) {
    callback(fallback);
    return;
  }
  
  if (colorsCache) {
    // Try to get exactly matching URL first, or just find it by ignoring origin
    let url = imgEl.src;
    try {
      const parsed = new URL(url);
      url = parsed.origin + parsed.pathname; // remove search params
    } catch(e) {}
    
    const applyColor = (color: {r: number, g: number, b: number}) => {
      // Ensure good contrast for dark colors by treating as missing/white if too dark
      const brightness = (color.r * 299 + color.g * 587 + color.b * 114) / 1000;
      if (brightness < 30) {
        callback(fallback);
      } else {
        callback(color);
      }
    };
    
    // Exact match
    if (colorsCache[url]) {
      applyColor(colorsCache[url]);
      return;
    }
    
    // Fallback URL
    const fallbackUrl = url.replace('/500x500/', '/300x300/');
    if (colorsCache[fallbackUrl]) {
      applyColor(colorsCache[fallbackUrl]);
      return;
    }
    
    // Fallback if not found in cache
    callback(fallback);
  } else {
    // If cache not loaded yet, just use fallback (should call loadColorsCache() on app load)
    callback(fallback);
  }
}

export function applyCountGlows(container: HTMLElement) {
  const rows = container.querySelectorAll('.scrobble-row');
  rows.forEach(row => {
    const imgEl = row.querySelector('.scrobble-row-thumb img') as HTMLImageElement;
    const countEl = row.querySelector('.scrobble-count-val');
    if (!imgEl || !countEl) return;
    
    if (countEl.getAttribute('data-colored')) return;
    
    getDominantColor(imgEl, (rgb) => {
      countEl.setAttribute('style', `color: rgb(${rgb.r}, ${rgb.g}, ${rgb.b}); text-shadow: 0 0 8px rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.5); font-weight: 700;`);
      countEl.setAttribute('data-colored', 'true');
    });
  });
}

export function getColorForUrl(url: string | null): {r: number, g: number, b: number} | null {
  if (!url || !colorsCache) return null;
  let cleanUrl = url;
  try {
    const parsed = new URL(url);
    cleanUrl = parsed.origin + parsed.pathname;
  } catch(e) {}
  
  let color = colorsCache[cleanUrl];
  if (!color) {
    color = colorsCache[cleanUrl.replace('/500x500/', '/300x300/')];
  }
  
  if (color) {
    const brightness = (color.r * 299 + color.g * 587 + color.b * 114) / 1000;
    if (brightness >= 30) {
      return color;
    }
  }
  return null;
}
