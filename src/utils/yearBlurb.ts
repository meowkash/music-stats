import { escapeHTML } from './ui';

export interface YearStory {
  year: string;
  html: string;
}

type YearStats = {
  tracks?: [number, number][];
  albums?: [number, number][];
  artists?: [number, number][];
};

interface MetaLike {
  artists?: string[];
  albums?: string[];
  tracks?: [string, number, number, number?][];
  canonicalArtists?: string[];
}

function pick(stats: YearStats | undefined, key: keyof YearStats): [number, number] | null {
  const row = stats?.[key]?.[0];
  return row ? row : null;
}

function trackName(meta: MetaLike, id: number): { name: string; artistName: string } {
  const row = meta.tracks?.[id];
  if (!row) return { name: 'an unnamed track', artistName: 'someone' };
  return {
    name: row[0].trim(),
    artistName: (meta.artists?.[row[1]] || 'someone').trim(),
  };
}

function albumName(meta: MetaLike, id: number, albumToArtist: Map<number, number>): { name: string; artistName: string } {
  return {
    name: (meta.albums?.[id] || 'an unnamed album').trim(),
    artistName: (meta.artists?.[albumToArtist.get(id) ?? -1] || 'someone').trim(),
  };
}

function artistName(meta: MetaLike, id: number): string {
  return (meta.canonicalArtists?.[id] || meta.artists?.[id] || 'a mystery artist').trim();
}

function article(name: string): string {
  return /^[aeiou]/i.test(name) ? 'an' : 'a';
}

function entity(type: string, id: number, catalog: string | undefined, label: string, accent = ''): string {
  const catalogAttr = catalog ? ` data-artist-catalog="${catalog}"` : '';
  const styleAttr = accent ? ` style="${accent}"` : '';
  return `<span class="clickable-entity year-story-${type === 'track' ? 'song' : type}" data-type="${type}" data-id="${id}"${catalogAttr}${styleAttr}>${escapeHTML(label)}</span>`;
}

function yearMark(year: string, color: string): string {
  return `<span class="year-story-year-inline" style="color:${color}">${escapeHTML(year)}</span>`;
}

function plays(n: number): string {
  return n.toLocaleString();
}

export function buildYearStory(
  year: string,
  stats: YearStats | undefined,
  meta: MetaLike,
  albumToArtist: Map<number, number>,
  yearColor = '#ffffff',
  accents: { artist?: string; track?: string; album?: string } = {},
): YearStory {
  const topTrack = pick(stats, 'tracks');
  const topAlbum = pick(stats, 'albums');
  const topArtist = pick(stats, 'artists');

  const track = topTrack ? { ...trackName(meta, topTrack[0]), plays: topTrack[1], id: topTrack[0] } : null;
  const album = topAlbum
    ? { ...albumName(meta, topAlbum[0], albumToArtist), plays: topAlbum[1], id: topAlbum[0] }
    : null;
  const artist = topArtist
    ? { name: artistName(meta, topArtist[0]), plays: topArtist[1], id: topArtist[0] }
    : null;

  const y = yearMark(year, yearColor);
  const seed = Number(year) % 6;
  const artistLink = artist ? entity('artist', artist.id, 'canonicalArtists', artist.name, accents.artist) : '';
  const trackLink = track ? entity('track', track.id, undefined, track.name, accents.track) : '';
  const albumLink = album ? entity('album', album.id, undefined, album.name, accents.album) : '';

  const artistBit = artist
    ? [
        `${y} belonged to ${artistLink}.`,
        `If ${y} had a face, it would be ${artistLink}.`,
        `${y} was ${article(artist.name)} ${artistLink} year, no notes.`,
        `I spent ${y} in the general vicinity of ${artistLink}.`,
        `${artistLink} ran the place in ${y}.`,
        `${y} had a house artist, and it was ${artistLink}.`,
      ][seed]
    : `${y} happened. The artists involved have requested privacy.`;

  const trackBit = track
    ? [
        `I played ${trackLink} ${plays(track.plays)} times — at some point that is just a personality trait.`,
        `${trackLink} got ${plays(track.plays)} spins. ${escapeHTML(track.artistName)} can probably hear it from here.`,
        `Most-played song: ${trackLink}, ${plays(track.plays)} times. I am not taking questions.`,
        `${trackLink} was on loop for ${plays(track.plays)} plays, which is either dedication or a cry for help.`,
        `${plays(track.plays)} plays of ${trackLink} later, I still was not done.`,
        `The song of the year, statistically and emotionally: ${trackLink} (${plays(track.plays)} plays).`,
      ][seed]
    : `No song quite won the year. A rare show of restraint.`;

  const albumBit = album
    ? [
        `The record I would not put down was ${albumLink} (${plays(album.plays)} plays).`,
        `${albumLink} lived on the turntable for ${plays(album.plays)} plays. I am not sorry.`,
        `If there was a house album, it was ${albumLink} — ${plays(album.plays)} plays says so.`,
        `I kept putting ${albumLink} back on, ${plays(album.plays)} times, like it owed me rent.`,
        `${albumLink} got ${plays(album.plays)} plays and earned every one of them.`,
        `Most-spun record: ${albumLink}. ${plays(album.plays)} plays. The neighbors know.`,
      ][seed]
    : `No album ran away with it. Variety, allegedly.`;

  return {
    year,
    html: `<p>${artistBit} ${trackBit} ${albumBit}</p>`,
  };
}
