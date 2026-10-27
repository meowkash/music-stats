import assert from 'node:assert/strict';
import { pickBest, scoreCandidate } from './resolve-artwork/score.js';
import { albumGroupingKey, normalizeForCompare } from './resolve-artwork/normalize.js';
import { resolveArtwork } from './resolve-artwork/index.js';
import { harvestScrobbleArtwork, resolveArtistArtworkFromCache, sanitizeArtistArtwork, storeArtworkInCache } from './artwork-keys.js';
import { createAlbumGroups } from './album-groups.js';
import { resolveArtistArtwork, resolveTrackArtwork } from '../src/utils/artwork.ts';

// Offline: store responses are canned, so these pin the matching rules
// themselves rather than whatever a catalog returns today.
const evidence: string[] = [];
const accepted = (query: Record<string, unknown>, candidate: Record<string, unknown>) => scoreCandidate(query, candidate).accepted;

// 1. A different artist or release that merely contains the words is not a match.
assert.equal(accepted({ name: 'Drake', artistName: '' }, { name: 'Drake Bell', artistName: 'Drake Bell' }), false);
assert.equal(accepted({ name: 'Queen', artistName: '' }, { name: 'Queen Naija', artistName: 'Queen Naija' }), false);
assert.equal(pickBest({ name: 'Drake' }, [{ name: 'Drake Bell', artistName: 'Drake Bell', url: 'a' }, { name: 'Drake', artistName: 'Drake', url: 'b' }])?.url, 'b');
assert.equal(accepted({ kind: 'album', name: 'Love', artistName: 'Ed Sheeran' }, { name: 'Love Songs: Greatest Hits', artistName: 'Ed Sheeran' }), false);
assert.equal(accepted({ kind: 'album', name: 'Fast', artistName: 'Demi Lovato' }, { name: 'Fast - Single', artistName: 'Demi Lovato' }), true, 'One song played: it may well be the single');
assert.equal(accepted({ kind: 'album', multiTrack: true, name: 'Tell Me You Love Me', artistName: 'Demi Lovato' }, { name: 'Tell Me You Love Me - Single', artistName: 'Demi Lovato' }), false, 'An album must not take a single\'s cover');
// Guests and editions are still the same release.
assert.equal(accepted({ kind: 'album', name: 'Views', artistName: 'Drake' }, { name: 'Views', artistName: 'Drake & Future' }), true);
assert.equal(accepted({ kind: 'album', name: 'Fifty Shades Darker (Original Motion Picture Soundtrack)', artistName: 'ZAYN' }, { name: 'Fifty Shades Darker', artistName: 'ZAYN' }), true);
evidence.push('Lookalike artists and titles are rejected; guests and editions still match');

// 2. Compilations are credited to Various Artists in stores.
assert.equal(accepted({ kind: 'album', name: 'Cradle 2 The Grave (Original Soundtrack)', artistName: 'Eminem', compilation: true }, { name: 'Cradle 2 The Grave (Soundtrack)', artistName: 'Various Artists' }), true);
assert.equal(accepted({ kind: 'album', name: 'Cradle 2 The Grave (Original Soundtrack)', artistName: 'Eminem' }, { name: 'Cradle 2 The Grave (Soundtrack)', artistName: 'Various Artists' }), false, 'Various Artists only stands in for a compilation');
assert.equal(accepted({ kind: 'album', name: 'Shrek (Original Motion Picture Soundtrack)', artistName: 'Smash Mouth', compilation: true }, { name: 'Shrek 2 (Original Motion Picture Soundtrack)', artistName: 'Various Artists' }), false);
assert.equal(accepted({ kind: 'album', name: 'Abbey Road', artistName: 'The Beatles' }, { name: 'Abbey Road (Remastered 2019)', artistName: 'The Beatles' }), true);
assert.equal(accepted({ kind: 'album', name: 'Ultimate R&B Love 2012', artistName: 'Dev', compilation: true }, { name: 'Ultimate R&B Love 2013', artistName: 'Various Artists' }), false);
assert.equal(accepted({ kind: 'album', name: 'blink-182', artistName: 'blink-182' }, { name: 'Blink 182', artistName: 'Blink-182' }), true);
evidence.push('Compilations match their Various Artists listing, and only their own; sequels and yearly editions stay apart');

// 3. End to end with canned stores: GTA VI is buried in fan singles; the real
//    soundtrack is found through one of its songs, or its VA listing.
const GTA = 'Grand Theft Auto VI (Official Soundtrack)';
const junk = [
  { collectionName: 'Grand Theft Auto VI (Gta 6) [feat. Angus Mackie] - Single', artistName: 'Justin J', artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/junk1/100x100bb.jpg' },
  { collectionName: 'Grand Theft Auto - Single', artistName: 'DJ TikTok', artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/junk2/100x100bb.jpg' },
];
const realFetch = globalThis.fetch;
async function withStores(stores: { albums?: object[]; songs?: object[] }, run: () => Promise<void>) {
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.hostname === 'itunes.apple.com') return Response.json({ results: url.searchParams.get('entity') === 'song' ? stores.songs ?? [] : stores.albums ?? [] });
    if (url.hostname === 'api.deezer.com') return Response.json({ data: [] });
    if (url.hostname === 'musicbrainz.org') return Response.json({ 'release-groups': [] });
    throw new Error(`Unexpected request ${url}`);
  }) as typeof fetch;
  try { await run(); } finally { globalThis.fetch = realFetch; }
}
const gta = { type: 'album', name: GTA, artistName: 'Tyla', tracks: [{ name: 'Water', artistName: 'Tyla' }] };
await withStores({ albums: junk }, async () => {
  assert.equal(await resolveArtwork(gta, {}), null, 'Fan singles must never become the soundtrack cover');
});
await withStores({ albums: junk, songs: [{ trackName: 'Water', artistName: 'Tyla', collectionName: GTA, artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/gta6/100x100bb.jpg' }] }, async () => {
  const found = await resolveArtwork(gta, {});
  assert.equal(found?.via, 'compilation-track'); assert.match(found!.url, /gta6/);
});
await withStores({ albums: [...junk, { collectionName: GTA, artistName: 'Various Artists', artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/gta6va/100x100bb.jpg' }] }, async () => {
  const found = await resolveArtwork(gta, {});
  assert.equal(found?.via, 'compilation'); assert.match(found!.url, /gta6va/);
});
// The song search must be about this album: the same song on another release is not it.
await withStores({ songs: [{ trackName: 'Water', artistName: 'Tyla', collectionName: 'TYLA', artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/tyla/100x100bb.jpg' }] }, async () => {
  assert.equal(await resolveArtwork(gta, {}), null);
});
evidence.push('GTA VI-style soundtracks resolve through their songs or VA listing, never to fan singles');

// 4. Titles in any script, or made of symbols, are distinct albums.
assert.notEqual(albumGroupingKey('Ed Sheeran', '+'), albumGroupingKey('Ed Sheeran', '='));
assert.notEqual(albumGroupingKey('Ed Sheeran', '='), albumGroupingKey('Ed Sheeran', '÷'));
assert.notEqual(albumGroupingKey('Артём Качер', 'Голая - Single'), albumGroupingKey('Артём Качер', 'Худшая - Single'));
assert.notEqual(albumGroupingKey('Асия', 'Худшая - Single'), albumGroupingKey('Артём Качер', 'Худшая - Single'));
assert.equal(normalizeForCompare('Beyoncé & Jay-Z'), 'beyonce and jay z');
const group = createAlbumGroups([
  { artist: 'Ed Sheeran', album: '=', track: 'Bad Habits' },
  { artist: 'Ed Sheeran', album: '+', track: 'Grade 8' },
  { artist: 'Ed Sheeran', album: '÷', track: 'Shape of You' },
], { singleEntities: [], aliases: {} });
assert.equal(new Set(['=', '+', '÷'].map(album => group('Ed Sheeran', album))).size, 3);
evidence.push('Non-Latin and symbol-only titles no longer merge into one album');

// 5. A compilation's cover is never a performer's artist image.
const cache: Record<string, string> = {};
storeArtworkInCache(cache, 'album', 'Fifty Shades Darker (Original Motion Picture Soundtrack)', 'ZAYN', 'https://x/fifty.jpg');
assert.equal(cache['artist:ZAYN'], undefined);
assert.equal(resolveArtistArtworkFromCache('ZAYN', cache), null);
storeArtworkInCache(cache, 'album', 'Hannah Montana 2 (Original Soundtrack)', 'Hannah Montana', 'https://x/hm.jpg');
assert.equal(cache['artist:Hannah Montana'], 'https://x/hm.jpg', 'A title naming the artist is theirs');
storeArtworkInCache(cache, 'album', 'Mind of Mine', 'ZAYN', 'https://x/mind.jpg');
assert.equal(resolveArtistArtworkFromCache('ZAYN', cache), 'https://x/mind.jpg');
// Entries promoted before this rule are cleared.
const legacy: Record<string, string> = {
  'album:Fifty Shades Darker (Original Motion Picture Soundtrack)|ZAYN': 'https://x/fifty.jpg',
  'artist:ZAYN': 'https://x/fifty.jpg', ZAYN: 'https://x/fifty.jpg',
  'album:Hannah Montana 2 (Original Soundtrack)|Hannah Montana': 'https://x/hm.jpg', 'artist:Hannah Montana': 'https://x/hm.jpg',
  'artist:Taylor Swift': 'https://x/taylor.jpg',
};
assert.equal(sanitizeArtistArtwork(legacy), 1);
assert.equal(legacy['artist:ZAYN'], undefined); assert.equal(legacy.ZAYN, undefined);
assert.equal(legacy['artist:Hannah Montana'], 'https://x/hm.jpg'); assert.equal(legacy['artist:Taylor Swift'], 'https://x/taylor.jpg');
// The client's fallback index follows the same rule.
const client = { 'album:Fifty Shades Darker (Original Motion Picture Soundtrack)|ZAYN': 'https://x/fifty.jpg' };
assert.equal(resolveArtistArtwork('ZAYN', client), null);
assert.equal(resolveTrackArtwork('I Don\'t Wanna Live Forever', 'ZAYN', 'Fifty Shades Darker (Original Motion Picture Soundtrack)', client), 'https://x/fifty.jpg', 'Songs on it still use the cover');
evidence.push('Compilation covers stay on the release: never promoted to, or shown as, a performer');

// 6. A scrobble's image fills gaps; it never replaces a validated cover.
const harvested: Record<string, string> = { 'album:Mind of Mine|ZAYN': 'https://x/validated.jpg' };
harvestScrobbleArtwork(harvested, { trackName: 'Pillowtalk', artistName: 'ZAYN', albumName: 'Mind of Mine', url: 'https://x/lastfm.jpg' });
assert.equal(harvested['album:Mind of Mine|ZAYN'], 'https://x/validated.jpg');
assert.equal(harvested['track:Pillowtalk|ZAYN'], 'https://x/lastfm.jpg');
harvestScrobbleArtwork(harvested, { trackName: 'Dusk Till Dawn', artistName: 'ZAYN', albumName: 'Icarus Falls', url: 'https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png' });
assert.equal(harvested['album:Icarus Falls|ZAYN'], undefined, 'The placeholder star is not artwork');
evidence.push('Scrobble images fill gaps only and never store the Last.fm placeholder');

console.log('Artwork matching checks passed:', evidence);
