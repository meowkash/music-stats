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

export function generateScrobbleRowHTML(data: ScrobbleRowData, showRank: boolean = true): string {
  const highResImg = data.imgUrl ? data.imgUrl.replace('/300x300/', '/500x500/') : null;
  const thumbContent = highResImg 
    ? `<img src="${escapeHTML(highResImg)}" alt="" crossorigin="anonymous" />`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;

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

export function getDominantColor(imgEl: HTMLImageElement, callback: (rgb: {r: number, g: number, b: number}) => void) {
  if (!imgEl.src || imgEl.src.includes('undefined')) {
    callback({ r: 255, g: 107, b: 138 });
    return;
  }
  
  const img = new Image();
  img.crossOrigin = "Anonymous";
  img.src = imgEl.src;
  
  img.onload = () => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      callback({ r: 255, g: 107, b: 138 });
      return;
    }
    
    canvas.width = img.width;
    canvas.height = img.height;
    ctx.drawImage(img, 0, 0);
    
    let r = 0, g = 0, b = 0;
    try {
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let i = 0; i < data.length; i += 16) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        count++;
      }
      if (count > 0) {
        callback({
          r: Math.floor(r / count),
          g: Math.floor(g / count),
          b: Math.floor(b / count)
        });
        return;
      }
    } catch (e) {
      // Ignore CORS or tainted canvas issues
    }
    callback({ r: 255, g: 107, b: 138 });
  };

  img.onerror = () => {
    callback({ r: 255, g: 107, b: 138 });
  };
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
