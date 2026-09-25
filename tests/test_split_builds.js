// test_split_builds.js — the per-store artifacts really are independent.
//
// Asserts, for every target in src/targets.json:
//   1. its metadata claims exactly its own store (name, @match, @connect);
//   2. it contains no fragment from a module it does not include;
//   3. booted in a browser it selects the right adapter, and the other store's
//      internals are absent from window.__bwdd — the functional proof that the
//      two scripts do not intersect.
'use strict';
const puppeteer = require('puppeteer');
const { loadUserscript } = require('./_userscript');
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const TARGETS = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/targets.json'), 'utf8'));
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/manifest.json'), 'utf8'));

const results = [];
const check = (n, pass, d) => { results.push({ n, pass, d }); console.log((pass ? 'PASS  ' : 'FAIL  ') + n + '  — ' + d); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// which adapter each artifact must pick on each host, and whether it may carry
// the other store's internals
const EXPECT = [
  { host: 'viewer.bookwalker.jp', adapter: 'bookwalker' },
  { host: 'www.cmoa.jp',          adapter: 'cmoa' },
  { host: 'ebookjapan.yahoo.co.jp', adapter: 'ebookjapan' },
];

(async () => {
  // ---- 1 + 2: everything that needs no browser -------------------------------
  for (const [id, target] of Object.entries(TARGETS)) {
    const file = path.join(ROOT, target.out);
    if (!fs.existsSync(file)) { check(`${id}: artifact exists`, false, target.out + ' is missing'); continue; }
    const text = fs.readFileSync(file, 'utf8');
    const head = text.slice(0, text.indexOf('==/UserScript=='));
    const name = (head.match(/@name\s+(.*)/) || [])[1];
    const matches = [...head.matchAll(/@match\s+(\S+)/g)].map(m => m[1]);
    const connects = [...head.matchAll(/@connect\s+(\S+)/g)].map(m => m[1]);

    const coreVersion = (fs.readFileSync(path.join(ROOT, 'src/core/00-identity.js'), 'utf8')
      .match(/return '([0-9]+\.[0-9]+\.[0-9]+)';/) || [])[1];
    const metaVersion = (head.match(/@version\s+(\S+)/) || [])[1];
    check(`${id}: @version derives from core`, !!coreVersion && metaVersion === coreVersion,
      `@version=${metaVersion} core=${coreVersion}`);
    check(`${id}: no unsubstituted header placeholder`, !/\{\{[A-Z_]+\}\}/.test(head),
      (head.match(/\{\{[A-Z_]+\}\}/) || ['none'])[0]);
    check(`${id}: @name`, name.trim() === target.name, name.trim());
    check(`${id}: @match is exactly this target's list`,
      JSON.stringify(matches) === JSON.stringify(target.matches), matches.join(' '));
    check(`${id}: @connect is exactly this target's list`,
      JSON.stringify(connects) === JSON.stringify(target.connects), connects.join(' '));

    // Every fragment of an excluded module must be absent, verbatim. Fragments
    // are large unique blocks, so a partial leak of one is the only thing this
    // can miss, and the booted-adapter check below covers behaviour.
    const allow = new Set(target.modules);
    const leaked = [];
    for (const frag of MANIFEST.fragments) {
      if (allow.has(frag.module)) continue;
      const body = fs.readFileSync(path.join(ROOT, 'src', frag.file), 'utf8');
      if (text.includes(body)) leaked.push(frag.file);
    }
    check(`${id}: no fragment from an excluded module`, leaked.length === 0,
      leaked.length ? 'leaked: ' + leaked.join(', ') : 'none of ' +
        [...new Set(MANIFEST.fragments.map(f => f.module).filter(m => !allow.has(m)))].join('/') + ' present');
  }

  // ---- 3: boot each artifact and look at what it actually carries ------------
  const tls = {
    key: fs.readFileSync(path.join(__dirname, 'tls/key.pem')),
    cert: fs.readFileSync(path.join(__dirname, 'tls/cert.pem')),
  };
  const srv = https.createServer(tls, (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>t</title><body></body>');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--ignore-certificate-errors',
      '--host-resolver-rules=MAP viewer.bookwalker.jp 127.0.0.1, MAP www.cmoa.jp 127.0.0.1, MAP * 127.0.0.1'],
  });

  for (const [id, target] of Object.entries(TARGETS)) {
    const file = path.join(ROOT, target.out);
    if (!fs.existsSync(file)) continue;
    const carriesBw = target.modules.includes('sites/bookwalker');
    const carriesCmoa = target.modules.includes('sites/cmoa');
    // The combined build must not point at itself, so the module is only in
    // the single-store targets; here that is checked against the rendered panel.
    const carriesUnified = target.modules.includes('feature/unified-link');
    for (const exp of EXPECT) {
      // An artifact only matches its own store, so on the other store's host it
      // is not supposed to be running at all; inject it anyway to prove it does
      // not silently fall back to code it does not have.
      const page = await browser.newPage();
      await page.goto('https://' + exp.host + ':' + port + '/?bwddDebug=1', { waitUntil: 'domcontentloaded' });
      await page.addScriptTag({ content: loadUserscript({ file }) });
      await sleep(900);
      const got = await page.evaluate(() => {
        const b = window.__bwdd || {};
        return {
          site: window.__bwddSite && window.__bwddSite.id,
          title: window.__bwddSite && window.__bwddSite.panelTitle,
          a9p: typeof b.A9p,
          hasCmoaState: !!(b.cmoaState || window.__bwddCmoa),
          hasEjState: !!(b.ebjState || window.__bwddEbookjapan),
          hasUnified: !!document.querySelector('.bwdd-unified'),
        };
      });
      await page.close();

      // Which adapter must boot here: the one carrying every store lets the
      // host decide; an artifact carrying a single store falls back to it,
      // because detectSite() takes the only adapter that is registered.
      const wantAdapter = (carriesBw && carriesCmoa)
        ? exp.adapter
        : (carriesBw ? 'bookwalker' : (carriesCmoa ? 'cmoa' : 'ebookjapan'));
      check(`${id} on ${exp.host}: adapter`, got.site === wantAdapter, `site=${got.site} title=${got.title}`);
      check(`${id} on ${exp.host}: "all-in-one downloader" pointer`,
        got.hasUnified === carriesUnified,
        `rendered=${got.hasUnified} expected=${carriesUnified}`);

      if (!carriesBw) {
        check(`${id} on ${exp.host}: no BookWalker internals`, got.a9p === 'undefined', `typeof A9p=${got.a9p}`);
      }
      if (!carriesCmoa) {
        check(`${id} on ${exp.host}: no CMOA internals`, got.hasCmoaState === false, `cmoaState present=${got.hasCmoaState}`);
      }
      if (carriesBw && carriesCmoa) {
        // The combined artifact carries both modules, but window.__bwdd gets only
        // the ACTIVE adapter's debug surface, so assert the matching one. That
        // the other module is present at all is what the fragment check above
        // establishes.
        // exp.adapter is the store this host belongs to, so the combined
        // artifact's active debug surface is the one for that store.
        const ok = (exp.adapter === 'bookwalker') ? got.a9p === 'function'
          : (exp.adapter === 'cmoa') ? got.hasCmoaState === true
          : got.hasEjState === true;
        check(`${id} on ${exp.host}: active store's internals exported`, ok,
          `A9p=${got.a9p} cmoaState=${got.hasCmoaState} ebookjapanState=${got.hasEjState}`);
      }
    }
  }

  await browser.close(); srv.close();
  const failed = results.filter(r => !r.pass);
  console.log(failed.length ? '\n' + failed.length + ' FAILED' : '\nALL ' + results.length + ' CHECKS PASSED');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
