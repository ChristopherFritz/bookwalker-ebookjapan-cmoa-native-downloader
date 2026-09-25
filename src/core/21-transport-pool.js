    function workerPoolSize() {
        let cores = 8;
        try { cores = navigator.hardwareConcurrency || 8; } catch (e) {}
        return Math.min(Math.max(4, cores), 16);
    }

    function makePool(size, workerSrc, onDone, jobTimeoutMs, requestedBatchSize, buildMessage) {
        const batchSize = Math.max(1, Math.min(4, requestedBatchSize || WORKER_BATCH_SIZE));
        const queue = [];
        const workers = [];
        const timers = new Map();
        const workerUrl = URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }));
        let nextBatchId = 1;
        let pumpScheduled = false;

        // The job envelope belongs to the site module: BookWalker ships its own
        // relPath/seeds/q shape, ebookjapan ships page geometry and session
        // material. A site that supplies no builder keeps the original shape.
        const messageFor = typeof buildMessage === 'function' ? buildMessage : function (job) {
            const message = {
                id: job.id, relPath: job.relPath, seeds: job.seeds,
                q: job.q, fmt: job.fmt, needCrc: !!job.needCrc, timeoutMs: jobTimeoutMs,
            };
            // The main-thread prefetcher already downloaded this page, so pass
            // the Blob (structured-cloneable, unlike an ArrayBuffer) instead of
            // re-fetching through the six-socket origin.
            if (job.blob) message.blob = job.blob;
            else {
                message.auth = job.auth;
                message.baseUrl = job.baseUrl;
            }
            return message;
        };
        function clearJobTimer(id) {
            const timer = timers.get(id);
            if (timer) clearTimeout(timer);
            timers.delete(id);
        }
        function replaceWorker(w) {
            const idx = workers.indexOf(w);
            if (idx !== -1) workers[idx] = spawn();
            try { w.terminate(); } catch (e) {}
        }
        function failWorker(w, error) {
            const ids = w.jobIds.slice();
            w.busy = false;
            w.batchId = null;
            w.hadTimeout = false;
            w.jobIds = [];
            for (const id of ids) {
                clearJobTimer(id);
                onDone({ id, error });
            }
            replaceWorker(w);
            pump();
        }
        function timeoutJob(w, id) {
            if (!w.jobIds.includes(id)) return;
            clearJobTimer(id);
            w.jobIds = w.jobIds.filter(jobId => jobId !== id);
            w.hadTimeout = true;
            onDone({ id, error: 'timeout' });
            if (w.jobIds.length === 0) releaseWorker(w);
        }
        function releaseWorker(w) {
            w.busy = false;
            w.batchId = null;
            const recycle = w.hadTimeout;
            w.hadTimeout = false;
            // A timed-out page may still own native codec work. Preserve every
            // sibling that did finish, but never reuse that worker.
            if (recycle) replaceWorker(w);
            pump();
        }
        function spawn() {
            const w = new Worker(workerUrl);
            w.busy = false;
            w.batchId = null;
            w.hadTimeout = false;
            w.jobIds = [];
            w.onmessage = (ev) => {
                const result = ev.data && ev.data.result ? ev.data.result : ev.data;
                if (!result || result.id == null || !w.jobIds.includes(result.id)) return;
                if (ev.data.batchId != null && ev.data.batchId !== w.batchId) return;
                if (!result.error && !(result.blob instanceof Blob)) {
                    clearJobTimer(result.id);
                    w.jobIds = w.jobIds.filter(id => id !== result.id);
                    onDone({ id: result.id, error: 'Worker returned no image Blob' });
                    if (w.jobIds.length === 0) releaseWorker(w);
                    return;
                }
                clearJobTimer(result.id);
                w.jobIds = w.jobIds.filter(id => id !== result.id);
                onDone(result);
                if (w.jobIds.length === 0) releaseWorker(w);
            };
            w.onerror = () => failWorker(w, 'worker crash');
            return w;
        }
        for (let i = 0; i < size; i++) workers.push(spawn());

        function pump() {
            let retry = false;
            for (const w of workers) {
                if (w.busy) continue;
                const jobs = [];
                while (jobs.length < batchSize && queue.length) jobs.push(queue.shift());
                if (!jobs.length) break;
                w.busy = true;
                w.jobIds = jobs.map(job => job.id);
                const batchId = nextBatchId++;
                w.batchId = batchId;
                w.hadTimeout = false;
                for (const job of jobs) {
                    timers.set(job.id, setTimeout(() => timeoutJob(w, job.id), jobTimeoutMs));
                }
                try {
                    w.postMessage({ batchId, jobs: jobs.map(messageFor) });
                } catch (e) {
                    for (const job of jobs) {
                        clearJobTimer(job.id);
                        onDone({ id: job.id, error: 'post failed' });
                    }
                    w.busy = false;
                    w.batchId = null;
                    w.hadTimeout = false;
                    w.jobIds = [];
                    retry = true;
                }
            }
            // A failed structured clone leaves this worker idle. Revisit the
            // queue once so one bad job cannot stall every page behind it.
            if (retry) schedulePump();
        }
        function schedulePump() {
            if (pumpScheduled) return;
            pumpScheduled = true;
            Promise.resolve().then(() => {
                pumpScheduled = false;
                pump();
            });
        }
        return {
            // Coalesce synchronous submissions: pumping on every submit would
            // defeat batching before the second page ever reached the queue.
            submit(job) { queue.push(job); schedulePump(); },
            terminate() {
                queue.length = 0;
                for (const w of workers) { try { w.terminate(); } catch (e) {} }
                for (const timer of timers.values()) clearTimeout(timer);
                timers.clear();
                try { URL.revokeObjectURL(workerUrl); } catch (e) {}
            },
        };
    }

    function detectWorkers() {
        try {
            if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return false;
            // The worker source belongs to a site module, so a build without
            // one simply has no worker pool rather than a broken reference.
            if (typeof buildWorkerSource !== 'function') return false;
            const src = buildWorkerSource();
            const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
            const w = new Worker(url);
            w.terminate();
            URL.revokeObjectURL(url);
            return true;
        } catch (e) { return false; }
    }

    async function fetchWithTimeout(url, opts, ms) {
        const ctrl = new AbortController();
        let timer = setTimeout(() => ctrl.abort(), ms);
        let cleared = false;
        const clear = () => {
            if (cleared) return;
            cleared = true;
            clearTimeout(timer);
            timer = null;
        };
        try {
            const res = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
            try { Object.defineProperty(res, '_bwddClearTimeout', { value: clear, configurable: true }); } catch (e) {}
            for (const name of ['arrayBuffer', 'blob', 'formData', 'json', 'text']) {
                if (typeof res[name] !== 'function') continue;
                const original = res[name].bind(res);
                try {
                    Object.defineProperty(res, name, {
                        configurable: true,
                        value: async (...args) => {
                            try { return await original(...args); }
                            finally { clear(); }
                        },
                    });
                } catch (e) {
                    clear();
                }
            }
            return res;
        } catch (e) {
            clear();
            throw e;
        }
    }

    async function releaseResponse(res) {
        try { if (res && res.body && res.body.cancel) await res.body.cancel(); } catch (e) {}
        try { if (res && res._bwddClearTimeout) res._bwddClearTimeout(); } catch (e) {}
    }

    // Chrome allows 6 concurrent HTTP/1.1 connections per origin (scheme + host
    // + PORT), and the CDN is a single HTTP/1.1 host, so the page alone is pinned
    // at 6. Extra lanes: `gm` (Tampermonkey's own pool) and `px:N` (a local helper
    // port; each is a separate origin and the script bounds the fan-out).
    const PROXY_HOST = 'http://127.0.0.1:';
    const PROXY_BASE_PORT = 7010;
    // Each localhost port is a separate HTTP/1.1 origin. Chromium's normal
    // group limit is 6 per origin; it is not a 300-socket global cap. Keep a
    // finite bridge fan-out so a misconfigured helper cannot create unbounded
    // work, while allowing a bridge that exposes more ports to use them.
    const PROXY_MAX_PORTS = 64;
    // A failing port is parked, not deleted: a wide burst can fail every port at
    // once, and deleting them collapses the run onto the 6-socket page lane.
    const PROXY_ERROR_PARK = 12;
    const PROXY_PARK_MAX = 5;
    const PROXY_PARK_MS = 4000;
    let gmUsable = (typeof GM_xmlhttpRequest === 'function');
    const proxyPorts = [];
    const proxyPortSources = new Map();
    const retiredProxyPorts = new Set();

    const laneStats = {};
    function addLane(name) {
        if (!laneStats[name]) {
            laneStats[name] = {
                inflight: 0, done: 0, bytes: 0, ms: 0, errors: 0,
                parkUntil: 0, parks: 0,
            };
        }
        return laneStats[name];
    }
    addLane('page');
    addLane('gm');

    // Chrome keys its socket pool by *site*, so a subdomain of a host we can
    // already reach buys nothing; "host." (trailing dot) is a distinct host and
    // gets its own pool. The signed policy covers a path wildcard, so the dot
    // cannot break the signature, but whether CloudFront serves it is not
    // knowable in advance, so the lane self-verifies on a real page and a
    // rejection costs one request.
    let dotLaneEnabled = false;
    function dottedUrl(url) {
        // Dot the HOSTNAME only: appending it to the authority would give
        // "host:8443." and corrupt the port. The rest of
        // the URL is left byte-identical so the signed query is untouched.
        //   https://a.example.com:8443/x -> https://a.example.com.:8443/x
        return url.replace(/^(https?:\/\/)([^/?#:]+)(:\d+)?/, (m, scheme, hostname, port) => {
            if (hostname.endsWith('.') || /^[\d.]+$/.test(hostname)) return m; // already dotted / an IP
            return scheme + hostname + '.' + (port || '');
        });
    }
    async function probeDotLane(probeUrl) {
        if (!probeUrl) return false;
        try {
            const res = await fetchWithTimeout(dottedUrl(probeUrl), { credentials: 'omit' }, 8000);
            if (res && res.ok) {
                dotLaneEnabled = true;
                addLane('dot');
                const dottedHost = (dottedUrl(probeUrl).match(/^https?:\/\/([^/?#]+)/) || [])[1] || '';
                if (BWDD_DEBUG) {
                    console.info('[bwdd] trailing-dot lane ENABLED: the CDN also serves ' +
                        dottedHost + ' as its own site (+6 sockets)');
                }
                return true;
            }
            if (BWDD_DEBUG) {
                console.info('[bwdd] trailing-dot lane off (probe returned HTTP ' +
                    (res && res.status) + ')');
            }
        } catch (e) {
            if (BWDD_DEBUG) console.info('[bwdd] trailing-dot lane off (' + safeLogText((e && e.message) || e) + ')');
        }
        return false;
    }

    // HTTP/2 edge-mirror lane (self-verifying, strictly opt-in). The CDN answers
    // "http/1.1 only" over ALPN, which is what makes the 6-socket cap bind; a host
    // speaking HTTP/2 multiplexes many streams over one connection (measured: 100
    // concurrent, ~8.9x the direct path). It is the only route past the cap with
    // nothing running locally, but it sends the signed URL through whoever runs
    // the mirror, so it stays opt-in. See bw-edge-mirror.js.
    let edgeUrl = '';
    let edgeToken = '';
    let edgeLaneEnabled = false;

    function loadEdgeConfig() {
        try {
            const stored = localStorage.getItem('bwddEdgeMirror');
            if (stored) edgeUrl = String(stored).replace(/\/+$/, '');
            const tok = localStorage.getItem('bwddEdgeToken');
            if (tok) edgeToken = String(tok);
        } catch (e) {}
        try {
            if (window.__bwddEdgeMirror) edgeUrl = String(window.__bwddEdgeMirror).replace(/\/+$/, '');
            if (window.__bwddEdgeToken) edgeToken = String(window.__bwddEdgeToken);
        } catch (e) {}
        return edgeUrl;
    }

    async function probeEdgeMirror() {
        if (edgeLaneEnabled) return true;
        if (!loadEdgeConfig()) return false;
        try {
            const r = await fetchWithTimeout(edgeUrl + '/__bwdd_health',
                { credentials: 'omit', cache: 'no-store' }, 5000);
            if (!r.ok) {
                console.info('[bwdd] edge mirror off: health returned HTTP ' + r.status);
                return false;
            }
            const j = await r.json();
            if (!j || !j.bwddEdgeMirror) {
                console.info('[bwdd] edge mirror off: that URL is not a bwdd worker');
                return false;
            }
            if (j.tokenRequired && !edgeToken) {
                console.warn('[bwdd] edge mirror needs a token; set localStorage.bwddEdgeToken');
                return false;
            }
            edgeLaneEnabled = true;
            addLane('edge');
            console.info('[bwdd] HTTP/2 edge mirror ENABLED at ' + edgeUrl +
                ': multiplexed streams instead of 6 sockets');
            return true;
        } catch (e) {
            console.info('[bwdd] edge mirror off (' + safeLogText((e && e.message) || e) + ')');
        }
        return false;
    }

    function edgeUrlFor(url) {
        // Same path and signed query, different front-end.
        return edgeUrl + url.replace(/^https?:\/\/[^/]+/, '');
    }

    function allLanes(onlineOnly) {
        const out = [{ name: 'page', kind: 'page' }];
        if (gmUsable) out.push({ name: 'gm', kind: 'gm' });
        if (dotLaneEnabled) out.push({ name: 'dot', kind: 'dot' });
        if (edgeLaneEnabled) out.push({ name: 'edge', kind: 'edge' });
        const now = Date.now();
        for (const p of proxyPorts) {
            if (onlineOnly && !proxyPortOnline(p)) continue;
            const st = laneStats['px:' + p];
            if (st && st.parkUntil > now) continue;
            out.push({ name: 'px:' + p, kind: 'proxy', port: p });
        }
        return out;
    }
    // Six everywhere except the edge mirror, which multiplexes many streams over
    // one HTTP/2 connection, so it should absorb proportionally more traffic.
    function laneCapacity(L) {
        return L && L.kind === 'edge' ? 100 : 6;
    }
    // Sizes the prefetch window: a small multiple of the real socket capacity.
    function fetchSocketBudget(onlineOnly) {
        let n = 0;
        for (const L of allLanes(onlineOnly)) n += laneCapacity(L);
        return n;
    }

    // NOTE: named gmBlobFetch, not gmFetch, the stats section further down
    // already declares a `gmFetch` in this same scope, and a duplicate function
    // declaration hoists with the *last* one winning for the whole scope.
    function gmBlobFetch(url, timeoutMs) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const fail = (msg) => {
                if (settled) return;
                settled = true;
                const e = new Error(msg); e.status = 0; reject(e);
            };
            try {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    timeout: timeoutMs || 45000,
                    responseType: 'blob',
                    onload: (r) => {
                        if (settled) return;
                        settled = true;
                        let body = r.response;
                        if (body instanceof ArrayBuffer) body = new Blob([body], { type: 'image/jpeg' });
                        if (!(body instanceof Blob)) { fail('GM_xhr: no blob body'); return; }
                        const ok = r.status >= 200 && r.status < 300;
                        resolve({ ok, status: r.status, blob: async () => body, _lane: 'gm' });
                    },
                    onerror: () => fail('GM_xhr: request failed'),
                    ontimeout: () => fail('GM_xhr: timeout'),
                    onabort: () => fail('GM_xhr: aborted'),
                });
            } catch (e) { fail('GM_xhr: ' + safeLogText((e && e.message) || e)); }
        });
    }

    // Which hosts the bridge's proxy ports will fetch: it rewrites the request
    // onto x-bwdd-upstream and refuses any host outside its own allowlist, so a
    // port is only usable for a CDN the bridge accepts ("*" = generic). A bridge
    // too old to advertise the list is assumed to serve only the BookWalker CDN,
    // which keeps an existing setup working without aiming a CMOA path at a host
    // that would answer from the wrong CDN.
    let proxyUpstreamPatterns = ['bw-bv-epubs.bookwalker.jp'];
    let proxyDefaultHost = 'bw-bv-epubs.bookwalker.jp';
    function setProxyUpstreams(list, defaultUpstream) {
        if (defaultUpstream) {
            const d = String(defaultUpstream).replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
            if (d) proxyDefaultHost = d;
        }
        if (!Array.isArray(list) || !list.length) return false;
        const patterns = list
            .map(p => String(p || '').toLowerCase().trim())
            .filter(Boolean);
        if (!patterns.length) return false;
        proxyUpstreamPatterns = patterns;
        return true;
    }
    function proxyCanServe(host) {
        const h = String(host || '').toLowerCase();
        if (!h) return false;
        for (const pattern of proxyUpstreamPatterns) {
            if (pattern === '*') return true;
            if (pattern === h) return true;
            if (pattern.indexOf('*') !== -1) {
                const rx = new RegExp('^' + pattern.split('*')
                    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
                    .join('[^.]*') + '$');
                if (rx.test(h)) return true;
            }
        }
        return false;
    }
    function hostOf(url) {
        const m = /^https?:\/\/([^/?#]+)/.exec(String(url || ''));
        return m ? m[1].replace(/:\d+$/, '').toLowerCase() : '';
    }

    function proxyPortOnline(port) {
        const sources = proxyPortSources.get(port);
        return !!(sources && (sources.has('bridge') || sources.has('helper')));
    }

    function activeProxyPortCount() {
        let n = 0;
        for (const sources of proxyPortSources.values()) {
            if (sources.has('bridge') || sources.has('helper')) n++;
        }
        return n;
    }

    function addProxyPorts(list, source) {
        const key = source || 'legacy';
        const advertised = new Set();
        for (const raw of (Array.isArray(list) ? list : [])) {
            const port = parseInt(raw, 10);
            if (port > 0 && port < 65536) advertised.add(port);
        }
        for (const [port, sources] of proxyPortSources) {
            if (!sources.has(key)) continue;
            if (advertised.has(port)) sources.add(key);
            else {
                sources.delete(key);
                if (!sources.size) proxyPortSources.delete(port);
            }
        }
        pruneProxyPorts();
        for (const port of advertised) {
            if (retiredProxyPorts.has(port)) continue;
            if (!proxyPorts.includes(port) && activeProxyPortCount() < PROXY_MAX_PORTS) {
                proxyPorts.push(port);
                addLane('px:' + port);
            }
            if (proxyPorts.includes(port)) {
                const sources = proxyPortSources.get(port) || new Set();
                sources.add(key);
                proxyPortSources.set(port, sources);
            }
        }
    }

    function pruneProxyPorts() {
        for (let i = proxyPorts.length - 1; i >= 0; i--) {
            const port = proxyPorts[i];
            if (!proxyPortOnline(port) || retiredProxyPorts.has(port)) {
                proxyPorts.splice(i, 1);
                delete laneStats['px:' + port];
            }
        }
    }

    function clearProxySource(source) {
        for (const [port, sources] of proxyPortSources) {
            sources.delete(source);
            if (!sources.size) proxyPortSources.delete(port);
        }
        pruneProxyPorts();
    }

    // mokuro-bridge doubles as an accelerator: it serves the CDN on extra
    // localhost ports (each its own 6-socket origin) advertised in /health, so a
    // user already running it for OCR gets those lanes with no setup.
    // Downloading never *depends* on it, no bridge simply means no lanes.
    async function probeBridgeFetchProxy() {
        clearProxySource('bridge');
        try {
            const r = await fetchWithTimeout(MOKURO_BRIDGE_URL + '/health',
                { cache: 'no-store' }, 2500);
            if (!r.ok) return;
            const j = await r.json();
            if (j && (j.fetchUpstreams || j.upstream)) {
                setProxyUpstreams(j.fetchUpstreams, j.upstream);
            }
            if (j && Array.isArray(j.fetchProxyPorts) && j.fetchProxyPorts.length) {
                addProxyPorts(j.fetchProxyPorts, 'bridge');
            }
        } catch (e) { /* bridge not running */ }
    }

    // Discover the optional local fetch proxy. If the helper is not running this
    // is one failed request to a closed local port and the run proceeds on the
    // page + gm lanes exactly as before. If it had to move off 7010 (port in use),
    // point the script at it with `window.__bwddProxyBasePort = 7100;`.
    async function probeFetchProxy() {
        return await discoverProxyPorts();
    }

    // Re-run discovery so the panel's pre-flight indicator lights up bridge ports
    // that started *after* the page loaded; source ownership and retirement decide
    // which lanes remain selectable.
    async function discoverProxyPorts() {
        clearProxySource('helper');
        let basePort = PROXY_BASE_PORT;
        try {
            if (typeof window !== 'undefined' && window.__bwddProxyBasePort) {
                basePort = parseInt(window.__bwddProxyBasePort, 10) || PROXY_BASE_PORT;
            }
        } catch (e) {}
        try {
            const r = await fetchWithTimeout(PROXY_HOST + basePort + '/__bwdd_health',
                { credentials: 'omit', cache: 'no-store' }, 800);
            if (r.ok) {
                const j = await r.json();
                if (j && j.bwddFetchProxy) {
                    if (Array.isArray(j.upstreams) && j.upstreams.length) setProxyUpstreams(j.upstreams);
                    addProxyPorts(
                        Array.isArray(j.portList) && j.portList.length
                            ? j.portList
                            : Array.from(
                                { length: Math.min(PROXY_MAX_PORTS, j.ports || 1) },
                                (_, i) => basePort + i),
                        'helper'
                    );
                }
            }
        } catch (e) { /* helper not running */ }
        await probeBridgeFetchProxy();
        return proxyPorts;
    }

    // Last known bridge reachability, mirrored out of buildUI's poll, for the
    // bridge/OCR status shown in the panel; the per-port source map decides which
    // discovered proxy lanes are usable now.
    let laneBridgeOnline = false;

    function capabilitySummary() {
        const lanes = allLanes(true);
        const ports = lanes.filter(l => l.kind === 'proxy').length;
        const sockets = fetchSocketBudget(true);
        const offlineSockets = 6 + (gmUsable ? 6 : 0) + (dotLaneEnabled ? 6 : 0) +
            (edgeLaneEnabled ? 100 : 0);
        return {
            ports,
            sockets,
            withoutBridge: offlineSockets,
            effectiveSockets: sockets,
            workers: workerPoolSize(),
            decodePages: workerPoolSize() * workerBatchSize(IMAGE_CODEC.type),
            laneCount: lanes.length,
            bridge: ports > 0,
            bridgeOnline: laneBridgeOnline,
        };
    }

    // Least-*utilised* lane wins (in-flight divided by capacity), so the 6-socket
    // lanes fill up while the edge mirror keeps absorbing work; the tie-break
    // rotates so even a low-concurrency run touches every lane.
    let laneRR = 0;
    // allowProxy=false keeps a request off the local fetch-proxy lanes: they are
    // not transparent forwarders, so a port advertised for one store's CDN would
    // answer every other store's path from the wrong host (a 404 at best). A
    // caller fetching a CDN the proxy was not configured for must opt out.
    function pickLane(allowProxy) {
        let lanes = allLanes(true);
        if (allowProxy === false) {
            lanes = lanes.filter(L => L.kind !== 'proxy');
            if (!lanes.length) lanes = [{ name: 'page', kind: 'page' }];
        }
        const n = lanes.length;
        let best = null, bestScore = Infinity;
        for (let i = 0; i < n; i++) {
            const L = lanes[(laneRR + i) % n];
            const score = laneStats[L.name].inflight / laneCapacity(L);
            if (score < bestScore) { bestScore = score; best = L; }
        }
        laneRR = (laneRR + 1) % Math.max(1, n);
        return best;
    }

    function proxyUrlFor(port, url) {
        // Same path + signed query, different origin.
        return PROXY_HOST + port + url.replace(/^https?:\/\/[^/]+/, '');
    }

    // A failing lane is parked (helper port) or retired rather than deleted
    // outright: a wide burst can fail every lane at once, and dropping them
    // collapses the run onto the page lane.
    function laneRetireLimit(lane) {
        if (lane.kind === 'gm') return 5;
        if (lane.kind === 'proxy') return PROXY_ERROR_PARK;
        return 8;   // edge, dot
    }

    function retireLane(lane, err) {
        const st = laneStats[lane.name];
        st.errors = 0;
        const why = safeLogText((err && err.message) || err || '');
        if (lane.kind === 'gm') {
            gmUsable = false;
            console.warn('[bwdd] GM transport disabled after repeated failures:', why);
        } else if (lane.kind === 'edge') {
            edgeLaneEnabled = false;
            console.warn('[bwdd] edge mirror retired: ' + why);
        } else if (lane.kind === 'dot') {
            dotLaneEnabled = false;
            console.warn('[bwdd] trailing-dot lane retired: ' + why);
        } else if (lane.kind === 'proxy') {
            st.parkUntil = Date.now() + PROXY_PARK_MS;
            if (++st.parks >= PROXY_PARK_MAX) {
                const ix = proxyPorts.indexOf(lane.port);
                if (ix !== -1) proxyPorts.splice(ix, 1);
                proxyPortSources.delete(lane.port);
                retiredProxyPorts.add(lane.port);
                console.warn('[bwdd] fetch proxy port ' + lane.port + ' retired after repeated parks');
            }
        }
    }

    async function laneAttempt(lane, url, timeoutMs) {
        const to = timeoutMs || 45000;
        if (lane.kind === 'gm') return await gmBlobFetch(url, to);
        if (lane.kind === 'edge') {
            const opts = { credentials: 'omit' };
            if (edgeToken) opts.headers = { 'x-bwdd-token': edgeToken };
            return await fetchWithTimeout(edgeUrlFor(url), opts, to);
        }
        if (lane.kind === 'dot') {
            return await fetchWithTimeout(dottedUrl(url), { credentials: 'omit' }, to);
        }
        if (lane.kind === 'proxy') {
            // The proxy carries only path + query, so it must be told which CDN
            // the bytes come from. The bridge rejects any host outside its
            // allowlist with a JSON 403, which laneFetch treats as a lane failure
            // rather than an answer from the CDN. A request for the CDN the
            // bridge already defaults to sends no header (so no CORS preflight);
            // only a different CDN names itself, which lets one bridge serve
            // several stores without a second instance.
            const opts = { credentials: 'omit' };
            const host = hostOf(url);
            if (host && host !== proxyDefaultHost) opts.headers = { 'x-bwdd-upstream': host };
            const res = await fetchWithTimeout(proxyUrlFor(lane.port, url), opts, to);
            if (res.status === 403) {
                const ct = res.headers && res.headers.get && res.headers.get('content-type');
                if (ct && ct.indexOf('application/json') !== -1) {
                    await releaseResponse(res);
                    throw new Error('fetch proxy refused host ' + host);
                }
            }
            if (res.status >= 500 && res.status <= 504) {
                await releaseResponse(res);
                throw new Error('fetch proxy transport error ' + res.status);
            }
            return res;
        }
        return await fetchWithTimeout(url, { credentials: 'omit' }, to);
    }

    function tagLane(res, name) {
        try { Object.defineProperty(res, '_lane', { value: name, configurable: true }); } catch (e) {}
        return res;
    }

    async function laneFetch(url, timeoutMs, opts) {
        const lane = pickLane(opts && opts.allowProxy);
        const st = laneStats[lane.name];
        const isPage = lane.kind === 'page';
        const countsNonOk = lane.kind === 'edge' || lane.kind === 'dot';
        st.inflight++;
        try {
            const res = await laneAttempt(lane, url, timeoutMs);
            if (res && res.status >= 500 && res.status <= 504 &&
                (lane.kind === 'edge' || lane.kind === 'dot' || lane.kind === 'gm')) {
                await releaseResponse(res);
                throw new Error('lane transport HTTP ' + res.status);
            }
            if (res && res.ok) st.errors = 0;
            else if (countsNonOk && ++st.errors >= laneRetireLimit(lane)) retireLane(lane, null);
            return tagLane(res, lane.name);
        } catch (e) {
            if (isPage) throw e;
            if (++st.errors >= laneRetireLimit(lane)) retireLane(lane, e);
        } finally {
            st.inflight--;
        }
        return await onPageLane(url, timeoutMs);
    }

    async function onPageLane(url, timeoutMs) {
        laneStats.page.inflight++;
        try {
            return tagLane(await fetchWithTimeout(url, { credentials: 'omit' }, timeoutMs || 45000), 'page');
        } finally {
            laneStats.page.inflight--;
        }
    }

    function recordLane(lane, ms, bytes) {
        const s = laneStats[lane] || laneStats.page;
        s.done++; s.ms += ms; s.bytes += (bytes || 0);
    }

    // Deliberately no per-lane pages/sec: a lane has no wall-clock window of its
    // own, so dividing pages by *summed request time* just reports 1/latency (a
    // real run printed 0.7/s per lane while the batch did 15 pages/s, ~21 requests
    // in flight). Share plus mean latency shows whether a lane is pulling weight.
    function laneSummary() {
        const out = {};
        let total = 0;
        for (const k of Object.keys(laneStats)) total += laneStats[k].done;
        for (const k of Object.keys(laneStats)) {
            const s = laneStats[k];
            if (!s.done) continue;
            out[k] = {
                pages: s.done,
                mb: +(s.bytes / 1048576).toFixed(2),
                avgMs: Math.round(s.ms / s.done),
                share: Math.round(100 * s.done / total) + '%',
            };
        }
        return out;
    }
    // Collapse concurrent requests for the same key onto one promise: retry rounds
    // and duplicated manifest entries legitimately ask for the same page twice
    // otherwise. The entry is dropped as soon as it settles, so a later retry
    // round can still re-fetch a page that genuinely failed.
    function dedupeInflight(map, key, start) {
        let p = map.get(key);
        if (!p) {
            p = start();
            map.set(key, p);
            const drop = () => { if (map.get(key) === p) map.delete(key); };
            p.then(drop, drop);
        }
        return p;
    }


