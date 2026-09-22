# Benchmarks

Drives the real built app against the real data set in headless Chromium and
records frame pacing, so a change that makes a gesture stutter fails here rather
than on your phone after a deploy.

```sh
npm run build      # bench reads dist/, so build first
npm run bench      # compare against bench/baseline.json; exits 1 on a regression
npm run bench:update   # accept current numbers as the new baseline
```

Flags: `--only=<substring>` to filter scenarios, `--repeat=N` (default 3, the
median is reported), `--headed` to watch it run, `--json` to dump the record.

Every run writes `bench/records/<timestamp>.json` (gitignored). `baseline.json`
is tracked — that is the time record a regression is measured against.

## What is measured

`p95Frame` is the headline. A gesture is judged by its worst frames, not its
average, so p95 and `stalls` (frames over 50ms) matter more than `p50Frame`.

`timeToFirstMove` is specific to the detail sheet: milliseconds from tap to the
first frame where the panel's transform actually differs from where it sat. It
exists because the sheet's original implementation awaited the entity's list
build *and* its hero artwork download before starting the entrance, so the panel
sat still for as long as the network took. Guard rails on p95 alone never caught
that — the frames were fine, there just weren't any for a few seconds.

For reference, on the implementation that shipped before this suite existed:

| scenario | firstMove |
| --- | --- |
| `sheet-open-warm` | 265 ms |
| `sheet-open-cold-artwork` | 3450 ms |

Both now sit around 30 ms.

## Scenarios

| name | what it covers |
| --- | --- |
| `boot-cold` | First ever load, empty IndexedDB |
| `boot-warm` | Return visit, generation already stored |
| `sheet-open-warm` | Sheet opens with data in memory |
| `sheet-open-during-sync` | Sheet opens while the backfill worker is downloading |
| `sheet-open-cold-artwork` | Sheet opens on a deep row whose artwork is not cached, over a slow network |
| `sheet-dismiss` | Swipe-down dismiss |
| `tab-swipe` | Across all four tabs |
| `leaderboard-scroll` | Fling the rankings list |

Two details keep these honest and worth understanding before adding more:

- **The artwork CDN is always stubbed** (`stubArtworkCdn` in `run.js`), serving a
  1×1 PNG after a per-scenario delay. Without it the benchmark either depends on
  the open internet or, worse, fails instantly — which makes a code path that
  blocks on a network fetch look fast.
- **Rankings is driven at All Time**, not the default 7-day window. That window
  is empty whenever the newest scrobble is older than a week, and an empty board
  benchmarks nothing.

## Data pipeline

Reported before the browser scenarios, from `data-bench.js`:

- **parse / merge per dataset** — main-thread cost of reassembling shards on
  every boot. A budget, not a curiosity.
- **delta/oneArtist, delta/fewArtists, delta/varied** — bytes a returning
  client downloads after a day of new scrobbles, for three listening shapes.
  Catalog shards are placed by *canonical artist*, so an artist's tracks,
  albums and aliases move together and the delta tracks how many distinct
  artists a day touches.

  | shape | shards | delta |
  | --- | --- | --- |
  | `oneArtist` (182 plays, 1 artist) | 1/64 | 82 KB |
  | `fewArtists` (40 plays, 5 artists) | 5/64 | 353 KB |
  | `varied` (40 plays, 40 artists) | 30/64 | 1642 KB |

  Placing by track id instead put `oneArtist` at **62/64 shards, 3280 KB** —
  that gap is what the grouping buys. `varied` is the ceiling: grouping cannot
  help a day that genuinely touches 40 unrelated artists, so it sitting near
  50% is expected. The first two climbing is the signal that something broke.

## Budgets

`BUDGETS` in `run.js` gates each metric on `max(baseline * tolerance, floor)`.
The floor stops a metric that is small in absolute terms from failing on a large
relative swing — 2 ms to 4 ms is noise. Tolerances are deliberately loose;
frame pacing on a busy laptop is noisy, and a suite that cries wolf gets
ignored. Re-baseline on the same machine, otherwise the numbers move for
reasons that have nothing to do with the code.
