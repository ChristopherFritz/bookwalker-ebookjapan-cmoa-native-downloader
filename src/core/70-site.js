    // =====================================================================
    // Site adapters — one userscript, three stores
    // =====================================================================
    // A site adapter supplies only the four things that genuinely differ between
    // the stores: detection (which store is this page?), metadata (title,
    // series/volume, page count, archive name), page enumeration (what to fetch,
    // in reading order), and fetch + descramble (one page → finished image Blob).
    // Everything else - panel, controls, bars, Mokuro conversation, stat cards,
    // ZIP naming/assembly, page cache, headless automation - lives in core and is
    // shared verbatim, which is what keeps the paths from drifting apart.
    //
    // Contract:
    //   id, label, panelTitle      identity shown in the panel
    //   matches()                  true when this adapter owns the page
    //   install()                  page hooks; called once, at load
    //   refresh()                  optional: top up metadata before it is read
    //   getBook()                  { rawTitle, title, series, volNum } or null
    //   getPreview()               { title, pages, resolution, type } or null
    //   getCid()                   stable id, used for the page cache
    //   run(ui, mode, options)     the download pipeline for this store
    const SITE_REGISTRY = [];
    let ACTIVE_SITE = null;

    function registerSite(adapter) {
        if (adapter && adapter.id) SITE_REGISTRY.push(adapter);
        return adapter;
    }

    function detectSite() {
        for (const adapter of SITE_REGISTRY) {
            let owned = false;
            try { owned = !!adapter.matches(); } catch (e) { owned = false; }
            if (owned) return adapter;
        }
        // BookWalker is the default: it is the original site for this script,
        // and its panel is also what a bare injected copy (tests, devtools)
        // expects to get on a host no adapter claims.
        return SITE_REGISTRY.find(a => a.id === 'bookwalker') || SITE_REGISTRY[0] || null;
    }

    function activeSite() { return ACTIVE_SITE; }
    function siteCid() {
        if (ACTIVE_SITE && typeof ACTIVE_SITE.getCid === 'function') {
            try { return ACTIVE_SITE.getCid() || ''; } catch (e) { return ''; }
        }
        return '';
    }
    // detectSite() always yields an adapter, so naming one store's pipeline as a
    // fallback here was dead code and a dependency the shared core should not have.
    function siteRun(ui, mode, options) {
        if (ACTIVE_SITE && typeof ACTIVE_SITE.run === 'function') {
            return ACTIVE_SITE.run(ui, mode, options);
        }
        throw new Error('no site adapter is registered for this page');
    }
    function siteLabel() { return (ACTIVE_SITE && ACTIVE_SITE.label) || 'BookWalker'; }
    function sitePanelTitle() {
        return (ACTIVE_SITE && ACTIVE_SITE.panelTitle) || 'BookWalker Native Downloader';
    }

    // Shared panel bring-up. Both stores get the identical UI, the identical
    // button wiring and the identical "wait for the viewer, then show the book
    // card + reading stats" loop; only the adapter's own answers differ.
    function bootSharedPanel(site) {
        ACTIVE_SITE = site;
        installHeadlessAutomation();
        // A headless/CLI page gets no panel, no bridge-health tick and no stats
        // loop: the caller owns all of that.
        if (isHeadlessPage()) return null;

        const ui = buildUI();
        const launch = mode => {
            Promise.resolve()
                .then(() => site.run(ui, mode))
                .catch(e => {
                    const text = safeLogText((e && e.message) || e);
                    console.warn('[bwdd] ' + site.id + ' run failed: ' + text);
                    // A rejected run must land on the panel, not only in the
                    // console, or the bars sit at 0/0 and the click looks like it did
                    // nothing. Un-hide the details box too.
                    try {
                        setRunDetails(ui.details, 'the run failed: ' + text, []);
                        if (ui.details) ui.details.hidden = false;
                    } catch (e2) {}
                });
        };
        ui.btnZip.onclick = () => launch('zip');
        ui.btnOcr.onclick = () => launch('ocr');

        try { schedulePageCachePrune(0); } catch (e) {}
        if (typeof site.afterBoot === 'function') {
            try { site.afterBoot(ui); } catch (e) {}
        }

        (async () => {
            let statsKicked = false;
            let lastStoresKey = null;
            let lastArchiveSource = null;
            // The viewer fills its metadata in asynchronously, so poll briefly
            // rather than reading the title once and settling for document.title.
            for (let i = 0; i < 40; i++) {
                await new Promise(r => setTimeout(r, 500));
                // Let the adapter top up its own metadata first: CMOA's viewer
                // fills its page list in after the document is ready, so the
                // answers below are only as good as the last refresh.
                if (typeof site.refresh === 'function') {
                    try { await site.refresh(); } catch (e) {}
                }
                let book = null;
                try { book = site.getBook(); } catch (e) { book = null; }
                const rawTitle = (book && book.rawTitle) || document.title || '';
                if (rawTitle && rawTitle !== lastArchiveSource) {
                    lastArchiveSource = rawTitle;
                    try { ui.syncArchiveDefault(rawTitle); } catch (e) {}
                }
                if (!statsKicked && book && book.series) {
                    try {
                        fetchAndRenderStats(ui.statsEl, book.series, book.volNum);
                        statsKicked = true;
                    } catch (e) {}
                }
                // Which other shops carry it, linked to their store pages. This
                // re-runs when the title or volume changes rather than latching on the
                // first pass: the viewer publishes metadata asynchronously, and a
                // lookup fired against a placeholder title comes back "not found" at
                // every shop. typeof, not try/catch: the availability module is in the
                // combined build only, so the identifier may not exist at all.
                if (typeof lookupAvailability === 'function' && book && (book.series || book.title)) {
                    const storesKey = String(book.series || book.title).trim() + '|' +
                        (book.volNum == null ? '' : book.volNum);
                    if (storesKey !== lastStoresKey) {
                        lastStoresKey = storesKey;
                        try { lookupAvailability(ui.statsEl, book.series, book.title, book.volNum); } catch (e) {}
                    }
                }
                let preview = null;
                try { preview = site.getPreview(); } catch (e) { preview = null; }
                if (preview) {
                    renderBookCard(ui.statsEl, preview);
                    break;
                }
            }
        })();

        return ui;
    }
