#!/usr/bin/env node
'use strict';
/*
 * Site dispatch test.
 *
 * The unified script picks an adapter from the page host. This pins the two
 * things that moving that choice into the entry point could silently break:
 *
 *   - on a viewer.bookwalker.jp page the BookWalker adapter is selected AND its
 *     network capture is still installed (it used to install itself as a side
 *     effect of loading its own module, so this is the regression to watch),
 *   - on a www.cmoa.jp page the CMOA adapter is selected and installs instead,
 *   - neither store's adapter state leaks into the other.
 *
 * It also pins the fallback: a host no adapter claims still gets BookWalker,
 * which is what an injected copy (and the rest of the test suite) relies on.
 */
const puppeteer = require('puppeteer');
const { loadUserscript } = require('./_userscript');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const US = path.resolve(__dirname, '..', process.env.BWDD_US || 'omnimanga-native-downloader.user.js');

const BODY = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>Test Volume 1巻</title></head><body>
<div id="content"></div>
<div data-ptbinb="/bib/sws/bibGetCntntInfo.php?u0=1" data-ptbinb-cid="0000249510_jp_0001"></div>
</body></html>`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    const src = loadUserscript();
    const results = [];
    const check = (n, pass, d) => { results.push({ n, pass, d }); console.log((pass ? 'PASS  ' : 'FAIL  ') + n + '  — ' + d); };

    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: true,
        args: ['--no-sandbox', '--ignore-certificate-errors'],
    });
    try {
        async function probe(url) {
            const page = await browser.newPage();
            page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 160)));
            await page.setRequestInterception(true);
            page.on('request', req => {
                const u = req.url();
                // Serve the synthetic page for any navigation: the unclaimed-host
                // case must not depend on DNS resolving.
                if (req.resourceType() === 'document' || req.isNavigationRequest()) {
                    return req.respond({ status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: BODY });
                }
                if (/127\.0\.0\.1:62642|learnnatively|manga-kotoba|akamaized/.test(u)) return req.abort();
                return req.continue();
            });
            await page.evaluateOnNewDocument(() => {
                try { localStorage.clear(); } catch (e) {}
                // Recorded before the userscript runs so we can tell whether it
                // wrapped fetch (its network capture) on this page.
                window.__origFetch = window.fetch;
            });
            await page.goto(url, { waitUntil: 'domcontentloaded' });
            await page.addScriptTag({ content: src });
            await sleep(700);
            const out = await page.evaluate(() => ({
                siteId: window.__bwddSite && window.__bwddSite.id,
                label: window.__bwddSite && window.__bwddSite.label,
                title: (document.querySelector('#bwdd-panel-title') || {}).textContent || '',
                fetchWrapped: window.fetch !== window.__origFetch,
                hasBwDebug: !!window.__bwdd,
                hasCmoaDebug: !!window.__bwddCmoa,
                hasEjDebug: !!window.__bwddEbookjapan,
                cmoaCid: window.__bwddCmoa ? window.__bwddCmoa.cid : null,
                bwCid: window.__bwdd && window.__bwdd.state ? window.__bwdd.state.cid : null,
                hasZip: !!document.querySelector('button.bwdd-btn.zip'),
            }));
            await page.close();
            return out;
        }

        const bw = await probe('https://viewer.bookwalker.jp/deno/1/1/1/?cid=abc123&bwddDebug=1');
        check('a BookWalker viewer page selects the BookWalker adapter',
            bw.siteId === 'bookwalker', 'adapter=' + bw.siteId);
        check('the BookWalker network capture is still installed by the adapter',
            bw.fetchWrapped === true, 'window.fetch wrapped=' + bw.fetchWrapped);
        check('the BookWalker panel is branded for BookWalker',
            /BookWalker/.test(bw.title) && !/CMOA/.test(bw.title), JSON.stringify(bw.title.trim()));
        check('the BookWalker id is taken from the page URL',
            bw.bwCid === 'abc123', 'cid=' + JSON.stringify(bw.bwCid));
        check('the CMOA adapter state stays empty on a BookWalker page',
            bw.cmoaCid === null, 'cmoa cid=' + JSON.stringify(bw.cmoaCid));

        const cm = await probe('https://www.cmoa.jp/bib/speedreader/?cid=0000249510_jp_0001&u0=1&bwddDebug=1');
        check('a CMOA speed-reader page selects the CMOA adapter',
            cm.siteId === 'cmoa', 'adapter=' + cm.siteId);
        check('the CMOA capture is installed on its own page',
            cm.fetchWrapped === true, 'window.fetch wrapped=' + cm.fetchWrapped);
        check('the CMOA panel is branded for CMOA',
            /CMOA/.test(cm.title) && !/BookWalker/.test(cm.title), JSON.stringify(cm.title.trim()));
        check('both stores get the same download controls',
            cm.hasZip && bw.hasZip, 'cmoa=' + cm.hasZip + ' bookwalker=' + bw.hasZip);
        check('the CMOA id comes from the page URL on its page',
            cm.cmoaCid === '0000249510_jp_0001', 'cid=' + JSON.stringify(cm.cmoaCid));

        const ej = await probe('https://ebookjapan.yahoo.co.jp/viewer/free/B00160686480/?bwddDebug=1');
        check('an ebookjapan viewer page selects the ebookjapan adapter',
            ej.siteId === 'ebookjapan', 'adapter=' + ej.siteId);
        check('the ebookjapan panel is branded for ebookjapan',
            /ebookjapan/.test(ej.title) && !/BookWalker/.test(ej.title), JSON.stringify(ej.title.trim()));
        check('the ebookjapan adapter exposes its own debug surface',
            ej.hasEjDebug === true && ej.hasBwDebug === true, 'ejDebug=' + ej.hasEjDebug);
        // window.__bwdd carries the ACTIVE store's debug surface by design, so on
        // this page it is ebookjapan's, not BookWalker's. Cross-store isolation
        // of the shipped code is test_split_builds.js's job.
        check('the CMOA store does not leak onto an ebookjapan page',
            ej.hasCmoaDebug === false && ej.cmoaCid === null,
            'cmoaDebug=' + ej.hasCmoaDebug + ' cmoaCid=' + JSON.stringify(ej.cmoaCid));
        check('the active debug surface is the ebookjapan one, with the id from the URL',
            ej.hasEjDebug === true && ej.bwCid === 'B00160686480',
            'ejDebug=' + ej.hasEjDebug + ' cid=' + JSON.stringify(ej.bwCid));
        check('all three stores get the same download controls',
            ej.hasZip && bw.hasZip && cm.hasZip,
            'ej=' + ej.hasZip + ' bw=' + bw.hasZip + ' cmoa=' + cm.hasZip);

        const unknown = await probe('https://unclaimed.example/reader/?bwddDebug=1');
        check('a host no adapter claims still falls back to BookWalker',
            unknown.siteId === 'bookwalker' && unknown.hasZip,
            'adapter=' + unknown.siteId + ' panel=' + unknown.hasZip);
    } finally {
        await browser.close().catch(() => {});
    }

    const failed = results.filter(r => !r.pass);
    fs.writeFileSync(path.join(__dirname, 'site_dispatch_result.json'), JSON.stringify({ results }, null, 2));
    console.log(failed.length ? '\n' + failed.length + ' FAILED' : '\nALL ' + results.length + ' CHECKS PASSED');
    process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
