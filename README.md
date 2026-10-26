# Music Stats

A static Astro application built from Last.fm listening history. The browser shows a build-time snapshot immediately, then reads verified data from IndexedDB and reconciles complete generations in the background.

## Development and checks

Use Node 22.12 or newer and `npm ci`. Restore the private inputs into `src/data` before building: `scrobbles.csv`, `artwork.json`, and optionally the cached recap metadata and artist overrides. Generated datasets live in `public/data`.

- `npm run dev` — regenerate app metadata and start Astro.
- `npm run build` — process inputs, enrich metadata/media when credentials exist, and build.
- `npm run build:offline` — run the complete build using local inputs without provider requests or color downloads.
- `npm run check` — Astro/TypeScript checks.
- `npm run check:data` — verify all published hashes, immutable bodies, entity references, and daily/year totals.
- `npm test` — isolated album/attribution and ingestion regressions; no provider credentials required.
- `npx playwright install chromium`, then `npm run test:browser` — cold/slow startup, refresh, storage failure, races, bounded scrolling, filter preservation, detail cleanup, offline launch, and service-worker update regressions.
- `npx playwright install webkit`, then `npm run test:mobile -- http://<LAN-address>:4321` — Safari touch checks against an already running Astro dev server. This deliberately tests plain HTTP without Web Crypto. Set `MOBILE_BROWSER=chromium` and optionally `BENCH_BROWSER_CHANNEL=msedge` to use Chromium instead.
- `npm run bench -- --repeat=3` — performance checks against the tracked baseline. Set `BENCH_BROWSER_CHANNEL=msedge` to use an installed Edge browser. Frame budgets account for display cadence; first-movement latency starts at the click that opens the sheet, excluding automation setup and press duration.

Browser regressions build into a temporary directory, use synthetic update data in isolated browser profiles, and write results to `Verification/Runtime/regressions.json`. They do not alter account history or deploy anything.

An iPhone opening the dev server through its LAN HTTP address lacks Web Crypto even though desktop `localhost` provides it. SHA-256 verification uses the native API when available and a matching JavaScript implementation otherwise; integrity checks remain enabled. The browser suite includes touch flows over a LAN HTTP origin, and the separate mobile command checks the actual dev server. Stories open from their small recap payload and enrich artwork/colors afterward. Failed detail loads retain the sheet and expose a retry action.

Mobile checks also cover sheet spacing/overflow, forward and back motion frames, text retention through swipe dismissal, press feedback, draggable segmented controls, gesture cancellation, rapid navbar retargeting, and status-bar color synchronization. See [the motion notes](Verification/Runtime/MobileMotion.md) for the lifecycle decisions and test limits. The performance suite includes internal sheet navigation and uses real touch input for dismissal.

## Runtime ownership

- `bootSnapshot.ts` runs at build time. It embeds useful text/lists and compact core JSON in the page. Artwork and colors do not block text rendering.
- `dataStore.ts` owns the published generation and generation-scoped pending reads. It prepares replacements before publication, coalesces view notifications, and returns explicit refresh outcomes. An older read cannot overwrite a newer snapshot.
- `dataRepository.ts` runs in `dataSync.worker.ts`. One hash-keyed queue deduplicates downloads, prioritizes core data, verifies SHA-256, reads/writes IndexedDB, and merges shards. Immutable URLs identify exact bytes. Detail requests return only the selected entity and related albums; the complete catalog stays in the worker. Unsupported-worker browsers use the same repository with cooperative yields.
- `analytics.worker.ts` handles aggregation, filtering, and sorting separately from download/merge work and artwork encoding. Query snapshots and counts have bounded caches. The main thread renders bounded view windows and handles input/animation.
- `infiniteScroll.ts` keeps a measured window and spacers, in either axis. Controllers disconnect observers/listeners and cancel artwork work on destruction. Rank lists retain at most 150 rows; recent/detail lists use smaller windows.
- IndexedDB writes resolve on transaction completion and reject on failure. A memory-only session can still update correctly, but never claims persistent completeness. Garbage collection retains three generations and unexpired client/staging leases.
- `src/service-worker.js` is the editable service-worker source; `scripts/generate-sw.js` emits `public/sw.js`. Critical shell/bundle precaching must succeed before installation. A new controller waits for existing clients to close; live data refreshes remain independent of application-code updates.

Refresh checks run on reconnect, foreground resume/pageshow, every five foreground minutes, and pull-to-refresh. Failed reads can retry without recreating the document. Remote manifests cannot silently downgrade the active generation.

## Ingestion and deployment

The workflow runs at **00:00, 06:00, 12:00, and 18:00 UTC**, plus pushes to main and manual dispatches. GitHub scheduling is best effort. Publication runs are serialized.

Ingestion fixes the upper timestamp before paginating. API errors, malformed pages, incomplete counts, and suspicious large reductions fail before replacing the original CSV. The last valid CSV is copied to `.previous`; successful replacements use an atomic rename. R2 upload rotates 28 backup slots and occurs only after code, artifact, and browser regression checks pass. Restore errors fail the job instead of silently rebuilding from an incomplete input.

A verified deletion of more than half a substantial overlap window requires `ALLOW_HISTORY_REDUCTION=1`; inspect the account and backup before using it. Media enrichment precedes the final metadata materialization, so playtime and recap outputs use the same duration cache. Set `RECAP_TIMEZONE` to change recap-local calendar grouping; daily aggregate/report windows use UTC.

Application-code updates in an already installed PWA become active when existing clients close. Data generations update in the running app without a restart. Physical iPhone/Safari checks remain useful for gestures, memory pressure, and platform-specific lifecycle behavior.
