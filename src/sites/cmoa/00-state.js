    // =====================================================================
    // CMOA site adapter — metadata
    // =====================================================================
    // CMOA (コミックシーモア) serves its "speed reader" from a per-volume CDN
    // (binb-cmoa.akamaized.net) as individually scrambled JPEG tiles. The page
    // list lives on viewer.content.page, and the viewer's reader exposes
    // getImageDescrambleCoords(), the only correct way to unshuffle a page.
    //
    // Everything the user sees (panel, bars, Mokuro bridge, stats, automation
    // protocol) comes from core, identical to the BookWalker path.
    // The image endpoint's `q` parameter is a quality *index* and lower is
    // better: the reader's own getImageUrl() uses q=0 for high-quality images
    // and q=1 for the viewer default, never 2 or 3. So the ladder tries the
    // original first and falls back to the standard rendition only when the
    // store refuses the best one (as a free/trial volume does).
    const CMOA_QUALITY_ORDER = (function () {
        try {
            const custom = window.__bwddCmoaQualityOrder;
            if (Array.isArray(custom) && custom.length && custom.every(q => /^[0-9]+$/.test(String(q)))) {
                return custom.map(String);
            }
        } catch (e) {}
        return ['0', '1'];
    })();
    const CMOA_FETCH_CONCURRENCY = 6;
    const cmoaState = {
        // True while a download owns the quality field, so a state refresh
        // cannot reset the rung the run has settled on.
        running: false,
        cid: null,
        contentsServer: null,
        token: null,
        viewMode: null,
        dmytime: null,
        u0: null,
        u1: null,
        extraParams: {},
        title: null,          // display title (SubTitle when the API gives one)
        rawTitle: null,       // whatever the page/viewer called this volume
        pages: [],
        quality: null,
        originalQuality: null,
        ready: false,
        collecting: false,
        error: null,
        tokenPool: [],
        lastGoodToken: null,
        reader: null,
        viewer: null,
        qualityBlacklist: new Set(),
    };

    // The viewer's globals (SpeedBinb, its reader) live on the page window. A
    // userscript manager may hand us a sandboxed `window`, so prefer the real
    // page window when it is reachable and fall back when it is not.
    function cmoaPageWindow() {
        try {
            if (typeof unsafeWindow !== 'undefined' && unsafeWindow) {
                if (unsafeWindow.SpeedBinb) return unsafeWindow;
            }
        } catch (e) {}
        return window;
    }

    function cmoaLog() {
        if (!BWDD_DEBUG) return;
        try { console.log.apply(console, ['[bwdd/cmoa]'].concat([].slice.call(arguments))); } catch (e) {}
    }

    // --- token pool -------------------------------------------------------
    // CMOA signs image requests with a short-lived `p` token that the viewer
    // mints as the reader pages through the volume. Keeping every token seen
    // and retrying the next on a 403 is what makes a long download survive a
    // token rolling over mid-run.
    function cmoaRememberToken(tokenValue, options) {
        options = options || {};
        if (!tokenValue && tokenValue !== 0) return;
        const token = String(tokenValue).trim();
        if (!token || token.toLowerCase() === 'null') return;
        if (!cmoaState.tokenPool.includes(token)) cmoaState.tokenPool.push(token);
        if (options.markGood) cmoaState.lastGoodToken = token;
        if (!cmoaState.token || options.force || (options.prefer && cmoaState.token !== token)) {
            cmoaState.token = token;
        }
    }

    function cmoaEvictToken(tokenValue) {
        if (!tokenValue && tokenValue !== 0) return;
        const token = String(tokenValue).trim();
        if (!token) return;
        cmoaState.tokenPool = cmoaState.tokenPool.filter(t => t !== token);
        if (cmoaState.lastGoodToken === token) cmoaState.lastGoodToken = null;
        if (cmoaState.token === token) {
            cmoaState.token = cmoaState.lastGoodToken || cmoaState.tokenPool[0] || null;
        }
    }

    // --- parameter ingestion ---------------------------------------------
    // Every URL the viewer touches (page URL, data-ptbinb, its API calls)
    // carries a slice of the session; merge them all in, first writer wins for
    // the identity fields.
    function cmoaAssignParam(key, rawValue, force) {
        if (rawValue == null) return;
        const value = typeof rawValue === 'string' ? rawValue.trim() : String(rawValue);
        if (!value) return;
        const lower = key.toLowerCase();
        const shouldSet = current => force || current == null || current === '';
        if (lower === 'cid') { if (shouldSet(cmoaState.cid)) cmoaState.cid = value; return; }
        if (lower === 'contentsserver' || lower === 'sbcurl') {
            if (shouldSet(cmoaState.contentsServer)) cmoaState.contentsServer = value.replace(/\/$/, '');
            return;
        }
        if (lower === 'p' || lower === 'token') { cmoaRememberToken(value, { force: force }); return; }
        if (lower === 'vm' || lower === 'viewmode') { if (shouldSet(cmoaState.viewMode)) cmoaState.viewMode = value; return; }
        if (lower === 'dmytime' || lower === 'contentdate') { if (shouldSet(cmoaState.dmytime)) cmoaState.dmytime = value; return; }
        if (lower === 'qualitymode' || lower === 'quality' || lower === 'q') {
            cmoaState.originalQuality = value;
            if (force || !cmoaState.quality) cmoaState.quality = value;
            return;
        }
        if (lower === 'u0') { if (shouldSet(cmoaState.u0)) cmoaState.u0 = value; return; }
        if (lower === 'u1') { if (shouldSet(cmoaState.u1)) cmoaState.u1 = value; return; }
        cmoaState.extraParams[key] = value;
    }

    function cmoaApplySearchParams(searchParams, force) {
        if (!searchParams || typeof searchParams.forEach !== 'function') return;
        searchParams.forEach((value, key) => cmoaAssignParam(key, value, force));
    }

    function cmoaGatherFromUrl() {
        try {
            cmoaApplySearchParams(new URLSearchParams(location.search || ''));
            if (!cmoaState.cid) {
                const m = location.href.match(/[?&]cid=([^&#]+)/);
                if (m) cmoaState.cid = decodeURIComponent(m[1]);
            }
        } catch (e) {}
    }

    function cmoaGatherFromDataset() {
        let node = null;
        try { node = document.querySelector('[data-ptbinb]'); } catch (e) {}
        if (!node) return;
        const attr = node.getAttribute('data-ptbinb');
        if (attr) {
            try {
                cmoaApplySearchParams(new URL(attr, location.origin).searchParams);
            } catch (e) {
                const i = attr.indexOf('?');
                if (i !== -1) cmoaApplySearchParams(new URLSearchParams(attr.slice(i + 1)));
            }
        }
        const cidAttr = node.getAttribute('data-ptbinb-cid');
        if (cidAttr && !cmoaState.cid) cmoaState.cid = cidAttr;
    }

    // The viewer's performance timeline still holds the signed URLs it used,
    // including the ContentsServer origin, token and quality. This is what
    // keeps working when the script starts after the viewer's own requests.
    function cmoaExtractFromPerformance() {
        if (!window.performance || typeof window.performance.getEntriesByType !== 'function') return;
        let entries = [];
        try { entries = window.performance.getEntriesByType('resource') || []; } catch (e) { return; }
        for (const entry of entries) {
            const name = entry && entry.name;
            if (typeof name !== 'string') continue;
            if (!/sbcGet(?:Cntnt|Img)\.php/i.test(name)) continue;
            let parsed = null;
            try { parsed = new URL(name, location.origin); } catch (e) { continue; }
            const cidParam = parsed.searchParams.get('cid');
            if (cmoaState.cid && cidParam && cidParam !== cmoaState.cid) continue;
            if (/sbcGetCntnt\.php/i.test(parsed.pathname)) {
                const base = new URL('.', parsed).href.replace(/\/$/, '');
                if (!cmoaState.contentsServer) cmoaState.contentsServer = base;
                cmoaApplySearchParams(parsed.searchParams, true);
            } else {
                const q = parsed.searchParams.get('q');
                if (q) cmoaState.originalQuality = q;
                const p = parsed.searchParams.get('p');
                if (p) cmoaRememberToken(p, { prefer: true });
                const vm = parsed.searchParams.get('vm');
                if (vm && !cmoaState.viewMode) cmoaState.viewMode = vm;
                const dmy = parsed.searchParams.get('dmytime');
                if (dmy && !cmoaState.dmytime) cmoaState.dmytime = dmy;
            }
        }
    }

    // --- viewer access ----------------------------------------------------
    function cmoaGetViewer() {
        try {
            const w = cmoaPageWindow();
            if (w.SpeedBinb && typeof w.SpeedBinb.getInstance === 'function') {
                return w.SpeedBinb.getInstance('content');
            }
        } catch (e) {}
        return null;
    }

    function cmoaSafe(fn) {
        try { return fn(); } catch (e) { return null; }
    }

    function cmoaIsReader(candidate) {
        return !!(candidate && typeof candidate.getImageDescrambleCoords === 'function');
    }

    // The reader is the object that can unshuffle a page. Ask the viewer
    // directly first, then walk one level of its own properties, because the
    // exact accessor has changed between viewer builds.
    function cmoaGetReader() {
        const viewer = cmoaState.viewer || cmoaGetViewer();
        if (!viewer) return cmoaState.reader;
        const direct = cmoaSafe(() => viewer.reader);
        if (cmoaIsReader(direct)) return direct;
        if (typeof direct === 'function') {
            const invoked = cmoaSafe(() => direct.call(viewer));
            if (cmoaIsReader(invoked)) return invoked;
        }
        const viaGetter = cmoaSafe(() => (typeof viewer.getReader === 'function' ? viewer.getReader() : null));
        if (cmoaIsReader(viaGetter)) return viaGetter;
        const seeds = [viewer, cmoaSafe(() => viewer.content), cmoaSafe(() => viewer.state)];
        for (const seed of seeds) {
            if (!seed || typeof seed !== 'object') continue;
            if (cmoaIsReader(seed)) return seed;
            let keys = [];
            try { keys = Object.keys(seed); } catch (e) { keys = []; }
            for (const key of keys) {
                if (!/reader/i.test(key)) continue;
                const value = cmoaSafe(() => seed[key]);
                if (cmoaIsReader(value)) return value;
                if (typeof value === 'function') {
                    const invoked = cmoaSafe(() => value.call(seed));
                    if (cmoaIsReader(invoked)) return invoked;
                }
            }
        }
        return cmoaState.reader;
    }

    // Page list. Each entry keeps the image descriptor the viewer parsed from
    // the volume's XML (relative path, dimensions, spread hint) because that
    // descriptor is what getImageDescrambleCoords() expects, not a flat path.
    function cmoaCollectPages(viewer) {
        const pages = [];
        if (!viewer) return pages;
        const pageArray = cmoaSafe(() => {
            const content = viewer.content;
            return content && content.page;
        });
        if (!Array.isArray(pageArray)) return pages;
        const seen = new Set();
        pageArray.forEach((entry, idx) => {
            const image = cmoaSafe(() => entry && entry.image) || null;
            const src = (image && typeof image.src === 'string') ? image.src.trim()
                : (entry && typeof entry.src === 'string' ? entry.src.trim() : '');
            if (!src || seen.has(src)) return;
            seen.add(src);
            pages.push({
                index: idx,
                src: src,
                id: (entry && entry.id) || (image && image.id) || 'page_' + (idx + 1),
                width: image && Number.isFinite(Number(image.orgwidth)) ? Number(image.orgwidth) : null,
                height: image && Number.isFinite(Number(image.orgheight)) ? Number(image.orgheight) : null,
                spread: image && typeof image.pagespread !== 'undefined' ? image.pagespread : null,
                image: image || null,
            });
        });
        pages.sort((a, b) => a.index - b.index);
        return pages;
    }

    // --- content info -----------------------------------------------------
    // The viewer only keeps items[0].Title, the store's SEO page title
    // ("無料・試し読みページ … ｜ author ｜ 漫画…"). The API also returns a clean
    // SubTitle ("… 1巻"), so re-issuing the viewer's own request gives the
    // archive a real name and the stat lookups a real series to search for.
    function cmoaContentInfoUrl() {
        const reader = cmoaGetReader();
        const fromReader = cmoaSafe(() => reader && reader.requestUrl);
        if (typeof fromReader === 'string' && /bibGetCntntInfo/i.test(fromReader)) return fromReader;
        if (!cmoaState.cid) return null;
        const u0 = cmoaState.u0 || '1';
        return location.origin + '/bib/sws/bibGetCntntInfo.php?cid=' +
            encodeURIComponent(cmoaState.cid) + '&dmytime=' + Date.now() + '&u0=' + encodeURIComponent(u0);
    }

    function cmoaIngestContentInfo(payload, sourceUrl) {
        let data = payload;
        if (typeof payload === 'string') {
            try { data = JSON.parse(payload); } catch (e) { data = null; }
        }
        if (data && typeof data === 'object' && Array.isArray(data.items) && data.items.length) {
            const item = data.items[0] || {};
            if (item.ContentsServer && !cmoaState.contentsServer) {
                cmoaState.contentsServer = String(item.ContentsServer).replace(/\/$/, '');
            }
            if (item.p) cmoaRememberToken(item.p, { force: !cmoaState.lastGoodToken });
            if (item.ViewMode != null && cmoaState.viewMode == null) cmoaState.viewMode = String(item.ViewMode);
            if (item.ContentDate && !cmoaState.dmytime) cmoaState.dmytime = String(item.ContentDate);
            // Prefer the clean product title the store itself uses for the
            // volume; fall back to the SEO title only when it is absent.
            const clean = typeof item.SubTitle === 'string' ? item.SubTitle.trim() : '';
            const raw = typeof item.Title === 'string' ? item.Title.trim() : '';
            if (clean) cmoaState.title = clean;
            if (raw) cmoaState.rawTitle = raw;
            if (!cmoaState.title && raw) cmoaState.title = cmoaCleanTitle(raw);
        }
        if (typeof sourceUrl === 'string') {
            try { cmoaApplySearchParams(new URL(sourceUrl, location.href).searchParams, true); } catch (e) {}
        }
    }

    async function cmoaFetchContentInfo() {
        if (cmoaState.title && cmoaState.contentsServer) return true;
        const url = cmoaContentInfoUrl();
        if (!url) return false;
        try {
            const res = await fetchWithTimeout(url, {
                headers: { 'Accept': 'application/json, text/javascript, */*; q=0.01' },
                credentials: 'include',
            }, 15000);
            if (!res || !res.ok) return false;
            const text = await res.text();
            cmoaIngestContentInfo(text, url);
            return true;
        } catch (e) {
            cmoaLog('content info fetch failed', safeLogText(e && e.message));
            return false;
        }
    }

    // The SEO title is "<label> <volume> ｜ <author> ｜ <store>"; the volume is
    // the part before the first full-width pipe, minus the store's own prefix.
    const CMOA_JUNK_TITLE = /^(?:binb(?:\s*speed\s*reader)?|speed\s*binb(?:\s*reader)?|speed\s*reader|cmoa|コミックシーモア|無料[・･]?試し読み(?:ページ)?|試し読みページ|ローディング|loading)$/i;
    function cmoaCleanTitle(raw) {
        let s = String(raw || '').trim();
        if (!s) return '';
        s = s.split('｜')[0].trim();
        s = s.replace(/^(?:無料[・･]?)?(?:試し読み|立ち読み)(?:ページ)?\s*/, '').trim();
        // A trailing imprint group ("（ビッグガンガンコミックス）") belongs to the
        // publisher, not the series, and would derail the manga-kotoba search.
        const m = s.match(/^(.*?[0-9０-９]{1,3}\s*[巻話])\s*[（(][^）)]*[）)]\s*$/);
        if (m && m[1]) s = m[1].trim();
        // The viewer rewrites document.title to its own name ("BinB Speed
        // Reader") once it boots; that is not the volume's title.
        if (CMOA_JUNK_TITLE.test(s)) return '';
        return s;
    }

    // Where the volume title can come from, best first. The viewer's own
    // bibliography only ever carries the store's SEO title, so the API's
    // SubTitle (see cmoaIngestContentInfo) is the one that yields a real name.
    function cmoaTitleFromDom() {
        // The reader's header still holds the SEO title after the viewer has
        // replaced document.title with its own name.
        try {
            const el = document.getElementById('menu_header_tittle');
            const t = el && el.textContent ? el.textContent.trim() : '';
            if (t) return t;
        } catch (e) {}
        return document.title || '';
    }

    // --- readiness --------------------------------------------------------
    function cmoaComputeReadiness() {
        const missing = [];
        if (!cmoaState.cid) missing.push('content ID');
        if (!cmoaState.contentsServer) missing.push('contents server');
        if (!cmoaState.pages.length) missing.push('page list');
        cmoaState.ready = missing.length === 0;
        return missing;
    }

    async function cmoaRefreshState() {
        if (cmoaState.collecting) return;
        cmoaState.collecting = true;
        try {
            cmoaGatherFromUrl();
            cmoaGatherFromDataset();
            cmoaExtractFromPerformance();
            // The performance timeline normally supplies the contents server and
            // the token before this runs, but it can never supply the volume's
            // real name: only bibGetCntntInfo carries SubTitle. So fetch until we
            // actually have a title, not merely until we can fetch pages.
            if (!cmoaState.contentsServer || !cmoaState.token || !cmoaState.title) {
                await cmoaFetchContentInfo();
            }
            const viewer = cmoaGetViewer();
            if (viewer) {
                cmoaState.viewer = viewer;
                const pages = cmoaCollectPages(viewer);
                if (pages.length) cmoaState.pages = pages;
                const reader = cmoaGetReader();
                if (reader) cmoaState.reader = reader;
            }
            if (!cmoaState.title) {
                const fromViewer = cmoaSafe(() => viewer && viewer.content && viewer.content.bibliography && viewer.content.bibliography.title);
                // The reader header keeps the store's SEO title even after the
                // viewer has renamed document.title, so it ranks above it.
                const candidates = [cmoaState.rawTitle, cmoaTitleFromDom(), fromViewer, document.title];
                for (const cand of candidates) {
                    const cleaned = cmoaCleanTitle(cand);
                    if (cleaned) {
                        cmoaState.rawTitle = cand;
                        cmoaState.title = cleaned;
                        break;
                    }
                }
            }
            // A run in progress owns this field (cmoaFetchPage records the rung
            // that actually worked), so a state refresh must not fight it. When
            // idle, always reset to the head of the ladder: the viewer's own
            // default (q=1) must never cap what we are willing to fetch.
            if (!cmoaState.running && cmoaState.quality !== CMOA_QUALITY_ORDER[0]) {
                cmoaState.quality = CMOA_QUALITY_ORDER[0];
            }
            if (BWDD_DEBUG) {
                cmoaLog('state', {
                    cid: cmoaState.cid, title: cmoaState.title, raw: cmoaState.rawTitle,
                    server: cmoaState.contentsServer, token: !!cmoaState.token,
                    quality: cmoaState.quality, pages: cmoaState.pages.length,
                });
            }
            cmoaComputeReadiness();
        } catch (e) {
            cmoaState.error = e;
            cmoaLog('state refresh failed', safeLogText(e && e.message));
        } finally {
            cmoaState.collecting = false;
        }
    }

    // --- passive capture --------------------------------------------------
    // Everything above already works without this, so the fetch wrapper is a
    // best-effort bonus: it keeps the token pool and quality fresh while the
    // user pages, which is what lets a long download ride out a token rollover.
    let cmoaCaptureInstalled = false;
    function cmoaInstallCapture() {
        if (cmoaCaptureInstalled) return;
        cmoaCaptureInstalled = true;
        const w = cmoaPageWindow();
        const nativeFetch = typeof w.fetch === 'function' ? w.fetch.bind(w) : null;
        if (!nativeFetch) return;
        try {
            w.fetch = function (...args) {
                let url = '';
                try {
                    const input = args[0];
                    url = typeof input === 'string' ? input : ((input && input.url) || '');
                } catch (e) { url = ''; }
                const promise = nativeFetch(...args);
                if (url && /sbcGet(?:Cntnt|Img)\.php|bibGetCntntInfo\.php/i.test(url)) {
                    promise.then(res => {
                        try {
                            if (/bibGetCntntInfo\.php/i.test(url)) {
                                return res.clone().text().then(text => cmoaIngestContentInfo(text, url)).catch(() => {});
                            }
                            if (/sbcGetImg\.php/i.test(url)) {
                                let parsed = null;
                                try { parsed = new URL(url, location.href); } catch (e) { return; }
                                const token = parsed.searchParams.get('p');
                                if (token) {
                                    if (res.status === 403) cmoaEvictToken(token);
                                    else cmoaRememberToken(token, { markGood: res.ok, force: res.ok && !cmoaState.lastGoodToken });
                                }
                            }
                        } catch (e) {}
                        return null;
                    }).catch(() => {});
                }
                return promise;
            };
        } catch (e) { /* a frozen fetch is not fatal: passive capture is optional */ }
    }

