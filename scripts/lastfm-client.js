/**
 * Shared Last.fm access: .env loading, a paced GET, and error classification.
 * Used by enrich-recap-meta.js (and safe for any other build-time fetcher).
 */
import fs from 'fs';
import path from 'path';

export function loadEnv() {
  const envPath = path.resolve('.env');
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
    // Real environment wins, so CI secrets are never clobbered by a stale .env.
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

/** Last.fm error 6 = "no such track/artist" — a real answer, not a failure to retry. */
const NOT_FOUND = 6;

export class LastfmNotFound extends Error {}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Last.fm's published ceiling is 5 requests/second/key. One shared gate keeps
 * every caller under it regardless of how many request sites there are.
 */
export function createLastfmClient({ apiKey, minIntervalMs = 210, maxRetries = 4 }) {
  let nextSlot = 0;

  async function takeSlot() {
    const now = Date.now();
    const wait = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + minIntervalMs;
    if (wait > 0) await delay(wait);
  }

  return async function get(params) {
    const qs = new URLSearchParams({ ...params, api_key: apiKey, format: 'json' });
    const url = `https://ws.audioscrobbler.com/2.0/?${qs}`;

    for (let attempt = 0; ; attempt++) {
      await takeSlot();
      try {
        const res = await fetch(url);
        if (res.status === 429 || res.status >= 500) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json();
        if (data.error === NOT_FOUND) {
          throw new LastfmNotFound(data.message || 'not found');
        }
        if (data.error) throw new Error(data.message || `Last.fm error ${data.error}`);
        return data;
      } catch (err) {
        if (err instanceof LastfmNotFound || attempt >= maxRetries) throw err;
        // Exponential backoff; a rate-limit or blip must not burn the entry.
        await delay(600 * 2 ** attempt);
      }
    }
  };
}
