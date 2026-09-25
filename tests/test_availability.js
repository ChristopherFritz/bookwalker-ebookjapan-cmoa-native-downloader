// test_availability.js — the cross-store "also available on" card.
//
// Store pages are stubbed with markup copied from the live ones, because that
// markup is the whole problem: BookWalker appends the imprint in brackets, also
// exposes /de<uuid> single-volume pages, and marks a free volume with a 0 price
// plus 無料で読む; CMOA keeps the REGULAR price on a free volume's row and marks
// free only with a 無料で読む block (which also carries an expiry); ebookjapan is
// a Vue app with no server-rendered prices at all, only a "2冊無料" badge.
//
// A pill is only rendered for a shop that actually carries the book, and a card
// with no pills is not rendered at all. A shop that misses is still *queried*
// (the hits assertion proves that), it is just not shown.
'use strict';
const puppeteer = require('puppeteer');
const { loadUserscript } = require('./_userscript');
const fs = require('fs');
const path = require('path');
const https = require('https');

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

const SERIES = 'スーパーの裏でヤニ吸うふたり';
const SKIP = 'スキップとローファー';
const ABSENT = 'この本は存在しませんXYZ';

const BW_SEARCH = `<html><body>
  <a href="https://bookwalker.jp/decf5c400b-42c7-4c7f-af26-7181721d9f5e/">${SERIES} 3 (単巻)</a>
  <a href="https://bookwalker.jp/series/78827/list/">デジタル版月刊ビッグガンガン</a>
  <a href="https://bookwalker.jp/series/367184/list/">${SERIES}（ビッグガンガンコミックス）</a>
</body></html>`;

// Vols 1 and 2 are the free 無料お試し版 (0 yen + 無料で読む), vol 3 costs 810, and
// the last row is the unnumbered edition (no volume in its title at all), which
// is the one a book like 小春と湊 has to be matched against by title.
const BW_SERIES = `<html><body>
  <div class="m-book-item">
    <a class="m-book-item__title" href="https://bookwalker.jp/def5a49973-58a0-44b0-a6ce-41abdc306335/" title="${SERIES} 1巻【無料お試し版】">${SERIES} 1巻【無料お試し版】</a>
    <div class="m-book-item__price"><span class="m-book-item__price-num">0</span> 円 (税込) 無料で読む</div>
  </div>
  <div class="m-book-item">
    <a class="m-book-item__title" href="https://bookwalker.jp/def14c212d-df22-4e6c-b300-e9bfe3de010e/" title="${SERIES} 2巻【無料お試し版】">${SERIES} 2巻【無料お試し版】</a>
    <div class="m-book-item__price"><span class="m-book-item__price-num">0</span> 円 (税込) 無料で読む</div>
  </div>
  <div class="m-book-item">
    <a class="m-book-item__title" href="https://bookwalker.jp/decf5c400b-42c7-4c7f-af26-7181721d9f5e/" title="${SERIES} 3巻">${SERIES} 3巻</a>
    <div class="m-book-item__price"><span class="m-book-item__price-num">810</span> 円 (税込) 試し読み</div>
  </div>
  <div class="m-book-item">
    <a class="m-book-item__title" href="https://bookwalker.jp/de9705d0bc-0e2a-4459-beb5-4e472c87683e/" title="${SERIES}【特典付】">${SERIES}【特典付】</a>
    <div class="m-book-item__price"><span class="m-book-item__price-num">500</span> 円 (税込) 試し読み</div>
  </div>
</body></html>`;

const CMOA_SEARCH = `<html><body>
  <a href="/title/370648/">【単話】婚約者の王子に毒を盛られたので愛が冷めました</a>
</body></html>`;

// vol 1 is free until 9/27 but STILL shows 720pt/792円(税込); vol 2 is paid.
const CMOA_TITLE = `<html><body>
  <div class="title_vol_vox_vols_i clearfix">
    <div class="title_vol_btn_box_w">
      <a href="/reader/sample/?title_id=167701&amp;content_id=100001677010001" rel="nofollow" class="position_r">
        <div class="GA_free btn free"><span>無料で読む</span><span>9/27まで</span></div>
        <span class="mark">&yen;<span class="em">0</span></span>
      </a>
    </div>
    <div class="title_vol_text_box_w">
      <h3 class="title_details_title_name_h2"><a href="/title/167701/">${SKIP}（１）</a></h3>
      <div class="valueArea"><p class="price"><span class="point">720pt/792円(税込)</span></p></div>
    </div>
  </div>
  <div class="title_vol_vox_vols_i clearfix">
    <div class="title_vol_btn_box_w">
      <a href="/reader/sample/?title_id=167701&amp;content_id=100001677010003" rel="nofollow">
        <div class="title_vol_each_free_btn GA_free"></div>
      </a>
    </div>
    <div class="title_vol_text_box_w">
      <h3 class="title_details_title_name_h2"><a href="/title/167701/vol/3/">${SKIP}（3）</a></h3>
      <div class="valueArea"><p class="price"><span class="point">720pt/792円(税込)</span></p></div>
    </div>
  </div>
  <div class="title_vol_vox_vols_i clearfix">
    <div class="title_vol_btn_box_w">
      <a href="javascript:void(0)" class="cart_into_btn registBtn"><p class="title">会員登録して購入</p></a>
    </div>
    <div class="title_vol_text_box_w">
      <h3 class="title_details_title_name_h2"><a href="/title/167701/vol/2/">${SKIP}（２）</a></h3>
      <div class="valueArea"><p class="price"><span class="point">720pt/792円(税込)</span></p></div>
    </div>
  </div>
</body></html>`;

const EBJ_SEARCH = `<html><body>
  <a href="/books/999999/"><span class="badge-label">3冊無料</span> 関係ないタイトル 1</a>
  <a href="/books/716241/"><span class="badge-label">2冊無料</span> お得 ${SERIES} 地主 2,477 漫画賞受賞</a>
</body></html>`;

// host -> { path prefix -> html }
const PAGES = {
  'bookwalker.jp': { '/search/': BW_SEARCH, '/series/367184/list/': BW_SERIES },
  'www.cmoa.jp': { '/search/result/': CMOA_SEARCH, '/title/167701/': CMOA_TITLE },
  'ebookjapan.yahoo.co.jp': { '/search/': EBJ_SEARCH },
};

const tls = { key: fs.readFileSync(path.join(__dirname, 'tls/key.pem')), cert: fs.readFileSync(path.join(__dirname, 'tls/cert.pem')) };

// The late-title scenario models the BookWalker viewer, whose document.title
// arrives after the first pass. CMOA's adapter never falls back to
// document.title (cmoa/02-run.js getBook() returns null without its own state)
// and latches its viewer title once, so the scenario is meaningless for a build
// with no BookWalker adapter.
const HAS_BW_ADAPTER = loadUserscript().includes('installNetworkCapture');

// The cross-store card ships in the combined build only, so a single-store
// artifact has nothing here to test.
const HAS_AVAILABILITY = loadUserscript().includes('AVAILABILITY_STORES');

// The page itself is served locally. Store URLs carry no port, so they are
// served through a GM_xmlhttpRequest stub - also the transport the script
// prefers in production, and it needs no CORS.
const srv = https.createServer(tls, (req, res) => {
  const url = new URL(req.url, 'https://x');
  const title = url.searchParams.get('t') || '';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><title>' + title.replace(/[<>&]/g, '') + '</title><body></body>');
});

const results = [];
const check = (n, pass, d) => { results.push({ n, pass, d }); console.log((pass ? 'PASS  ' : 'FAIL  ') + n + '  — ' + d); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  if (!HAS_AVAILABILITY) {
    console.log('SKIP  test_availability.js \u2014 this artifact does not carry the cross-store card (combined build only)');
    console.log('\nALL 0 CHECKS PASSED');
    process.exit(0);
  }
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--ignore-certificate-errors',
      '--host-resolver-rules=MAP viewer.bookwalker.jp 127.0.0.1, MAP * 127.0.0.1'],
  });

  async function installGmStub(page) {
    // Record every URL the script asks for, so "no match" can be told apart
    // from "the fetch never happened".
    await page.evaluateOnNewDocument((pages) => {
      window.__bwddTestHits = [];
      window.GM_xmlhttpRequest = (opts) => {
        const url = String(opts && opts.url || '');
        let host = '', p = '';
        try { const u = new URL(url); host = u.hostname; p = u.pathname; } catch (e) {}
        window.__bwddTestHits.push(url);
        const routes = pages[host] || {};
        const key = Object.keys(routes).find(k => p.startsWith(k));
        setTimeout(() => {
          if (key) { try { opts.onload({ status: 200, responseText: routes[key], responseHeaders: '' }); } catch (e) {} }
          else { try { opts.onerror({ error: 'stub: no route for ' + host + p }); } catch (e) {} }
        }, 0);
      };
    }, PAGES);
  }

  async function openPage(query) {
    const page = await browser.newPage();
    await installGmStub(page);
    await page.goto('https://viewer.bookwalker.jp:' + port + '/?bwddDebug=1&' + query, { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ content: loadUserscript() });
    return page;
  }

  const readPills = (page) => page.evaluate(() => [...document.querySelectorAll('.bwdd-store-link')].map(a => ({
    href: a.href, text: a.textContent, found: a.classList.contains('is-found'),
    free: a.classList.contains('is-free'), tip: a.title,
  })));

  // Pills are conditional now, so "wait for 3 of them" is not a completion
  // signal. Wait for the card to appear, or for all three shops to have been
  // asked, then give the render a moment.
  async function settle(page) {
    try {
      await page.waitForFunction(() => {
        if (document.querySelector('.bwdd-card[data-card="stores"]')) return true;
        const h = window.__bwddTestHits || [];
        return h.filter(u => /bookwalker\.jp|cmoa\.jp|ebookjapan\.yahoo/.test(u)).length >= 3;
      }, { timeout: 15000 });
    } catch (e) {}
    await sleep(600);
  }

  async function scenario(query) {
    const page = await openPage(query);
    await settle(page);
    const pills = await readPills(page);
    const hits = await page.evaluate(() => window.__bwddTestHits || []);
    const hasCard = await page.evaluate(() => !!document.querySelector('.bwdd-card[data-card="stores"]'));
    await page.close();
    return { pills, hits, hasCard };
  }

  const pick = (pills, label) => pills.find(p => p.text.includes(label));
  const url = q => 't=' + encodeURIComponent(q);
  const shown = pills => pills.map(p => p.text.replace(/^./, '')).join(' | ');

  // ---- 1. reading vol 3: paid on BookWalker, nothing free of its own -------
  const a = await scenario(url(SERIES + ' 3巻'));
  const bw = pick(a.pills, 'BookWalker'), cm = pick(a.pills, 'CMOA'), eb = pick(a.pills, 'ebookjapan');
  check('only shops that carry it get a pill', a.pills.length === 2, `pills=${a.pills.length}: ${shown(a.pills)}`);
  check('a missing shop leaves no empty frame behind', !cm, cm ? cm.text : 'no CMOA pill');
  check('every store was really queried (no match cannot mean no fetch)',
    a.hits.some(u => u.includes('bookwalker.jp/search')) && a.hits.some(u => u.includes('cmoa.jp/search')) &&
    a.hits.some(u => u.includes('ebookjapan.yahoo.co.jp/search')),
    a.hits.map(u => { try { return new URL(u).hostname; } catch (e) { return '?'; } }).join(' '));
  check('BookWalker: series page wins over the single-volume decoy and the magazine',
    !!bw && bw.href === 'https://bookwalker.jp/series/367184/list/', bw ? bw.href : 'none');
  check('BookWalker: shows this volume\'s price and the series free count',
    !!bw && /¥810/.test(bw.text) && /2 vols free/.test(bw.text), bw ? bw.text : 'none');
  check('BookWalker: the series page was fetched to read the rows',
    a.hits.some(u => u.includes('/series/367184/list/')), a.hits.length + ' requests');
  check('BookWalker: a paid volume states its price instead of claiming "free"',
    !!bw && /¥810/.test(bw.text) && /this volume is ¥810/.test(bw.tip), bw ? bw.tip : 'none');
  check('ebookjapan: reads its OWN card badge, not a bigger one from another card',
    !!eb && /2 vols free/.test(eb.text) && !/3 vols free/.test(eb.text), eb ? eb.text : 'none');
  check('ebookjapan: no price invented where the site renders none',
    !!eb && !/¥/.test(eb.text), eb ? eb.text : 'none');
  check('every pill with a free offer is lit the same way, ebookjapan included',
    !!eb && eb.free && !!bw && bw.free, 'ebj=' + (eb ? eb.free : '?') + ' bw=' + (bw ? bw.free : '?'));

  // ---- 2. reading vol 1: free on BookWalker -------------------------------
  const b = await scenario(url(SERIES + ' 1巻'));
  const bw1 = pick(b.pills, 'BookWalker');
  check('BookWalker: a free volume still reports the series free count',
    !!bw1 && /free · 2 vols free/.test(bw1.text), bw1 ? bw1.text : 'none');
  check('BookWalker: a free volume is flagged for styling',
    !!bw1 && bw1.free, bw1 ? String(bw1.free) : 'none');
  check('BookWalker: free state is not also reported as a price',
    !!bw1 && !/¥/.test(bw1.text), bw1 ? bw1.text : 'none');
  check('BookWalker: the tooltip spells out the ratio for the series',
    !!bw1 && /2 of 3 volumes can be read free/.test(bw1.tip), bw1 ? bw1.tip : 'none');

  // ---- 3. CMOA exact page via rurl: paid vol 2 ----------------------------
  const c = await scenario(url(SKIP + ' 2巻') + '&rurl=' + encodeURIComponent('https://www.cmoa.jp/title/167701/'));
  const cm2 = pick(c.pills, 'CMOA');
  check('CMOA: exact rurl link is used', !!cm2 && cm2.href === 'https://www.cmoa.jp/title/167701/', cm2 ? cm2.href : 'none');
  check('CMOA: paid volume shows its price and the series free count',
    !!cm2 && /¥792/.test(cm2.text) && /1 vol free/.test(cm2.text), cm2 ? cm2.text : 'none');
  check('CMOA: the empty GA_free placeholder does not count a volume as free',
    !!cm2 && /1 vol free/.test(cm2.text), cm2 ? cm2.text : 'none');
  check('CMOA: the title page was fetched for the rows',
    c.hits.some(u => u === 'https://www.cmoa.jp/title/167701/'), c.hits.length + ' requests');

  // ---- 4. CMOA free volume keeps its regular price on the row -------------
  const d = await scenario(url(SKIP + ' 1巻') + '&rurl=' + encodeURIComponent('https://www.cmoa.jp/title/167701/'));
  const cm3 = pick(d.pills, 'CMOA');
  check('CMOA: free is read from 無料で読む, not from the row price',
    !!cm3 && cm3.free && /free/.test(cm3.text) && !/¥/.test(cm3.text), cm3 ? cm3.text : 'none');
  check('CMOA: the free reading\'s expiry is surfaced in the tooltip',
    !!cm3 && /9\/27/.test(cm3.tip), cm3 ? cm3.tip : 'none');

  // ---- 5. a title no store carries ---------------------------------------
  const e = await scenario(url(ABSENT));
  check('a title no shop carries shows no pills at all',
    e.pills.length === 0, `pills=${e.pills.length}: ${shown(e.pills)}`);
  check('and the empty card is not rendered', !e.hasCard, e.hasCard ? 'card present' : 'no card');

  // ---- 6. an unknown volume number must not invent a price ---------------
  const f = await scenario(url(SERIES));
  const bwNoVol = pick(f.pills, 'BookWalker');
  check('no volume number: free count still shown, no price claimed',
    !!bwNoVol && !/¥/.test(bwNoVol.text) && /2 vols free/.test(bwNoVol.text), bwNoVol ? bwNoVol.text : 'none');

  // ---- 7. a viewer title carrying the shop's own branding ---------------
  const h = await scenario(url(SERIES + ' 3巻 | BOOK☆WALKER'));
  const bwNoisy = pick(h.pills, 'BookWalker');
  check('a title suffixed with the shop brand still matches',
    !!bwNoisy && bwNoisy.found, bwNoisy ? bwNoisy.href : 'none');
  check('and still reports the price off the matched page',
    !!bwNoisy && /¥810/.test(bwNoisy.text), bwNoisy ? bwNoisy.text : 'none');

  // ---- 8. an unnumbered volume is matched by its exact title ------------
  // 小春と湊 わたしのパートナーは女の子【イラスト特典付】 has no volume number,
  // so numbering cannot find its row - the title has to. Without that the pill
  // used to fall back to a bare "available" with no price.
  const u = await scenario(url(SERIES + '【特典付】'));
  const bwUn = pick(u.pills, 'BookWalker');
  check('an unnumbered volume is matched by title and priced',
    !!bwUn && /¥500/.test(bwUn.text), bwUn ? bwUn.text : 'none');
  check('and no pill is left showing a filler word like "available"',
    !!bwUn && !/available/i.test(bwUn.text), bwUn ? bwUn.text : 'none');

  // ---- 9. metadata that only arrives after the first pass ---------------
  // The viewer publishes its title asynchronously, so the first lookup can run
  // against a placeholder and come back "not found" everywhere. That must not
  // latch: when the real title lands the pills have to correct themselves.
  if (!HAS_BW_ADAPTER) {
    console.log('SKIP  late-metadata self-correction — this artifact has no BookWalker adapter');
  } else {
    const late = await openPage(url('読み込み中'));
    await sleep(2500);
    const beforeLate = await readPills(late);
    await late.evaluate((t) => { document.title = t; }, SERIES + ' 3巻');
    let corrected = true;
    try {
      await late.waitForFunction(() => document.querySelectorAll('.bwdd-store-link').length >= 1, { timeout: 20000 });
    } catch (e) { corrected = false; }
    const afterLate = await readPills(late);
    await late.close();
    check('a placeholder title does not latch a permanent "not found"',
      beforeLate.length === 0, shown(beforeLate));
    check('the pills correct themselves once the real title arrives',
      corrected && afterLate.some(p => /¥810/.test(p.text)), shown(afterLate));
  }

  // ---- 10. a hostile rurl must not be trusted ---------------------------
  const g = await scenario(url(SKIP + ' 1巻') + '&rurl=' + encodeURIComponent('https://evil.example/title/167701/'));
  const cm4 = pick(g.pills, 'CMOA');
  check('CMOA: an rurl on another host is ignored, so nothing is claimed',
    !cm4 || !cm4.href.includes('evil.example'), cm4 ? cm4.href : 'no CMOA pill');

  await browser.close(); srv.close();
  const failed = results.filter(r => !r.pass);
  console.log(failed.length ? '\n' + failed.length + ' FAILED' : '\nALL ' + results.length + ' CHECKS PASSED');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
