import type { MetaData } from '../types/music';
import {
  escapeHTML,
  generateScrobbleRowHTML,
  getArtworkUrl,
  getArtworkThumbHTML,
  getArtworkFallbackHTML,
  getArtworkFallbackIcon,
  getColorForUrl,
  getBottomColorForUrl,
  initArtworkImages,
  initOverlayAlbumArtwork,
} from './ui';
import { getGlowStyle } from './theme';
import {
  crossfadeOverlayArtwork,
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

export interface PopulateContext {
  elements: OverlayElements;
  artworkCache: Record<string, string>;
  onNavigate: (type: string, id: number) => void;
  animate?: boolean;
  scrollContainer?: HTMLElement;
  panel?: HTMLElement;
}

export interface OverlayPayload {
  type: string;
  imgUrl: string | null;
  colors: OverlayColorPair;
  name: string;
  subtitleHtml: string;
  metadataStr: string;
  sortedTracks: { name: string; count: number }[] | null;
  albumsToRender: { id: number; name: string; scrobbles: number }[];
  artistNameForArtworkLookup: string;
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
  let albumsToRender: { id: number; name: string; scrobbles: number }[] = [];
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
    imgUrl = getArtworkUrl('artist', name, name, '', artworkCache);
    sortedTracks = artistInfo ? artistInfo.tracks : [];
    albumsToRender = artistInfo ? artistInfo.albums : [];
    artistNameForArtworkLookup = name;
    metadataStr = `${sortedTracks.length} Songs • ${(artistInfo?.scrobbles ?? 0).toLocaleString()} Plays`;
  } else if (type === 'album') {
    const albumInfo = catalogData.albums[id];
    name = albumInfo ? albumInfo.name : dictionary.albums[id] || 'Unknown Album';
    artistId = albumInfo ? albumInfo.artistId : 0;
    subtitle = albumInfo ? albumInfo.artistName : dictionary.artists[artistId] || 'Unknown Artist';
    imgUrl = getArtworkUrl('album', name, subtitle, name, artworkCache);
    if (albumInfo?.tracks) {
      sortedTracks = Object.values(albumInfo.tracks).sort(
        (a: any, b: any) => b.count - a.count,
      );
    }
    artistNameForArtworkLookup = subtitle;
    metadataStr = `Album • ${(albumInfo?.scrobbles ?? 0).toLocaleString()} Plays`;
    if (artistId) {
      const artistInfo = catalogData.artists[artistId];
      if (artistInfo?.albums) {
        albumsToRender = artistInfo.albums.filter((alb: any) => alb.id !== id);
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
      albumsToRender = artistInfo.albums;
    }
  }

  const colorObj = getColorForUrl(imgUrl);
  const linkStyle = linkStyleFromColor(colorObj);

  let subtitleHtml = '';
  if (type === 'album') {
    subtitleHtml = `<span class="clickable-entity overlay-link" data-type="artist" data-id="${artistId}" style="${linkStyle}">${escapeHTML(subtitle)}</span>`;
  } else if (type === 'track') {
    const artistName = dictionary.artists[artistId] || 'Unknown Artist';
    const albumName = dictionary.albums[albumId] || 'Unknown Album';
    subtitleHtml = `<span class="clickable-entity overlay-link" data-type="album" data-id="${albumId}" style="${linkStyle}">${escapeHTML(albumName)}</span> <span style="color: var(--text-primary); opacity: 0.4; margin: 0 4px;">•</span> <span class="clickable-entity overlay-link" data-type="artist" data-id="${artistId}" style="${linkStyle}">${escapeHTML(artistName)}</span>`;
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

export function applyOverlayContent(
  payload: OverlayPayload,
  elements: OverlayElements,
  artworkCache: Record<string, string>,
  scrollContainer?: HTMLElement,
  panel?: HTMLElement,
): void {
  const {
    overlayTitle,
    overlaySubtitle,
    overlayMetadata,
    overlaySongsList,
    overlayAlbumsSection,
    overlayAlbumsHeader,
    overlayAlbumsList,
  } = elements;

  overlayTitle.textContent = payload.name;

  if (payload.subtitleHtml) {
    overlaySubtitle.innerHTML = payload.subtitleHtml;
  } else {
    overlaySubtitle.textContent = '';
  }

  overlayMetadata.textContent = payload.metadataStr;

  populateTrackList(payload.sortedTracks, overlaySongsList);
  populateAlbums(payload.type, payload.albumsToRender, payload.artistNameForArtworkLookup, {
    overlayAlbumsSection,
    overlayAlbumsHeader,
    overlayAlbumsList,
    artworkCache,
  });

  const glowStyle = getGlowStyle(payload.colors.primary);
  overlaySongsList.querySelectorAll('.scrobble-count-val').forEach((el) => {
    el.setAttribute('style', glowStyle);
  });

  applyOverlayTheme(payload, elements, scrollContainer, panel);

  const { overlayArtworkFallback } = elements;
  overlayArtworkFallback.className = `overlay-artwork-fallback artwork-fallback artwork-fallback--${payload.type}`;
  overlayArtworkFallback.dataset.type = payload.type;
  if (!payload.imgUrl) {
    overlayArtworkFallback.innerHTML = getArtworkFallbackIcon(payload.type);
    overlayArtworkFallback.classList.remove('hidden');
  }
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

export async function populateOverlay(
  type: string,
  id: number,
  dictionary: MetaData,
  catalogData: Record<string, any>,
  ctx: PopulateContext,
  artistCatalog: 'artists' | 'canonicalArtists' = 'canonicalArtists',
): Promise<void> {
  const { elements, artworkCache, animate = false, scrollContainer, panel } = ctx;
  const payload = buildOverlayPayload(type, id, dictionary, catalogData, artworkCache, artistCatalog);

  applyOverlayContent(payload, elements, artworkCache, scrollContainer, panel);

  if (animate) {
    await crossfadeOverlayContent(payload, elements, OVERLAY_CROSSFADE_MS, 'forward', scrollContainer, panel);
  } else {
    await crossfadeOverlayArtwork(
      {
        front: elements.overlayArtworkFront,
        back: elements.overlayArtworkBack,
        fallback: elements.overlayArtworkFallback,
        bgBlur: elements.overlayBgBlur,
        wrapper: elements.overlayArtworkWrapper,
      },
      payload.imgUrl,
      OVERLAY_CROSSFADE_MS,
      'forward',
    );
  }

  initOverlayAlbumArtwork(elements.overlayAlbumsList);
}

function populateTrackList(
  sortedTracks: { name: string; count: number }[] | null,
  overlaySongsList: HTMLElement,
): void {
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

  overlaySongsList.innerHTML = sortedTracks
    .map((track, idx) =>
      generateScrobbleRowHTML(
        {
          type: 'track',
          id: 0,
          rank: idx + 1,
          name: track.name,
          subtitle: '',
          imgUrl: null,
          count: track.count,
          showThumb: false,
        },
        true,
      ),
    )
    .join('');
}

function populateAlbums(
  type: string,
  albumsToRender: { id: number; name: string; scrobbles: number }[],
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
  overlayAlbumsHeader.textContent = type === 'artist' ? 'Albums' : 'Other Albums by this Artist';

  overlayAlbumsList.innerHTML = albumsToRender
    .map((alb) => {
      const albImg = getArtworkUrl('album', alb.name, artistNameForArtworkLookup, alb.name, artworkCache);
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
  onNavigate: (type: string, id: number) => void,
): void {
  panel.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const entity = target.closest('.clickable-entity');
    if (!entity || !panel.contains(entity)) return;

    e.stopPropagation();
    const entityType = entity.getAttribute('data-type');
    const entityId = parseInt(entity.getAttribute('data-id') || '0', 10);
    if (entityType && entityId) {
      onNavigate(entityType, entityId);
    }
  });
}
