    // =====================================================================
    // CMOA site adapter — run pipeline & registration
    // =====================================================================
    // The shared harness owns the bars, Mokuro session, ZIP assembly and
    // reporting; what is left here is CMOA's own shape: wait for the viewer,
    // enumerate its pages, fetch a bounded number at a time.
    async function cmoaRun(ui, mode, options) {
        const runOptions = normalizeRunOptions(options, mode);
        const runResult = runOptions.automation
            ? (runOptions.result || newAutomationResult(mode, cmoaState.cid || '', runOptions.deferFinalize))
            : null;
        if (runResult) {
            runOptions.result = runResult;
            runOptions.errors = runResult.errors;
        }

        let harness = null;
        try {
            reportRunProgress(runOptions, 'started', { mode: mode, cid: cmoaState.cid || '' });
            cmoaState.qualityBlacklist.clear();
            cmoaState.running = true;
            // Always start at the head of the ladder, whatever rung the viewer
            // itself was using.
            cmoaState.quality = CMOA_QUALITY_ORDER[0];

            // The viewer learns the volume a beat after the page loads; poll
            // rather than failing a click that lands a moment too early.
            let ready = false;
            for (let i = 0; i < 30; i++) {
                await cmoaRefreshState();
                if (cmoaState.ready) { ready = true; break; }
                await new Promise(r => setTimeout(r, 500));
            }
            if (!ready) {
                const missing = cmoaComputeReadiness();
                throw new Error('CMOA reader is not ready yet (missing ' + missing.join(', ') + '). ' +
                    'Open the volume in the speed reader and let a page render, then try again.');
            }
            reportRunProgress(runOptions, 'state-refresh-ready');

            const rawTitle = cmoaState.rawTitle || cmoaState.title || document.title || '';
            const title = cmoaState.title || cmoaCleanTitle(rawTitle) || cmoaState.cid || 'CMOA volume';
            const sv = splitSeriesVolume(title);
            const archiveName = ui.syncArchiveDefault(cmoaState.title || rawTitle) ||
                zipBaseName(sv, title);
            if (runResult) {
                runResult.cid = cmoaState.cid || '';
                runResult.mode = mode;
                runResult.title = title;
                reportRunProgress(runOptions, 'book', { title: title, cid: cmoaState.cid || '' });
            }

            const descriptors = cmoaState.pages.map((page, index) => ({
                index: index + 1,
                src: page.src,
                image: page.image || null,
            }));
            const total = descriptors.length;
            if (!total) throw new Error('CMOA reader reported no pages for this volume.');

            const resolution = (() => {
                const first = cmoaState.pages.find(p => p.width && p.height);
                return first ? (first.width + ' × ' + first.height) : '?';
            })();

            harness = createRunHarness(ui, mode, runOptions, {
                title, archiveName, sv, total, cid: cmoaState.cid,
            });
            harness.setTotal(total);
            if (runResult) {
                runResult.total = total;
                reportRunProgress(runOptions, 'manifest', { total: total, plaintext: true });
            }

            if (!runOptions.headless) {
                renderBookCard(ui.statsEl, {
                    title, pages: total, resolution, type: 'Full Edition',
                });
                if (sv.series) fetchAndRenderStats(ui.statsEl, sv.series, sv.volNum);
            }
            harness.showBars();
            if (harness.mokuro) await harness.mokuro.open();

            // The CDN is HTTP/1.1 only, so the browser pins a download to 6
            // sockets per origin and that cap - not the worker count - sets the
            // ceiling. The trailing-dot hostname is the same server but a
            // different origin, worth 6 more sockets, with no local helper; if it
            // does not answer the lane simply stays off.
            try {
                // Probe with the least-restricted rung, not the best one: a free
                // or trial volume refuses the original rendition, so probing q=0
                // would 403 on exactly the most common volumes and leave the
                // extra origin quietly switched off.
                const probeRung = CMOA_QUALITY_ORDER[CMOA_QUALITY_ORDER.length - 1];
                const probeUrl = cmoaBuildImageUrl(
                    cmoaState.pages[0],
                    probeRung,
                    cmoaState.lastGoodToken || cmoaState.token || cmoaState.tokenPool[0] || null
                );
                await probeDotLane(probeUrl);
            } catch (e) {
                cmoaLog('dot lane probe skipped', safeLogText(e && e.message));
            }

            let nextIndex = 0;
            const worker = async () => {
                while (true) {
                    const i = nextIndex++;
                    if (i >= total) return;
                    const descriptor = descriptors[i];
                    const pageIdx = descriptor.index;
                    try {
                        // A page from a previous run needs neither a fetch nor a
                        // descramble; replaying it keeps a resumed volume cheap.
                        let cached = null;
                        if (runOptions.usePageCache && cmoaState.cid) {
                            cached = await getCachedPage(cmoaState.cid, pageIdx);
                        }
                        if (cached) {
                            harness.bumpCached(1);
                            harness.noteCached(pageIdx, cached, cachedPageCrc.get(cached));
                            continue;
                        }
                        const processed = await cmoaFetchPage(descriptor, i);
                        harness.bumpFetched(1);
                        if (processed && processed.blob) {
                            harness.notePage(pageIdx, processed.blob, undefined, processed.ext);
                        } else {
                            harness.noteFailure(pageIdx, 'page ' + pageIdx + ': empty response');
                        }
                    } catch (e) {
                        harness.bumpFetched(1);
                        harness.noteFailure(pageIdx, safeLogText((e && e.message) || e));
                    }
                }
            };
            // Size the fan-out from real transport capacity, like the BookWalker
            // pipeline: every online lane carries ~6 connections and is a
            // separate origin, so the page's 6-connection ceiling is not the
            // limit. A hardcoded worker count leaves those ports idle, which is
            // what made CMOA run at one page per request round-trip.
            const LANE_SLOTS = fetchSocketBudget(true);
            // Unlike BookWalker, a CMOA worker *is* its own concurrency: it
            // holds a fetched page then a decoded bitmap, so the ceiling is about
            // memory as much as sockets. 256 matches what the bridge can feed (48
            // proxy ports x 6 sockets plus the page and dot origins) while staying
            // short of the browser's ~300 socket budget; lower it with
            // window.__bwddMaxInflight if a low-RAM machine starts swapping.
            let inflightCap = 256;
            try {
                if (typeof window !== 'undefined' && window.__bwddMaxInflight > 0) {
                    inflightCap = Math.max(4, Math.min(256, window.__bwddMaxInflight | 0));
                }
            } catch (e) {}
            const concurrency = Math.max(
                Math.max(1, Math.min(CMOA_FETCH_CONCURRENCY, total)),
                Math.min(inflightCap, Math.min(total,
                    LANE_SLOTS + Math.max(8, Math.round(LANE_SLOTS * 0.2))))
            );
            if (BWDD_DEBUG) {
                console.info('[bwdd/cmoa] lanes=' + allLanes().length + ' sockets=' + LANE_SLOTS +
                    ' page workers=' + concurrency);
            }

            const workers = [];
            for (let w = 0; w < concurrency; w++) workers.push(worker());
            await Promise.all(workers);

            // Retry failed pages once after re-reading viewer state: a token
            // rollover mid-run is the common cause.
            if (harness.failedIdx.size && !runOptions.headless) {
                await cmoaRefreshState();
                const retry = descriptors.filter(d => harness.failedIdx.has(d.index));
                for (const descriptor of retry) {
                    try {
                        const processed = await cmoaFetchPage(descriptor, descriptor.index - 1);
                        if (processed && processed.blob) harness.notePage(descriptor.index, processed.blob, undefined, processed.ext);
                    } catch (e) { /* stays failed; reported below */ }
                }
            }

            const missing = total - harness.okIdx.size;

            if (mode === 'ocr' && harness.mokuro) {
                await harness.mokuro.settle();
                if (runOptions.deferFinalize) return harness.mokuro.deferred();
                const fin = await harness.mokuro.finalize();
                harness.markFinished();
                return harness.outcome(fin.ok);
            }

            if (mode === 'ocr' && !harness.mokuro) {
                throw new Error('Mokuro OCR is unavailable for this run');
            }

            if (missing === total) {
                setRunDetails(harness.details, msgAllFailedZip(), harness.errors);
                return harness.outcome(false);
            }
            return await harness.finishZip();
        } catch (e) {
            const reported = harness ? harness.reportFailure(e) : null;
            if (reported) throw reported;
            throw e;
        } finally {
            cmoaState.running = false;
            if (harness) await harness.cleanup();
        }
    }

    registerSite({
        id: 'cmoa',
        label: 'CMOA',
        panelTitle: 'CMOA Native Downloader',
        matches() {
            try {
                return /(^|\.)cmoa\.jp$/i.test(location.hostname);
            } catch (e) { return false; }
        },
        install() {
            try { cmoaInstallCapture(); } catch (e) {}
        },
        getBook() {
            if (!cmoaState.title && !cmoaState.rawTitle) return null;
            const title = cmoaState.title || cmoaCleanTitle(cmoaState.rawTitle);
            const sv = splitSeriesVolume(title);
            return { rawTitle: cmoaState.title || cmoaState.rawTitle, title: title, series: sv.series, volNum: sv.volNum };
        },
        getPreview() {
            if (!cmoaState.ready || !cmoaState.pages.length) return null;
            const first = cmoaState.pages.find(p => p.width && p.height);
            const title = cmoaState.title || cmoaCleanTitle(cmoaState.rawTitle) || cmoaState.cid;
            return {
                title: title,
                pages: cmoaState.pages.length,
                resolution: first ? (first.width + ' × ' + first.height) : '?',
                type: 'CMOA Speed Reader',
            };
        },
        getCid() { return cmoaState.cid || ''; },
        // The panel calls this before getBook/getPreview, so the page list and
        // real title show up as soon as the viewer has them.
        refresh() { return cmoaRefreshState(); },
        afterBoot() {
            // Keep refreshing while the viewer is still coming up; stop as soon
            // as it is ready so an idle page does not poll forever.
            let ticks = 0;
            const timer = setInterval(async () => {
                ticks++;
                if (cmoaState.ready || ticks > 60) { clearInterval(timer); return; }
                try { await cmoaRefreshState(); } catch (e) {}
            }, 1500);
        },
        archiveDefault(rawTitle) { return archiveDefaultName(rawTitle) || fsSafePath(cmoaState.cid || ''); },
        run(ui, mode, options) { return cmoaRun(ui, mode, options); },
        state: cmoaState,
        debug: { cmoaState },
        debugGlobals: { __bwddCmoa: cmoaState },
    });
