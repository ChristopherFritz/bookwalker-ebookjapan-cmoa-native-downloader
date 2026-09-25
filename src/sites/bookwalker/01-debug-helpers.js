    // BookWalker-only helper: locate the viewer's own NFBR engine object, which
    // holds the signed auth the capture hooks read. BWDD_DEBUG itself lives in
    // the shared core now.
    function findInNFBR(win) {
        const out = { auth: null, baseUrl: null, config: null, cti: null };
        if (!win || !win.NFBR) return out;
        const seen = new Set();
        let budget = 200000;
        function isPlain(o) { return o && typeof o === 'object' && !Array.isArray(o) && !(o instanceof Date) && !(o instanceof RegExp); }
        function skipVal(v) {
            if (v instanceof ArrayBuffer) return true;
            if (ArrayBuffer.isView && ArrayBuffer.isView(v)) return true;
            if (typeof Node !== 'undefined' && v instanceof Node) return true;
            return false;
        }
        function looksLikeAuth(o) {
            return o && typeof o === 'object' && typeof o.Policy === 'string' &&
                typeof o.Signature === 'string' && typeof o['Key-Pair-Id'] === 'string';
        }
        function looksLikeAuthInfo(o) {
            return o && typeof o === 'object' && o.auth_info && looksLikeAuth(o.auth_info);
        }
        function looksLikeConfig(o) {
            return o && typeof o === 'object' && o.configuration && o.configuration.contents &&
                Array.isArray(o.configuration.contents) && o.configuration.contents.length > 0;
        }
        function walk(o, depth) {
            if (!isPlain(o) || depth > 9 || seen.has(o) || budget <= 0) return;
            seen.add(o);
            budget--;
            if (!out.baseUrl && typeof o.url === 'string' && o.url.indexOf('bw-bv-epubs') !== -1 && looksLikeAuthInfo(o)) {
                out.baseUrl = o.url.replace(/\/$/, '') + '/';
                out.auth = o.auth_info;
                if (typeof o.cti === 'string') out.cti = o.cti;
            }
            if (!out.auth && looksLikeAuth(o)) out.auth = o;
            if (!out.config && looksLikeConfig(o)) out.config = o;
            if (out.auth && out.baseUrl && out.config) return;
            for (const k of Object.keys(o)) {
                if (budget <= 0) return;
                const v = o[k];
                if (skipVal(v)) continue;
                if (isPlain(v)) walk(v, depth + 1);
            }
        }
        try {
            walk(win.NFBR, 0);
            try {
                const frames = win.document ? win.document.querySelectorAll('iframe') : [];
                for (const f of frames) {
                    try {
                        const fw = f.contentWindow;
                        if (fw) {
                            const r = findInNFBR(fw);
                            if (r.auth) { out.auth = r.auth; out.baseUrl = r.baseUrl; out.config = r.config; out.cti = r.cti; }
                            if (out.auth && out.baseUrl) break;
                        }
                    } catch (e) {}
                }
            } catch (e) {}
        } catch (e) { if (BWDD_DEBUG) console.warn('[bwdd] findInNFBR:', safeLogText(e && e.message)); }
        return out;
    }
