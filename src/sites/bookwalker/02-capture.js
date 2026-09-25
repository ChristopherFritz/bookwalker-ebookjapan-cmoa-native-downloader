
    function apiOriginFromUrl(url) {
        try {
            const m = url.match(/^(https?:\/\/[^/]+)/);
            return m ? m[1] : null;
        } catch (e) { return null; }
    }
    function recordApiBase(url) {
        const o = apiOriginFromUrl(url);
        if (o) state.apiBase = o;
    }
    function apiBase() {
        if (state.apiBase) return state.apiBase;
        try {
            const configured = window.__BWDD_CLI__ && window.__BWDD_CLI__.publicApiBase;
            if (configured) return String(configured).replace(/\/+$/, '');
        } catch (e) {}
        try { return window.location.origin; } catch (e) { return ''; }
    }

    // Single reader for captured API/config responses, used by both the
    // fetch and XHR hooks below so the two capture paths can never classify an
    // endpoint differently (they once duplicated this and drifted). Handles:
    //   /browserWebApi/c | /trial-page/c  → full auth reply (auth_info + url)
    //   /browserWebApi/pb                 → incremental auth_info (policy refresh)
    //   configuration_pack.json           → encrypted manifest text (best dir wins)
    function absorbApiResponse(url, text) {
        try {
            if (url.includes('/browserWebApi/c') || url.includes('/trial-page/c')) {
                recordApiBase(url);
                const d = JSON.parse(text);
                if (d.auth_info && d.url) { state.auth = d.auth_info; state.baseUrl = d.url; state.cti = d.cti || state.cti; }
                if (d.auth_info && !d.url) { state.auth = Object.assign({}, state.auth || {}, d.auth_info); }
            } else if (url.includes('/browserWebApi/pb')) {
                recordApiBase(url);
                const d = JSON.parse(text);
                if (d.auth_info) {
                    // pb rotates the CloudFront policy; a changed signature
                    // resets the request-count budget.
                    const before = authPolicySig();
                    state.auth = Object.assign({}, state.auth || {}, d.auth_info);
                    if (authPolicySig() !== before) resetAuthBudget();
                }
            } else if (url.includes('configuration_pack.json')) {
                const dir = (url.split('?')[0] || '').replace(/configuration_pack\.json$/, '');
                if (!state.configBody || !state.configFromUrl || configPrio(dir) < configPrio(state.configFromUrl)) {
                    state.configBody = text;
                    state.configFromUrl = dir;
                }
            }
        } catch (e) {}
    }

    // Hooks. Headless callers can defer these wrappers until the automation
    // run starts; some viewer builds keep their document-start loader alive
    // when a fetch wrapper is installed before their own bootstrap finishes.
    let networkCaptureInstalled = false;
    function installNetworkCapture() {
        if (networkCaptureInstalled) return;
        networkCaptureInstalled = true;
        const origFetch = window.fetch;
        window.fetch = function (...args) {
            const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
            const p = origFetch.apply(this, args);
            if (url.includes('/browserWebApi/c') || url.includes('/trial-page/c') ||
                url.includes('/browserWebApi/pb') || url.includes('configuration_pack.json')) {
                p.then(r => r.clone().text()).then(t => absorbApiResponse(url, t)).catch(() => {});
            }
            return p;
        };
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (m, u) { this.__bwUrl = u; return origOpen.apply(this, arguments); };
        XMLHttpRequest.prototype.send = function () {
            try {
                this.addEventListener('load', () => {
                    const u = this.__bwUrl || '';
                    if (u.includes('/browserWebApi/c') || u.includes('/trial-page/c') ||
                        u.includes('/browserWebApi/pb') || u.includes('configuration_pack.json')) {
                        absorbApiResponse(u, this.responseText);
                    }
                });
            } catch (e) {}
            return origSend.apply(this, arguments);
        };
    }
    function shouldDeferNetworkCapture() {
        try {
            return isHeadlessPage() && !!(window.__BWDD_CLI__ && window.__BWDD_CLI__.deferCapture);
        } catch (_) {
            return false;
        }
    }
    // NOTE: the install call lives in this site's adapter (install()), so the
    // entry point can decide per page which store's capture to bring up.
