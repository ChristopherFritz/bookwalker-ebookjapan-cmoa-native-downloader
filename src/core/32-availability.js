    // =====================================================================
    // 9. Cross-store availability ("also available on ...")
    // =====================================================================
    // Asks each store's own search page whether it carries the book and links
    // to that store's product page - never to a viewer. The stores are external
    // facts rather than adapter concerns, so they live here as a catalog; the
    // module is in the combined target ("Omnimanga Native Downloader") only, so
    // the single-store scripts carry none of these hosts either.
    //
    // Matching is necessarily fuzzy (BookWalker appends the imprint in brackets,
    // ebookjapan wraps the whole card in one anchor), so it is scored in tiers
    // (exact > prefix > contains) and reported honestly: a confirmed match links
    // to the product page, anything else to the store's search.
    const AVAILABILITY_STORES = [
        {
            id: 'bookwalker', siteId: 'bookwalker', label: 'BookWalker', short: 'B',
            color: '#0f7dc4', origin: 'https://bookwalker.jp', hosts: ['bookwalker.jp'],
            search: (q) => 'https://bookwalker.jp/search/?word=' + encodeURIComponent(q),
            // /series/<id>/ lists every volume, so prefer it over a /de<uuid> page.
            product: (p) => /^\/series\/\d+\//.test(p) || /^\/de[0-9a-f-]{6,}\/?$/i.test(p),
            rank: (p) => (/^\/series\//.test(p) ? 0.5 : 0),
            // One card per edition, each with its own price; a 0-yen card is
            // the free 無料お試し版 and also says 無料で読む. Volumes 8 and 6 each
            // exist as 通常版 and 特装版, so a volume can have several rows.
            volumes: (doc) => {
                const out = [];
                for (const a of doc.querySelectorAll('a.m-book-item__title')) {
                    const title = (a.getAttribute('title') || a.textContent || '').trim();
                    let url = '';
                    try { url = new URL(a.getAttribute('href') || '', 'https://bookwalker.jp/').href; } catch (e) { continue; }
                    let num = null, free = false, row = a;
                    for (let i = 0; i < 6 && row; i++, row = row.parentElement) {
                        const el = row.querySelector('.m-book-item__price-num');
                        if (!el) continue;
                        const n = parseInt(String(el.textContent).replace(/[^0-9]/g, ''), 10);
                        num = isFinite(n) ? n : null;
                        free = /無料で読む/.test(row.textContent || '') || num === 0;
                        break;
                    }
                    out.push({ title: title, url: url, vol: extractVolumeNumber(title), price: num, free: free, until: '' });
                }
                return out;
            },
        },
        {
            id: 'cmoa', siteId: 'cmoa', label: 'CMOA', short: 'C',
            color: '#e2574c', origin: 'https://www.cmoa.jp', hosts: ['cmoa.jp'],
            search: (q) => 'https://www.cmoa.jp/search/result/?search_word=' + encodeURIComponent(q),
            product: (p) => /^\/title\/\d+\/?/.test(p),
            rank: () => 0,
            // A free volume keeps its regular 720pt/792円(税込) price on the same
            // row, so "free" must be read from the 無料で読む block, never from the
            // price. The expiry ("9/27まで") rides along in the same block.
            volumes: (doc) => {
                const out = [];
                for (const row of doc.querySelectorAll('.title_vol_vox_vols_i')) {
                    const a = row.querySelector('h3.title_details_title_name_h2 a') || row.querySelector('a[href*="/title/"]');
                    const img = row.querySelector('img[alt]');
                    const title = ((a && a.textContent) || (img && img.getAttribute('alt')) || '').trim();
                    let url = '';
                    if (a) { try { url = new URL(a.getAttribute('href') || '', 'https://www.cmoa.jp/').href; } catch (e) {} }
                    // GA_free alone is NOT a free marker: every volume row also
                    // carries an empty <div class="title_vol_each_free_btn GA_free">
                    // placeholder, so matching the class marks the whole series free.
                    // A free volume is one whose free button says something, or
                    // whose row shows a 0 price.
                    let freeEl = null;
                    for (const el of row.querySelectorAll('.GA_free')) {
                        if ((el.textContent || '').trim()) { freeEl = el; break; }
                    }
                    const markEl = row.querySelector('.mark .em');
                    const zeroMarked = !!markEl && (markEl.textContent || '').replace(/[^0-9]/g, '') === '0';
                    let until = '';
                    if (freeEl) {
                        for (const sp of freeEl.querySelectorAll('span')) {
                            const t = (sp.textContent || '').trim();
                            if (/まで/.test(t)) until = t;
                        }
                    }
                    let price = null;
                    const point = row.querySelector('.price .point');
                    if (point) {
                        const m = /([0-9][0-9,]*)円/.exec(point.textContent || '');
                        if (m) price = parseInt(m[1].replace(/,/g, ''), 10);
                    }
                    let vol = NaN;
                    const vm = /\/vol\/([0-9]+)\//.exec(url);
                    if (vm) vol = parseInt(vm[1], 10);
                    if (!isFinite(vol) || !vol) vol = extractVolumeNumber(title);
                    out.push({ title: title, url: url, vol: vol, price: price, free: !!(freeEl || zeroMarked), until: until });
                }
                return out;
            },
        },
        {
            id: 'ebookjapan', siteId: 'ebookjapan', label: 'ebookjapan', short: 'e',
            color: '#e8820c', origin: 'https://ebookjapan.yahoo.co.jp', hosts: ['ebookjapan.yahoo.co.jp'],
            search: (q) => 'https://ebookjapan.yahoo.co.jp/search/?keyword=' + encodeURIComponent(q),
            product: (p) => /^\/books\/\d+\/?/.test(p),
            rank: () => 0,
            // ebookjapan is a Vue app: its series and search pages carry no
            // server-rendered prices or per-volume rows at all, so the only
            // price/free fact available is the campaign badge on the search
            // card ("2冊無料"). Everything else stays blank rather than guessed.
            freeBadge: (html) => {
                const all = [];
                const re = /([0-9]+)\s*冊無料/g;
                let m;
                while ((m = re.exec(String(html || '')))) all.push(parseInt(m[1], 10));
                return all.length ? Math.max.apply(null, all) : 0;
            },
        },
    ];
    // One lookup per title per page: the panel re-renders, the answers do not.
    const availabilityMemory = new Map();
    // One shared in-flight promise per key: the boot poll often asks again while
    // the first round-trip is still running, and the same three stores must not
    // be queried twice.
    const availabilityInflight = new Map();
    const AVAILABILITY_CACHE_MAX = 50;

    // A viewer's document title often carries the shop's own branding
    // ("... | BOOK☆WALKER"); searching for that finds nothing.
    function cleanStoreSeed(t) {
        let s = String(t || '');
        s = s.replace(/[\s|｜\-\u2013\u2014]*(?:BOOK\s*[☆★]?\s*WALKER|ブックウォーカー|ebookjapan|イーブックジャパン|コミックシーモア|CMOA|シーモア)\s*$/i, '');
        s = s.replace(/[\s|｜\-\u2013\u2014]+$/, '');
        return s.trim();
    }

    function availabilityNorm(s) {
        return String(s || '')
            .replace(/[\s\u3000]+/g, '')
            .replace(/[（）()【】\[\]「」『』]/g, '')
            .toLowerCase();
    }

    function availabilityScore(anchorText, candidates, bonus) {
        const t = availabilityNorm(anchorText);
        if (!t) return null;
        let tier = 0;
        for (const cand of candidates) {
            const n = availabilityNorm(cand);
            if (n.length < 3) continue;
            if (t === n) tier = Math.max(tier, 3);
            else if (t.startsWith(n)) tier = Math.max(tier, 2);
            // A bare "contains" is the only signal ebookjapan offers, so it
            // counts - but only for a title long enough that a stray mention of
            // it in another book's card is unlikely.
            else if (n.length >= 4 && t.includes(n)) tier = Math.max(tier, 1);
        }
        if (!tier) return null;
        return { score: tier + (bonus || 0), len: t.length };
    }

    function hostMatches(hostname, hosts) {
        const h = String(hostname || '').toLowerCase();
        return hosts.some(want => h === want || h.endsWith('.' + want));
    }

    function bestStoreMatch(html, store, candidates) {
        let doc = null;
        try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch (e) { return null; }
        if (!doc) return null;
        let best = null;
        for (const a of doc.querySelectorAll('a[href]')) {
            let url = null;
            try {
                const u = new URL(a.getAttribute('href') || '', store.origin + '/');
                if (!hostMatches(u.hostname, store.hosts)) continue;
                if (!store.product(u.pathname)) continue;
                url = u.origin + u.pathname;
            } catch (e) { continue; }
            const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
            const s = availabilityScore(text, candidates, store.rank(new URL(url).pathname));
            if (!s) continue;
            if (!best || s.score > best.score || (s.score === best.score && s.len < best.len)) {
                best = { score: s.score, len: s.len, url: url, text: text, card: a.outerHTML || '' };
            }
        }
        return best;
    }

    // Price and free-volume detail for the book the user is actually reading,
    // read from the store page we just linked to. Stores that have no such page
    // (ebookjapan) contribute only their search-page badge.
    function blankDetail() {
        return { freeCount: 0, volTotal: 0, freeMine: false, price: null, until: '', volFound: false, rows: 0 };
    }

    async function storeDetail(store, url, cardHtml, volNum, bookTitle) {
        const d = blankDetail();
        // Scoped to the matched result card, never the whole results page: a
        // "N冊無料" badge belongs to one title's card, and the other cards on the
        // page carry their own badges, often larger ones.
        if (typeof store.freeBadge === 'function' && cardHtml) {
            try { d.freeCount = store.freeBadge(cardHtml) || 0; } catch (e) {}
        }
        if (typeof store.volumes !== 'function' || !url) return d;
        let page = null;
        try { page = await gmFetch(url, 15000); } catch (e) { return d; }
        if (!page || page.status !== 200 || !page.text) return d;
        let doc = null;
        try { doc = new DOMParser().parseFromString(page.text, 'text/html'); } catch (e) { return d; }
        if (!doc) return d;
        let items = [];
        try { items = store.volumes(doc) || []; } catch (e) { return d; }
        d.rows = items.length;
        if (!items.length) return d;

        // How many distinct volumes can be read free. A volume with no readable
        // number still counts as one, so a free row is never silently dropped.
        const freeKeys = new Set();
        for (const it of items) {
            if (it.free) freeKeys.add(isFinite(it.vol) && it.vol ? 'v' + it.vol : 't' + it.title);
        }
        d.freeCount = Math.max(d.freeCount, freeKeys.size);
        const vols = new Set();
        for (const it of items) { if (isFinite(it.vol) && it.vol) vols.add(it.vol); }
        d.volTotal = vols.size;

        // Match the row this book actually is. A numbered volume matches on its
        // number; a book with no number (a one-shot, or an unnumbered first
        // volume) can only be matched on its exact title.
        const want = Number(volNum);
        const wantTitle = availabilityNorm(bookTitle || '');
        let mine = [];
        if (isFinite(want) && want > 0) mine = items.filter(it => isFinite(it.vol) && it.vol === want);
        if (!mine.length && wantTitle) mine = items.filter(it => availabilityNorm(it.title) === wantTitle);
        if (!mine.length) return d;
        d.volFound = true;
        const freeOne = mine.find(it => it.free);
        if (freeOne) {
            d.freeMine = true;
            d.until = freeOne.until || '';
            return d;
        }
        const prices = mine.map(it => it.price).filter(p => isFinite(p) && p > 0);
        if (prices.length) d.price = Math.min.apply(null, prices);
        return d;
    }

    // Walk the title candidates until one search page yields a match, so a
    // decorated title ("... 1巻 (ビッグガンガンコミックス)") still lands.
    async function checkStoreAvailability(store, candidates, volNum, bookTitle) {
        for (const cand of candidates) {
            if (!cand) continue;
            let res = null;
            try { res = await gmFetch(store.search(cand), 15000); }
            catch (e) {
                // Every transport failed; do not hammer. Say so, because an
                // unreachable shop and an absent book look identical otherwise.
                if (BWDD_DEBUG) { try { console.info('[bwdd] availability: ' + store.id + ' fetch failed: ' + ((e && e.message) || e)); } catch (_) {} }
                return null;
            }
            if (!res || res.status !== 200 || !res.text) {
                if (BWDD_DEBUG) { try { console.info('[bwdd] availability: ' + store.id + ' HTTP ' + (res && res.status)); } catch (_) {} }
                continue;
            }
            const hit = bestStoreMatch(res.text, store, candidates);
            if (hit) {
                const detail = await storeDetail(store, hit.url, hit.card, volNum, bookTitle);
                return Object.assign({}, hit, detail);
            }
        }
        return null;
    }

    // CMOA's speed-reader URL carries the store page it was opened from as
    // rurl, which is an exact answer for free - no search, no guessing.
    function exactStorePageUrl(store) {
        if (store.id !== 'cmoa') return null;
        try {
            const rurl = new URLSearchParams(location.search).get('rurl');
            if (!rurl) return null;
            const u = new URL(rurl);
            if (!hostMatches(u.hostname, store.hosts)) return null;
            if (!store.product(u.pathname)) return null;
            return u.origin + u.pathname;
        } catch (e) { return null; }
    }

    // "free" when this volume is free; otherwise the price for this volume,
    // alongside how many volumes in the series are free.
    function storeMetaText(r) {
        const bits = [];
        if (r.freeMine) bits.push('free');
        else if (isFinite(r.price) && r.price > 0) bits.push('\u00a5' + r.price.toLocaleString('en-US'));
        // The series count is a separate fact from this volume's own state, so it
        // is reported either way; it is only dropped when it would just repeat
        // "free" for a single free volume.
        if (r.freeCount > 0 && !(r.freeMine && r.freeCount <= 1)) {
            bits.push(r.freeCount + (r.freeCount === 1 ? ' vol free' : ' vols free'));
        }
        return bits.join(' \u00b7 ');
    }

    function storeTipFacts(r, store) {
        const facts = [];
        if (r.freeMine) facts.push('this volume is free' + (r.until ? ' (' + r.until + ')' : ''));
        else if (isFinite(r.price) && r.price > 0) facts.push('this volume is \u00a5' + r.price.toLocaleString('en-US'));
        if (r.freeCount > 0 && !(r.freeMine && r.freeCount <= 1)) {
            const n = r.freeCount;
            if (typeof store.freeBadge === 'function') {
                // ebookjapan renders nothing per-volume, so this number is the
                // shop's own campaign badge rather than rows we counted.
                facts.push('its campaign badge offers ' + n + (n === 1 ? ' volume' : ' volumes') + ' free');
            } else if (r.volTotal > n) {
                facts.push(n + ' of ' + r.volTotal + ' volumes can be read free');
            } else if (n > 1) {
                facts.push('all ' + n + ' volumes can be read free');
            } else {
                facts.push('1 volume can be read free');
            }
        }
        if (!facts.length && r.rows) facts.push('no price or free-volume marker for this volume');
        return facts;
    }

    // The card's CSS travels with the feature: a build that does not include
    // this module carries neither the markup nor the styling.
    const STORE_CSS = `
.bwdd-store-row { display: flex; flex-wrap: wrap; gap: 6px; }
.bwdd-store-link {
  display: inline-flex; align-items: center; gap: 5px;
  border: 1px solid var(--bwdd-border);
  border-radius: 999px;
  padding: 2px 8px 2px 3px;
  font-size: 11px; font-weight: 600; line-height: 1.7;
  text-decoration: none; color: var(--bwdd-text);
  background: var(--bwdd-bg);
}
.bwdd-store-link:hover { border-color: var(--bwdd-store, var(--bwdd-link)); background: var(--bwdd-link-hover-bg); text-decoration: none; }
.bwdd-store-link:focus-visible { outline: 2px solid var(--bwdd-link); outline-offset: 2px; }
.bwdd-store-badge {
  display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; border-radius: 50%;
  background: var(--bwdd-store, #6b7280); color: #fff;
  font-size: 10px; font-weight: 700; line-height: 1; flex: 0 0 auto;
}
.bwdd-store-state { color: var(--bwdd-text-muted); font-weight: 500; }
.bwdd-store-link.is-free .bwdd-store-state { color: #15803d; font-weight: 700; }
`;
    let storeStylesMounted = false;
    function mountStoreStyles() {
        if (storeStylesMounted || typeof document === 'undefined') return;
        storeStylesMounted = true;
        try {
            const style = document.createElement('style');
            style.textContent = STORE_CSS;
            (document.head || document.documentElement).appendChild(style);
        } catch (e) {}
    }

    function renderStoresCard(statsEl, results) {
        if (!statsEl || !results || !results.length) return null;
        mountStoreStyles();
        return upsertCard(statsEl, 'stores', () => {
            // Only shops that actually carry it. A pill for a shop that does not
            // have the book is not an availability badge, it is a search link,
            // and a card with nothing in it is not worth a frame.
            const shown = results.filter(r => r.available);
            if (!shown.length) return null;
            const card = emptyCard('Also available on');
            const row = el('div', 'bwdd-store-row');
            const activeId = (ACTIVE_SITE && ACTIVE_SITE.id) || '';
            for (const r of shown) {
                const store = r.store;
                const here = store.siteId && store.siteId === activeId;
                const meta = storeMetaText(r);
                const a = el('a', 'bwdd-store-link is-found' +
                    ((r.freeMine || r.freeCount > 0) ? ' is-free' : ''));
                a.href = r.url;
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.style.setProperty('--bwdd-store', store.color);
                let tip = (r.why === 'exact')
                    ? store.label + ' \u2014 the store page for this book'
                    : 'On ' + store.label + ' \u2014 open its page for this book';
                const facts = storeTipFacts(r, store);
                if (facts.length) tip += ' \u2014 ' + facts.join('; ');
                if (here) tip += ' (the store you are reading on)';
                a.title = tip;
                a.setAttribute('aria-label', tip);
                const badge = el('span', 'bwdd-store-badge', store.short);
                badge.setAttribute('aria-hidden', 'true');
                a.append(badge, el('span', null, store.label));
                // No "available" filler: an empty state is left empty.
                if (meta) a.appendChild(el('span', 'bwdd-store-state', meta));
                row.appendChild(a);
            }
            card.appendChild(row);
            return card;
        });
    }

    async function lookupAvailability(statsEl, seriesTitle, bookTitle, volNum) {
        const raw = String(seriesTitle || bookTitle || '').trim();
        const seed = cleanStoreSeed(raw) || raw;
        if (!seed || !statsEl) return null;
        const cacheKey = seed + '|' + (volNum == null ? '' : volNum);
        const cached = availabilityMemory.get(cacheKey);
        if (cached) { renderStoresCard(statsEl, cached); return cached; }
        const candidates = [];
        for (const base of [seed, raw]) {
            if (!base) continue;
            for (const c of searchTitleCandidates(base)) {
                if (c && candidates.indexOf(c) === -1) candidates.push(c);
            }
        }
        let work = availabilityInflight.get(cacheKey);
        if (!work) {
            work = Promise.all(AVAILABILITY_STORES.map(async (store) => {
                const base = Object.assign(blankDetail(), { store: store });
                const exact = exactStorePageUrl(store);
                if (exact) {
                    // The viewer told us the store page outright, so go straight to
                    // it for the price and free-volume rows.
                    const d = await storeDetail(store, exact, '', volNum, bookTitle);
                    return Object.assign(base, d, { available: true, url: exact, why: 'exact' });
                }
                try {
                    const hit = await checkStoreAvailability(store, candidates, volNum, bookTitle);
                    if (hit) return Object.assign(base, hit, { available: true, url: hit.url, why: 'match' });
                } catch (e) { /* fall through to the search link */ }
                base.available = false;
                base.why = 'search';
                base.url = store.search(candidates[0] || seed);
                return base;
            }));
            availabilityInflight.set(cacheKey, work);
        }
        let results;
        try { results = await work; }
        finally { if (availabilityInflight.get(cacheKey) === work) availabilityInflight.delete(cacheKey); }
        availabilityMemory.set(cacheKey, results);
        // Session-lifetime cache, one entry per series|volume: drop the oldest
        // rather than letting a long browsing session grow it without bound.
        while (availabilityMemory.size > AVAILABILITY_CACHE_MAX) {
            availabilityMemory.delete(availabilityMemory.keys().next().value);
        }
        if (BWDD_DEBUG) {
            try {
                console.info('[bwdd] availability seed="' + seed + '" vol=' + (volNum == null ? '?' : volNum) +
                    ' -> ' + results.map(r => r.store.id + ':' + (r.available ? 'found' : 'not-carried')).join(' '));
            } catch (e) {}
        }
        renderStoresCard(statsEl, results);
        return results;
    }
