# Changelog

## v1.5.0

Download speed is the headline. Chrome allows only six concurrent HTTP/1.1
connections per *origin*, and BookWalker's page CDN is a single HTTP/1.1 host, so
a page lane alone is pinned at 6 for the whole run. v1.5.0 treats every extra
origin it can reach as another socket pool and spreads the download across all of
them, then reassembles the pages about twice as fast on the way out.

### Added

- **Transport lanes.** Requests are dispatched to the least-utilised lane, and
  every lane is measured so the run log shows what each one actually carried:
  - **page** — the page's own `fetch()` (6 sockets).
  - **gm** — `GM_xmlhttpRequest`, which runs in Tampermonkey's background context
    and keeps its own pool (6 more).
  - **dot** — a trailing-dot host (`cdn.example.jp.`), which Chrome treats as a
    separate site and therefore a separate pool (6 more). Self-verifying: it
    enables only when a real page returns 200 through it, so a refusal costs one
    request.
  - **px:N** — one lane per fetch-proxy port exposed by mokuro-bridge. A port is
    part of the origin, so each is a fresh 6-socket pool; this is the lane that
    scales, and the source of the "294 sockets" figure below.
  - **edge** — an optional HTTP/2 mirror lane, strictly opt-in because it routes
    the signed URL through a third party.
- **Live connection readout.** The **?** beside the bridge row reports how many
  ports, sockets and decode workers the next run will use, and explains where the
  numbers come from. It works with the bridge down, saying so plainly.
- **Image format picker.** JPEG (default, q0.92), WebP, lossless or PNG, behind a
  collapsed **Image format** row that shows the active setting. Quality is hidden
  for the lossless settings rather than offered pointlessly.
- **Prefetch window tied to the real socket budget.** The old fixed clamp of 64
  meant that with 32 proxy ports — 192 available sockets — only 64 requests could
  ever be in flight.

### Changed

- **Descrambling is ~2× faster** (100 → 208 pages/s on a 14-core machine).
  Profiling showed 83% of the cost was JPEG decode and encode, not the tile
  copy, so tiles are now drawn straight onto the output canvas instead of being
  read back and written out through `getImageData`/`putImageData`. Output is
  byte-identical to the previous descrambler across six tile geometries.
- **Worker pool sizing** is derived from the CPU count by one shared helper,
  raised from a cap of 24 to 32.
- **A failed helper port is parked, not deleted.** A wide burst can fail every
  port at once, and deleting them cascaded into a total collapse back onto the
  page lane.

### Fixed

- **The GM lane never worked.** `@connect` listed only the reading-stats hosts,
  not the page CDN, so every `GM_xmlhttpRequest` was refused and the lane was
  dead weight. Both the CDN and `*.bookwalker.jp` are now declared. Tampermonkey
  captures grants at install time, so this needs a reinstall rather than an
  update.
- **The bridge row claimed "online" with no bridge running.** The health check
  forgives missed polls so the OCR button does not flap, which meant a cold page
  load advertised "Mokuro online" for the first couple of polls. Misses are now
  forgiven only once the bridge has answered at least once.
- **Tooltips were cut off.** The `?` popovers opened from inside the scrolling
  panel column, whose `overflow` clipped them — the bridge popover is taller than
  the column it lives in. They are now positioned against the viewport, so they
  extend past their card instead of being truncated, and flip above the anchor
  when there is no room below.
- **Port discovery re-probed a dead helper.** With no bridge running, the panel
  issued two extra requests to a closed port every ten seconds, each of which the
  browser logs as a console error.
- **The socket readout contradicted itself**, quoting "6 connections" beside a
  count that already included the GM lane. It now derives both from one number.
- **Version drift.** The panel reported a hardcoded version instead of the one
  the userscript manager has installed.

### Performance

Measured on a 1600×2400 manga page with 70 tiles, 14 cores:

| | before | after |
| --- | --- | --- |
| Descramble | 100 pages/s | **208 pages/s** |
| Concurrent sockets, bridge up | 6 | **294** |
| Concurrent sockets, bridge down | 6 | 12–18 |

A full-volume download with no bridge at all now runs across the page, GM and
trailing-dot lanes at once, and gains the remaining ~280 sockets as soon as
mokuro-bridge is started.
