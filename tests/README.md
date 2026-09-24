# Tests

Browser-driven checks for `bookwalker-native-downloader.user.js`. Each file is a
standalone Node script that loads the userscript into headless Chrome against
local stub servers, so nothing here touches BookWalker or the network.

```sh
npm install          # puppeteer
npm run browser      # one-time Chrome download for puppeteer
npm test             # all files
npm test -- lane     # only files whose name contains "lane"
```

Each script prints `ALL n CHECKS PASSED` on success and exits non-zero
otherwise, so they work individually (`node tests/test_lanes.js`) or via
`npm test`.

| File | Covers |
| --- | --- |
| `test_lanes.js` | lane balance, GM fallback, 403 recovery, inflight de-dupe |
| `test_dot_lane.js` | trailing-dot lane probing and retirement |
| `test_edge_lane.js` | HTTP/2 edge mirror lane |
| `test_proxy_parking.js` | helper-port parking and retirement under burst |
| `test_descramble_equivalence.js` | descrambled output is byte-identical to reference |
| `test_image_codec.js` | format/quality resolution, emitted type, extension |
| `test_ui_panel.js` | panel readout, popovers, format picker, dark mode |
| `test_bridge_e2e.js` | needs a live mokuro-bridge on :62642 |

`tests/tls/` holds a self-signed localhost certificate, used so the page can
serve HTTPS (a secure context) while local stub servers stay on HTTP.
