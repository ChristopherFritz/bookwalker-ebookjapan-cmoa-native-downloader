#!/usr/bin/env node
'use strict';
/*
 * CMOA adapter test.
 *
 * Loads the real userscript on a synthetic cmoa.jp speed-reader page with a
 * fake SpeedBinb viewer, a fake content-info API and a fake image CDN, then
 * drives the shared panel's "Save as ZIP" button and inspects the archive.
 *
 * What this covers that the BookWalker tests cannot:
 *   - host-based adapter detection (the page is served as www.cmoa.jp)
 *   - the shared panel branding for the second store
 *   - clean-title extraction (SubTitle, not the store's SEO page title)
 *   - shared archive naming, so both stores name files the same way
 *   - the quality/token retry ladder (q=0 is refused, q=1 must be used)
 *   - tile descrambling, verified pixel-by-pixel out of the produced ZIP
 *   - flat page-NNNN.ext archive entries
 *
 * The image CDN is cross-origin (akamaized.net), so this also proves the
 * fetch fallback path works when GM_xmlhttpRequest is not granted (which is the
 * case for an injected script; in Tampermonkey the GM path is used instead).
 */
const puppeteer = require('puppeteer');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const US = path.resolve(__dirname, '..', process.env.BWDD_US || 'omnimanga-native-downloader.user.js');

const CID = '0000249510_jp_0001';
const CDN = 'https://free-binb-cmoa.akamaized.net/sbc';
const MESSY_TITLE = '無料・試し読みページ スーパーの裏でヤニ吸うふたり 1巻（ビッグガンガンコミックス） ｜ 地主 ｜ 漫画（マンガ）・電子書籍のコミックシーモア';
const CLEAN_TITLE = 'スーパーの裏でヤニ吸うふたり 1巻';
const EXPECTED_ARCHIVE = 'スーパーの裏でヤニ吸うふたり 1巻';

// 240x240 page, four 120x120 tiles.
const SIZE = 240;
const HALF = SIZE / 2;
const PAGES = 3;

// Positions in the SCRAMBLED source, and where they must land afterwards.
// getImageDescrambleCoords below swaps left/right and top/bottom, so a correct
// descramble turns the scrambled arrangement back into the original one.
//   scrambled: TL=green TR=red  BL=yellow BR=blue
//   original : TL=red   TR=green BL=blue   BR=yellow
function tileColors(pageIdx) {
    const shift = pageIdx * 50;
    const at = v => Math.max(0, Math.min(255, v));
    return {
        red: { r: at(220 - shift), g: at(30 + shift), b: 40 },
        green: { r: 30, g: at(200 - shift), b: at(60 + shift) },
        blue: { r: at(40 + shift), g: 60, b: at(220 - shift) },
        yellow: { r: at(230 - shift), g: at(210 - shift), b: 30 },
    };
}

async function buildScrambled(pageIdx) {
    const c = tileColors(pageIdx);
    const tile = (color) => sharp({
        create: { width: HALF, height: HALF, channels: 3, background: color },
    }).png().toBuffer();
    const [green, red, yellow, blue] = await Promise.all([
        tile(c.green), tile(c.red), tile(c.yellow), tile(c.blue),
    ]);
    return sharp({
        create: { width: SIZE, height: SIZE, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
        .composite([
            { input: green, left: 0, top: 0 },
            { input: red, left: HALF, top: 0 },
            { input: yellow, left: 0, top: HALF },
            { input: blue, left: HALF, top: HALF },
        ])
        .jpeg({ quality: 100 })
        .toBuffer();
}

// The viewer's own API is the only correct way to unshuffle a page, so the fake
// implements the real contract: getImageDescrambleCoords(image, w, h) ->
// { width, height, transfers: [{ index, coords: [{xsrc,ysrc,xdest,ydest,width,height}] }] }
const VIEWER_SETUP = `
window.__requestedQualities = [];
window.__imageHits = [];
const SRC_TO_PAGE = {};
window.__registerPage = function (src, pageNo) { SRC_TO_PAGE[src] = pageNo; };
window.__fakeReader = {
  cid: ${JSON.stringify(CID)},
  requestUrl: location.origin + '/bib/sws/bibGetCntntInfo.php?cid=' + encodeURIComponent(${JSON.stringify(CID)}) + '&dmytime=1790280604161&k=FAKEKEY&u0=1',
  getImageDescrambleCoords: function (image, w, h) {
    const hw = Math.floor(w / 2), hh = Math.floor(h / 2);
    return {
      width: w, height: h,
      transfers: [{ index: 0, coords: [
        { xsrc: hw, ysrc: 0,  xdest: 0,  ydest: 0,  width: hw, height: hh },
        { xsrc: 0,  ysrc: 0,  xdest: hw, ydest: 0,  width: hw, height: hh },
        { xsrc: hw, ysrc: hh, xdest: 0,  ydest: hh, width: hw, height: hh },
        { xsrc: 0,  ysrc: hh, xdest: hw, ydest: hh, width: hw, height: hh }
      ] }]
    };
  }
};
window.__fakeViewer = {
  content: {
    page: window.__PAGES,
    bibliography: { title: document.title, author: '', publisher: '', description: '' }
  },
  get reader() { return window.__fakeReader; }
};
window.SpeedBinb = {
  getInstance: function (id) {
    if (id !== 'content') throw new Error('Element not found: ' + id);
    return window.__fakeViewer;
  }
};
// Capture the ZIP the shared harness hands to the browser.
window.__capturedZip = null;
const __origClick = HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click = function () {
  try {
    if (this.download) {
      const name = this.download;
      const href = this.href;
      fetch(href).then(r => r.arrayBuffer()).then(ab => {
        const bytes = new Uint8Array(ab);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        window.__capturedZip = { name: name, size: bytes.length, b64: btoa(bin) };
      }).catch(e => { window.__capturedZip = { name: name, error: String(e) }; });
      return;
    }
  } catch (e) {}
  return __origClick.apply(this, arguments);
};
`;

function pageHtml(pageSrcs) {
    const pages = pageSrcs.map((src, i) =>
        `{ id: ${JSON.stringify('p' + (i + 1))}, image: { id: ${JSON.stringify('p' + (i + 1))}, src: ${JSON.stringify(src)}, orgwidth: ${SIZE}, orgheight: ${SIZE}, pagespread: 0 } }`
    ).join(',\n      ');
    return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<title>${MESSY_TITLE}</title></head>
<body>
  <div data-ptbinb="/bib/sws/bibGetCntntInfo.php?u0=1" data-ptbinb-cid="${CID}"></div>
  <div id="content"></div>
  <script>
    window.__PAGES = [
      ${pages}
    ];
    ${VIEWER_SETUP}
    window.__PAGES.forEach(function (p, i) { window.__registerPage(p.image.src, i); });
  </script>
</body></html>`;
}

// Store-only ZIP reader (buildStoreZip writes method 0, so sizes are literal).
function readStoreZip(buf) {
    const entries = [];
    let off = 0;
    while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
        const size = buf.readUInt32LE(off + 18);
        const nameLen = buf.readUInt16LE(off + 26);
        const extraLen = buf.readUInt16LE(off + 28);
        const name = buf.slice(off + 30, off + 30 + nameLen).toString('utf8');
        const dataStart = off + 30 + nameLen + extraLen;
        entries.push({ name, data: buf.slice(dataStart, dataStart + size) });
        off = dataStart + size;
    }
    return entries;
}

async function tileCenters(imageBuffer) {
    const { data, info } = await sharp(imageBuffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const ch = info.channels;
    const at = (x, y) => {
        const i = (y * info.width + x) * ch;
        return { r: data[i], g: data[i + 1], b: data[i + 2] };
    };
    const cx = Math.floor(info.width / 4), cy = Math.floor(info.height / 4);
    return {
        width: info.width, height: info.height,
        tl: at(cx, cy),
        tr: at(info.width - cx, cy),
        bl: at(cx, info.height - cy),
        br: at(info.width - cx, info.height - cy),
    };
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;
async function checkTilePositions(imageBuffer, pageIdx) {
    const c = tileColors(pageIdx);
    const got = await tileCenters(imageBuffer);
    const tol = 42;   // JPEG re-encode of flat tiles stays well inside this
    const problems = [];
    const cmp = (label, actual, expected) => {
        if (!near(actual.r, expected.r, tol) || !near(actual.g, expected.g, tol) || !near(actual.b, expected.b, tol)) {
            problems.push(`${label}=(${actual.r},${actual.g},${actual.b}) want (${expected.r},${expected.g},${expected.b})`);
        }
    };
    cmp('TL', got.tl, c.red);
    cmp('TR', got.tr, c.green);
    cmp('BL', got.bl, c.blue);
    cmp('BR', got.br, c.yellow);
    return { ok: problems.length === 0, detail: problems.join('; ') || `tiles reassembled at ${got.width}x${got.height}`, size: got };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    const pageSrcs = Array.from({ length: PAGES }, (_, i) => `pages/page${i + 1}.jpg`);
    const scrambled = await Promise.all(Array.from({ length: PAGES }, (_, i) => buildScrambled(i)));
    const scrambledBySrc = new Map(pageSrcs.map((src, i) => [src, scrambled[i]]));

    const results = [];
    const check = (n, pass, d) => { results.push({ n, pass, d }); console.log((pass ? 'PASS  ' : 'FAIL  ') + n + '  — ' + d); };

    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: true,
        args: ['--no-sandbox', '--ignore-certificate-errors'],
    });
    let page;
    try {
        page = await browser.newPage();
        page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 200)));
        // Only surface the script's own failures; the stat providers and the
        // deliberately-refused q=0 requests are expected noise in this test.
        page.on('console', m => {
            const t = m.text();
            if (/\[bwdd\/cmoa\].*(failed|error)|run failed/i.test(t)) console.log('[console]', t.slice(0, 300));
        });
        await page.setRequestInterception(true);

        const html = pageHtml(pageSrcs);
        const contentInfo = JSON.stringify({
            result: 1,
            items: [{
                ContentID: '100002495100001',
                ContentsServer: CDN,
                Title: MESSY_TITLE,
                SubTitle: CLEAN_TITLE,
                p: 'TOKEN-ONE',
                ViewMode: 2,
                ContentDate: '99991031163056',
                Authors: [{ Name: '地主' }],
            }],
        });

        page.on('request', req => {
            const url = req.url();
            // The store's own API: clean title + contents server + token.
            if (url.includes('/bib/sws/bibGetCntntInfo.php')) {
                return req.respond({
                    status: 200,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
                    body: contentInfo,
                });
            }
            // The speed reader page itself, served as if it were www.cmoa.jp.
            if (url.includes('/bib/speedreader/')) {
                return req.respond({
                    status: 200,
                    headers: { 'Content-Type': 'text/html; charset=utf-8' },
                    body: html,
                });
            }
            // The image CDN. q=0 (the original rendition) is refused, as a
            // free/trial volume does, so the ladder must drop to q=1.
            if (url.includes('sbcGetImg.php')) {
                const u = new URL(url);
                const q = u.searchParams.get('q');
                const src = u.searchParams.get('src');
                page.evaluate(v => { window.__requestedQualities.push(v); }, q).catch(() => {});
                if (q === '0') {
                    return req.respond({ status: 403, headers: { 'Access-Control-Allow-Origin': '*' }, body: 'denied' });
                }
                const body = scrambledBySrc.get(src);
                if (!body) {
                    return req.respond({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: 'no such page' });
                }
                return req.respond({
                    status: 200,
                    headers: { 'Content-Type': 'image/jpeg', 'Access-Control-Allow-Origin': '*' },
                    body,
                });
            }
            // No bridge in this test, and no external stat providers.
            if (/127\.0\.0\.1:62642|learnnatively|manga-kotoba/.test(url)) {
                return req.abort();
            }
            return req.continue();
        });

        // Serve the synthetic page under the real store host so detection is
        // exercised for real rather than forced from the test.
        await page.goto('https://www.cmoa.jp/bib/speedreader/?cid=' + CID + '&u0=1&bwddDebug=1', { waitUntil: 'domcontentloaded' });
        const src = fs.readFileSync(US, 'utf8');
        await page.addScriptTag({ content: src });
        await sleep(1200);

        // ---- detection + shared panel ----
        const shell = await page.evaluate(() => {
            const root = document.querySelector('#bwdd-root');
            const title = document.querySelector('#bwdd-panel-title');
            return {
                hasPanel: !!root,
                title: title ? title.textContent.trim() : null,
                siteId: window.__bwddSite && window.__bwddSite.id,
                siteLabel: window.__bwddSite && window.__bwddSite.label,
                hasZip: !!document.querySelector('button.bwdd-btn.zip'),
                hasOcr: !!document.querySelector('button.bwdd-btn.ocr'),
                hasBars: !!document.querySelector('#bwdd-body'),
            };
        });
        check('the userscript recognises a cmoa.jp speed-reader page',
            shell.siteId === 'cmoa', 'adapter=' + shell.siteId + ' label=' + shell.siteLabel);
        check('the shared panel is mounted on the CMOA page',
            shell.hasPanel && shell.hasBars, 'panel=' + shell.hasPanel);
        check('the panel is branded for the store it is running on',
            /CMOA/.test(shell.title || '') && !/BookWalker/.test(shell.title || ''), JSON.stringify(shell.title));
        check('both download controls are present, exactly as on BookWalker',
            shell.hasZip && shell.hasOcr, 'zip=' + shell.hasZip + ' ocr=' + shell.hasOcr);

        // ---- metadata + naming ----
        await page.waitForFunction(
            () => { const i = document.querySelector('#bwdd-archive-name'); return i && i.value.length > 0; },
            { timeout: 8000 }
        ).catch(() => {});
        const meta = await page.evaluate(() => {
            const input = document.querySelector('#bwdd-archive-name');
            const cards = document.querySelector('.bwdd-cards');
            return {
                archive: input ? input.value : null,
                stats: cards ? cards.textContent.replace(/\s+/g, ' ').slice(0, 200) : null,
                cid: window.__bwddCmoa && window.__bwddCmoa.cid,
                pages: window.__bwddCmoa ? window.__bwddCmoa.pages.length : 0,
                title: window.__bwddCmoa && window.__bwddCmoa.title,
            };
        });
        check('the viewport-derived content id and page list are picked up from the viewer',
            meta.cid === CID && meta.pages === PAGES, 'cid=' + meta.cid + ' pages=' + meta.pages);
        check('the clean product title is preferred over the store SEO title',
            meta.title === CLEAN_TITLE, JSON.stringify(meta.title));
        check('the archive name uses the shared naming rule, not a CMOA-specific one',
            meta.archive === EXPECTED_ARCHIVE, JSON.stringify(meta.archive));
        check('the shared book card renders for the CMOA volume',
            !!meta.stats && meta.stats.includes('スーパーの裏でヤニ吸うふたり'),
            JSON.stringify((meta.stats || '').slice(0, 90)));

        // ---- the download itself ----
        await page.click('button.bwdd-btn.zip');
        try {
            await page.waitForFunction(() => !!window.__capturedZip, { timeout: 45000 });
        } catch (e) {
            const diag = await page.evaluate(() => {
                const d = document.querySelector('.bwdd-hint-box');
                const lock = document.querySelector('button.bwdd-btn.zip');
                return {
                    details: d ? d.textContent.replace(/\s+/g, ' ').slice(0, 400) : null,
                    zipDisabled: lock ? lock.disabled : null,
                    zipText: lock ? lock.textContent.replace(/\s+/g, ' ').slice(0, 80) : null,
                    cmoa: window.__bwddCmoa ? { cid: window.__bwddCmoa.cid, pages: window.__bwddCmoa.pages.length, title: window.__bwddCmoa.title, ready: window.__bwddCmoa.ready, server: window.__bwddCmoa.contentsServer, token: window.__bwddCmoa.token, q: window.__bwddCmoa.quality } : null,
                    errors: window.__bwddAutomation ? null : null,
                };
            });
            console.log('[diagnostics]', JSON.stringify(diag, null, 2));
            throw e;
        }
        const captured = await page.evaluate(() => window.__capturedZip);
        check('the ZIP download is offered with the shared archive name',
            captured && captured.name === EXPECTED_ARCHIVE + '.zip',
            captured ? JSON.stringify(captured.name) : 'no capture');

        const zipBuf = Buffer.from(captured.b64 || '', 'base64');
        const entries = readStoreZip(zipBuf);
        const names = entries.map(e => e.name);
        const expectedNames = Array.from({ length: PAGES }, (_, i) => 'page-' + String(i + 1).padStart(4, '0') + '.jpg');
        check('the archive holds one flat page-NNNN.jpg entry per page, same layout as BookWalker',
            JSON.stringify(names) === JSON.stringify(expectedNames), JSON.stringify(names));

        if (entries.length >= 1) {
            const p1 = await checkTilePositions(entries[0].data, 0);
            check('page 1 is descrambled back into the correct tile order',
                p1.ok, p1.detail);
        } else {
            check('page 1 is descrambled back into the correct tile order', false, 'no entries');
        }
        if (entries.length >= PAGES) {
            const p3 = await checkTilePositions(entries[PAGES - 1].data, PAGES - 1);
            check('every page is reassembled independently (last page matches its own colours)',
                p3.ok, p3.detail);
        } else {
            check('every page is reassembled independently (last page matches its own colours)', false, 'missing entries');
        }

        const qualities = await page.evaluate(() => window.__requestedQualities);
        check('the ladder starts at the original rendition, then falls back to the standard one',
            qualities.includes('0') && qualities.includes('1'),
            'requested q=' + JSON.stringify([...new Set(qualities)]));
        check('the per-page retry ladder resolves every page',
            entries.length === PAGES, entries.length + '/' + PAGES + ' pages in the archive');

    } finally {
        if (page) await page.close().catch(() => {});
        await browser.close().catch(() => {});
    }

    const failed = results.filter(r => !r.pass);
    fs.writeFileSync(path.join(__dirname, 'cmoa_adapter_result.json'), JSON.stringify({ results }, null, 2));
    console.log(failed.length ? '\n' + failed.length + ' FAILED' : '\nALL ' + results.length + ' CHECKS PASSED');
    process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
