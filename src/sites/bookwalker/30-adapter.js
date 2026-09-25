    // =====================================================================
    // BookWalker site adapter
    // =====================================================================
    // BookWalker is the original site, so its pipeline is unchanged; only its
    // identity and metadata answers are exposed here.
    registerSite({
        id: 'bookwalker',
        label: 'BookWalker',
        panelTitle: 'BookWalker Native Downloader',
        matches() {
            try {
                return /(^|\.)bookwalker\.jp$/i.test(location.hostname);
            } catch (e) { return false; }
        },
        install() {
            // A headless CLI run may deliberately defer the capture and call
            // activateCapture() itself once the page is where it wants it.
            if (!shouldDeferNetworkCapture()) installNetworkCapture();
        },
        getBook() {
            const rawTitle = state.cti || document.title || '';
            const title = cleanTitle(rawTitle) || state.cid || '';
            const sv = splitSeriesVolume(state.cti || title);
            return { rawTitle, title, series: sv.series, volNum: sv.volNum };
        },
        getPreview() { return buildBookPreview(); },
        getCid() { return state.cid || ''; },
        archiveDefault(rawTitle) { return archiveDefaultName(rawTitle) || fsSafePath(state.cid || ''); },
        run(ui, mode, options) { return run(ui, mode, options); },
        state: state,
        // Console surface for this store only; the entry point merges whatever
        // the active adapter puts here into window.__bwdd.
        debug: {
            decodeConfig, pageSeedsNo, A9p, b8gNo, state, buildWorkerSource,
            fetchAndDescramble, cdnFetch, cdnFetchWithFallback,
        },
    });
