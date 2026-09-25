    // =====================================================================
    // Initialization
    // =====================================================================
    // One entry point for both stores. The adapter is chosen from the host,
    // given the chance to install its page hooks, and then the shared panel is
    // brought up against it. A host no adapter claims still gets the
    // BookWalker adapter, which is what a bare injected copy expects.
    const BWDD_SITE = detectSite();
    ACTIVE_SITE = BWDD_SITE;
    if (BWDD_SITE && typeof BWDD_SITE.install === 'function') {
        try { BWDD_SITE.install(); } catch (e) {}
    }

    // Install the page API before DOMContentLoaded so a CLI can call start()
    // as soon as the userscript has been injected.
    installHeadlessAutomation();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => bootSharedPanel(BWDD_SITE));
    } else {
        bootSharedPanel(BWDD_SITE);
    }

    if (BWDD_DEBUG && !isHeadlessPage()) {
        try {
            const dbg = {
                cleanTitle, splitSeriesVolume, fsSafePath, zipBaseName, crc32Bytes, buildStoreZip,
                get imageCodec() { return IMAGE_CODEC; }, resolveImageCodec,
                // transport lanes: exposed for the lane/burst test harness
                allLanes, fetchSocketBudget, laneStats, laneSummary, recordLane, dedupeInflight,
                probeFetchProxy, probeDotLane, probeEdgeMirror, discoverProxyPorts,
                setProxyUpstreams, proxyCanServe,
                dottedUrl, edgeUrlFor, proxyPorts, laneFetch, capabilitySummary, workerPoolSize, workerBatchSize, makePool,
                get gmUsable() { return gmUsable; },
            };
            // Whatever the active store wants on the console, so this file never
            // names one of them.
            Object.assign(dbg, (BWDD_SITE && BWDD_SITE.debug) || {});
            window.__bwdd = dbg;
        } catch (e) {}
        try { window.__bwddUI = Object.assign(window.__bwddUI || {}, { renderStatsCards, renderBookCard, renderNativelyCard, renderMangaKotobaCard, setBar, showBars }); } catch (e) {}
        // The active adapter, for the site-adapter tests.
        try { window.__bwddSite = BWDD_SITE; } catch (e) {}
        for (const k in ((BWDD_SITE && BWDD_SITE.debugGlobals) || {})) {
            try { window[k] = BWDD_SITE.debugGlobals[k]; } catch (e) {}
        }
    }
