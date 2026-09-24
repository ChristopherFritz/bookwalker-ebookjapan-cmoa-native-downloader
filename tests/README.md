# Tests

Browser-driven checks for `bookwalker-native-downloader.user.js`. The default
suite loads the userscript into headless Chrome against local stub servers; the
live bridge check is opt-in.

```sh
npm install          # puppeteer
npm run browser      # one-time Chrome download for puppeteer
npm test             # hermetic tests
npm test -- lane     # only files whose name contains "lane"
npm run test:bridge  # opt-in live bridge check (needs ~/Projects/mokuro-bridge)
```

Each script prints `ALL n CHECKS PASSED` on success and exits non-zero
otherwise, so they work individually (`node tests/test_lanes.js`) or via
`npm test`.

| File | Covers |
| --- | --- |
| `test_lanes.js` | lane balance, GM fallback, 403 recovery, inflight de-dupe |
| `test_dot_lane.js` | trailing-dot lane probing and fallback |
| `test_edge_lane.js` | HTTP/2 edge mirror lane |
| `test_proxy_parking.js` | helper-port parking and recovery after cooldown |
| `test_descramble_equivalence.js` | descrambled output is byte-identical to reference |
| `test_image_codec.js` | format/quality resolution, emitted type, extension |
| `test_ui_panel.js` | panel readout, popovers, format picker and link |
| `test_bridge_e2e.js` | opt-in live mokuro-bridge check (`:62642`) |

`tests/tls/` holds a self-signed localhost certificate, used so the page can
serve HTTPS (a secure context) while local stub servers stay on HTTP.
