import type { MetaData } from '../types/music';
import {
  escapeHTML,
  generateScrobbleRowHTML,
  getArtworkUrl,
  getArtistArtworkUrl,
  getArtworkThumbHTML,
  getArtworkFallbackIcon,
  getColorForUrl,
  getBottomColorForUrl,
  initOverlayAlbumArtwork,
} from './ui';
import { getGlowStyle } from './theme';
import type { ArtistCatalogKey } from './events';
import {
  crossfadeOverlayVisuals,
  washGradient,
  applyOverlayBackground,
  type OverlayColorPair,
} from './overlayArtwork';
import { OVERLAY_SCRIM } from './colorSurface';
import { OVERLAY_CROSSFADE_MS, type OverlayNavDirection } from './overlayTransitions';

export interface OverlayElements {
  overlayArtworkFront: HTMLImageElement;
  overlayArtworkBack: HTMLImageElement;
  overlayArtworkWrapper: HTMLElement;
  overlayArtworkFallback: HTMLElement;
  overlayTitle: HTMLElement;
  overlaySubtitle: HTMLElement;
  overlayMetadata: HTMLElement;
  overlaySongsList: HTMLElement;
  overlayBgBlur: HTMLElement;
  overlayColorWash: HTMLElement;
  overlayColorWashBack: HTMLElement;
  overlayAlbumsSection: HTMLElement;
  overlayAlbumsHeader: HTMLElement;
  overlayAlbumsList: HTMLElement;
}

export interface OverlayPayload {
  type: string;
  imgUrl: string | null;
  colors: OverlayColorPair;
  name: string;
  subtitleHtml: string;
  metadataStr: string;
  sortedTracks: { name: string; count: number }[] | null;
  albumsToRender: { id: number; name: string; scrobbles: number; artistName?: string }[];
  artistNameForArtworkLookup: string;
}


function enrichAlbumsForArtwork(
  albums: { id: number; name: string; scrobbles: number }[],
  catalogData: Record<string, any>,
  fallbackArtist: string,
) {
  return albums.map((alb) => ({
    ...alb,
    artistName: catalogData.albums?.[alb.id]?.artistName ?? fallbackArtist,
  }));
}

const NEUTRAL_OVERLAY_COLORS: OverlayColorPair = {
  primary: { r: 22, g: 22, b: 28 },
  bottom: { ...OVERLAY_SCRIM },
};

function linkStyleFromColor(colorObj: { r: number; g: number; b: number } | null): string {
  if (!colorObj) return '';
  return `color: rgb(${colorObj.r}, ${colorObj.g}, ${colorObj.b}); --link-decoration-color: rgba(${colorObj.r}, ${colorObj.g}, ${colorObj.b}, 0.55);`;
}

function resolveOverlayColors(imgUrl: string | null): OverlayColorPair {
  if (!imgUrl) return NEUTRAL_OVERLAY_COLORS;
  const primary = getColorForUrl(imgUrl) || NEUTRAL_OVERLAY_COLORS.primary;
  const bottom = getBottomColorForUrl(imgUrl) || primary;
  return { primary, bottom };
}

export function buildOverlayPayload(
  type: string,
  id: number,
  dictionary: MetaData,
  catalogData: Record<string, any>,
  artworkCache: Record<string, string>,
  artistCatalog: 'artists' | 'canonicalArtists' = 'canonicalArtists',
): OverlayPayload {
  let name = '';
  let subtitle = '';
  let imgUrl: string | null = null;
  let metadataStr = '';
  let sortedTracks: { name: string; count: number }[] | null = [];
  let albumsToRender: { id: number; name: string; scrobbles: number; artistName?: string }[] = [];
  let artistNameForArtworkLookup = '';
  let artistId = 0;
  let albumId = 0;

  if (type === 'artist') {
    const artistBucket = catalogData[artistCatalog] ?? catalogData.artists ?? catalogData.canonicalArtists;
    const artistInfo = artistBucket?.[id];
    name = artistInfo
      ? artistInfo.name
      : (artistCatalog === 'canonicalArtists'
        ? dictionary.canonicalArtists?.[id]
        : dictionary.artists[id]) ?? dictionary.artists[id] ?? 'Unknown Artist';
    sortedTracks = artistInfo ? artistInfo.tracks : [];
    albumsToRender = artistInfo ? enrichAlbumsForArtwork(artistInfo.albums, catalogData, name) : [];
    const artworkFallbackNames = artistCatalog === 'canonicalArtists'
      ? albumsToRender.map((alb) => alb.artistName).filter((n): n is string => Boolean(n))
      : [];
    imgUrl = getArtistArtworkUrl(name, artworkCache, artworkFallbackNames);
    artistNameForArtworkLookup = name;
    metadataStr = `${(sortedTracks?.length ?? 0)} Songs • ${(artistInfo?.scrobbles ?? 0).toLocaleString()} Plays`;
  } else if (type === 'album') {
    const albumInfo = catalogData.albums[id];
    name = albumInfo ? albumInfo.name : dictionary.albums[id] || 'Unknown Album';
    artistId = albumInfo ? albumInfo.artistId : 0;
    subtitle = albumInfo ? albumInfo.artistName : dictionary.artists[artistId] || 'Unknown Artist';
    imgUrl = getArtworkUrl('album', name, subtitle, name, artworkCache);
    if (albumInfo?.tracks) {
      sortedTracks = (Object.values(albumInfo.tracks) as { name: string; count: number }[]).sort(
        (a, b) => b.count - a.count,
      );
    }
    artistNameForArtworkLookup = subtitle;
    metadataStr = `Album • ${(albumInfo?.scrobbles ?? 0).toLocaleString()} Plays`;
    if (artistId) {
      const artistInfo = catalogData.artists[artistId];
      if (artistInfo?.albums) {
        albumsToRender = enrichAlbumsForArtwork(
          artistInfo.albums.filter((alb: any) => alb.id !== id),
          catalogData,
          subtitle,
        );
      }
    }
  } else if (type === 'track') {
    const trackInfo = dictionary.tracks[id];
    name = trackInfo ? trackInfo[0] : 'Unknown Track';
    artistId = trackInfo ? trackInfo[1] : 0;
    albumId = trackInfo ? trackInfo[2] : 0;
    const artistName = dictionary.artists[artistId] || 'Unknown Artist';
    const albumName = dictionary.albums[albumId] || 'Unknown Album';
    subtitle = `${albumName} • ${artistName}`;
    imgUrl = getArtworkUrl('track', name, artistName, albumName, artworkCache);
    sortedTracks = null;
    artistNameForArtworkLookup = artistName;
    metadataStr = `Song • ${(catalogData.tracks[id] || 0).toLocaleString()} Plays`;
    const artistInfo = catalogData.artists[artistId];
    if (artistInfo?.albums) {
      albumsToRender = enrichAlbumsForArtwork(artistInfo.albums, catalogData, artistName);
    }
  }

  const colorObj = getColorForUrl(imgUrl);
  const linkStyle = linkStyleFromColor(colorObj);

  let subtitleHtml = '';
  if (type === 'album') {
    subtitleHtml = `<span class="clickable-entity overlay-link" data-type="artist" data-id="${artistId}" data-artist-catalog="artists" style="${linkStyle}">${escapeHTML(subtitle)}</span>`;
  } else if (type === 'track') {
    const artistName = dictionary.artists[artistId] || 'Unknown Artist';
    const albumName = dictionary.albums[albumId] || 'Unknown Album';
    subtitleHtml = `<span class="clickable-entity overlay-link" data-type="album" data-id="${albumId}" style="${linkStyle}">${escapeHTML(albumName)}</span> <span style="color: var(--text-primary); opacity: 0.4; margin: 0 4px;">•</span> <span class="clickable-entity overlay-link" data-type="artist" data-id="${artistId}" data-artist-catalog="artists" style="${linkStyle}">${escapeHTML(artistName)}</span>`;
  }

  return {
    type,
    imgUrl,
    colors: resolveOverlayColors(imgUrl),
    name,
    subtitleHtml,
    metadataStr,
    sortedTracks,
    albumsToRender,
    artistNameForArtworkLookup,
  };
}

function applyOverlayTheme(
  payload: OverlayPayload,
  elements: OverlayElements,
  scrollContainer?: HTMLElement,
  panel?: HTMLElement,
): void {
  const gradient = washGradient(payload.colors);
  elements.overlayColorWash.style.background = gradient;
  elements.overlayColorWash.style.opacity = '1';
  elements.overlayColorWashBack.style.opacity = '0';

  if (scrollContainer && panel) {
    applyOverlayBackground(scrollContainer, panel, payload.colors.bottom);
  }
}

/**
 * Text, colour wash and artwork fallback — everything whose cost is O(1) in the
 * size of the entity. Cheap enough to run in the frame that starts the sheet's
 * entrance; `applyOverlayLists` carries the O(tracks) work that must not.
 */
export function applyOverlayShell(
  payload: OverlayPayload,
  elements: OverlayElements,
  scrollContainer?: HTMLElement,
  panel?: HTMLElement,
): void {
  const { overlayTitle, overlaySubtitle, overlayMetadata } = elements;

  overlayTitle.textContent = payload.name;

  if (payload.subtitleHtml) {
    overlaySubtitle.innerHTML = payload.subtitleHtml;
  } else {
    overlaySubtitle.textContent = '';
  }

  overlayMetadata.textContent = payload.metadataStr;

  applyOverlayTheme(payload, elements, scrollContainer, panel);

  const { overlayArtworkFallback } = elements;
  overlayArtworkFallback.className = `overlay-artwork-fallback artwork-fallback artwork-fallback--${payload.type}`;
  overlayArtworkFallback.dataset.type = payload.type;
  if (!payload.imgUrl) {
    overlayArtworkFallback.innerHTML = getArtworkFallbackIcon(payload.type);
    overlayArtworkFallback.classList.remove('hidden');
  }
}

/** Bumped on every list build; an in-flight chunk loop stops when it goes stale. */
let trackListToken = 0;

/**
 * Blanks the previous entity so a sheet that opens before its data has loaded
 * doesn't slide up carrying whatever was shown last.
 */
export function clearOverlayContent(elements: OverlayElements): void {
  trackListToken++;
  elements.overlayTitle.textContent = '';
  elements.overlaySubtitle.textContent = '';
  elements.overlayMetadata.textContent = '';
  elements.overlaySongsList.innerHTML = '';
  elements.overlayAlbumsList.innerHTML = '';
  elements.overlayAlbumsSection.classList.add('hidden');
}

/** Track and album lists — O(tracks + albums), so keep it off the entrance frame. */
export function applyOverlayLists(
  payload: OverlayPayload,
  elements: OverlayElements,
  artworkCache: Record<string, string>,
): void {
  const { overlaySongsList, overlayAlbumsSection, overlayAlbumsHeader, overlayAlbumsList } =
    elements;

  populateTrackList(payload.sortedTracks, overlaySongsList, getGlowStyle(payload.colors.primary));
  populateAlbums(payload.type, payload.albumsToRender, payload.artistNameForArtworkLookup, {
    overlayAlbumsSection,
    overlayAlbumsHeader,
    overlayAlbumsList,
    artworkCache,
  });
}

export function applyOverlayContent(
  payload: OverlayPayload,
  elements: OverlayElements,
  artworkCache: Record<string, string>,
  scrollContainer?: HTMLElement,
  panel?: HTMLElement,
): void {
  applyOverlayShell(payload, elements, scrollContainer, panel);
  applyOverlayLists(payload, elements, artworkCache);
}

export async function crossfadeOverlayContent(
  payload: OverlayPayload,
  elements: OverlayElements,
  durationMs = OVERLAY_CROSSFADE_MS,
  direction: OverlayNavDirection = 'forward',
  scrollContainer?: HTMLElement,
  panel?: HTMLElement,
): Promise<void> {
  if (scrollContainer && panel) {
    applyOverlayBackground(scrollContainer, panel, payload.colors.bottom);
  }

  await crossfadeOverlayVisuals(
    {
      front: elements.overlayArtworkFront,
      back: elements.overlayArtworkBack,
      fallback: elements.overlayArtworkFallback,
      bgBlur: elements.overlayBgBlur,
      wrapper: elements.overlayArtworkWrapper,
    },
    elements.overlayColorWash,
    elements.overlayColorWashBack,
    payload.imgUrl,
    payload.colors,
    durationMs,
    direction,
  );
}

/** Rows built in the first pass — more than fills a 92lvh sheet, so the rest can wait. */
const TRACK_FIRST_CHUNK = 24;
/** Rows appended per idle callback once the entrance has settled. */
const TRACK_CHUNK_SIZE = 60;

function renderTrackRows(
  tracks: { name: string; count: number }[],
  offset: number,
  limit: number,
  countStyle: string,
): string {
  let html = '';
  const end = Math.min(offset + limit, tracks.length);
  for (let i = offset; i < end; i++) {
    html += generateScrobbleRowHTML(
      {
        type: 'track',
        id: 0,
        rank: i + 1,
        name: tracks[i].name,
        subtitle: '',
        imgUrl: null,
        count: tracks[i].count,
        showThumb: false,
        countStyle,
      },
      true,
    );
  }
  return html;
}

const scheduleIdle: (cb: () => void) => void =
  typeof requestIdleCallback === 'function'
    ? (cb) => void requestIdleCallback(() => cb(), { timeout: 200 })
    : (cb) => void setTimeout(cb, 16);

function populateTrackList(
  sortedTracks: { name: string; count: number }[] | null,
  overlaySongsList: HTMLElement,
  countStyle: string,
): void {
  const token = ++trackListToken;
  const overlaySongsSection = overlaySongsList.parentElement;

  if (sortedTracks === null) {
    overlaySongsSection?.classList.add('hidden');
    overlaySongsList.innerHTML = '';
    return;
  }

  overlaySongsSection?.classList.remove('hidden');
  if (sortedTracks.length === 0) {
    overlaySongsList.innerHTML = '<div class="no-data-message">No tracks found</div>';
    return;
  }

  overlaySongsList.innerHTML = renderTrackRows(sortedTracks, 0, TRACK_FIRST_CHUNK, countStyle);
  if (sortedTracks.length <= TRACK_FIRST_CHUNK) return;

  // Remaining rows land during idle time. The sheet is already up and the first
  // screenful is already there, so this is invisible unless you scroll fast.
  let offset = TRACK_FIRST_CHUNK;
  const appendNext = () => {
    if (token !== trackListToken) return;
    overlaySongsList.insertAdjacentHTML(
      'beforeend',
      renderTrackRows(sortedTracks, offset, TRACK_CHUNK_SIZE, countStyle),
    );
    offset += TRACK_CHUNK_SIZE;
    if (offset < sortedTracks.length) scheduleIdle(appendNext);
  };
  scheduleIdle(appendNext);
}

function populateAlbums(
  type: string,
  albumsToRender: { id: number; name: string; scrobbles: number; artistName?: string }[],
  artistNameForArtworkLookup: string,
  ctx: {
    overlayAlbumsSection: HTMLElement;
    overlayAlbumsHeader: HTMLElement;
    overlayAlbumsList: HTMLElement;
    artworkCache: Record<string, string>;
  },
): void {
  const { overlayAlbumsSection, overlayAlbumsHeader, overlayAlbumsList, artworkCache } = ctx;

  if (albumsToRender.length === 0) {
    overlayAlbumsSection.classList.add('hidden');
    overlayAlbumsList.innerHTML = '';
    return;
  }

  overlayAlbumsSection.classList.remove('hidden');
  overlayAlbumsHeader.textContent =
    type === 'artist' ? 'Albums' : `Other Albums by ${artistNameForArtworkLookup}`;

  overlayAlbumsList.innerHTML = albumsToRender
    .map((alb) => {
      const albumArtist = alb.artistName ?? artistNameForArtworkLookup;
      const albImg = getArtworkUrl('album', alb.name, albumArtist, alb.name, artworkCache);
      const thumbHtml = getArtworkThumbHTML(albImg, 'album', { shimmer: false });
      return `
        <div class="overlay-album-card clickable-entity" data-type="album" data-id="${alb.id}">
          <div class="overlay-album-card-artwork">${thumbHtml}</div>
          <span class="overlay-album-card-title">${escapeHTML(alb.name)}</span>
          <span class="overlay-album-card-subtitle">${alb.scrobbles.toLocaleString()} Plays</span>
        </div>
      `;
    })
    .join('');
}

export { initOverlayAlbumArtwork };

export function bindOverlayClicks(
  panel: HTMLElement,
  onNavigate: (type: string, id: number, artistCatalog?: ArtistCatalogKey) => void,
): void {
  panel.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const entity = target.closest('.clickable-entity');
    if (!entity || !panel.contains(entity)) return;

    e.stopPropagation();
    const entityType = entity.getAttribute('data-type');
    const entityId = parseInt(entity.getAttribute('data-id') || '0', 10);
    if (entityType && entityId) {
      const catalog = entity.getAttribute('data-artist-catalog');
      const artistCatalog =
        catalog === 'artists' || catalog === 'canonicalArtists' ? catalog : undefined;
      onNavigate(entityType, entityId, artistCatalog);
    }
  });
}
