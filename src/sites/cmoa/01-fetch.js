    // =====================================================================
    // CMOA site adapter — fetch & descramble
    // =====================================================================
    // One CMOA page is a scrambled JPEG tile served by sbcGetImg.php; the URL
    // carries the volume id, page path, quality and a short-lived `p` token,
    // and the CDN answers 403 for any of them wrong. The retry ladder below
    // walks quality × token, so one bad token cannot fail a whole volume.
    function cmoaBuildImageUrl(descriptor, qualityOverride, tokenOverride) {
        if (!cmoaState.contentsServer) throw new Error('CMOA contents server is not available');
        if (!cmoaState.cid) throw new Error('CMOA content ID is not available');
        if (!descriptor || !descriptor.src) throw new Error('CMOA page source URL unavailable');
        let base = cmoaState.contentsServer;
        if (!base.endsWith('/')) base += '/';
        const url = new URL('sbcGetImg.php', base);
        url.searchParams.set('cid', cmoaState.cid);
        url.searchParams.set('src', descriptor.src);
        const quality = qualityOverride != null ? qualityOverride : (cmoaState.quality || CMOA_QUALITY_ORDER[0]);
        if (quality != null) url.searchParams.set('q', String(quality));
        const token = tokenOverride != null ? tokenOverride : cmoaState.token;
        if (token) url.searchParams.set('p', token);
        if (cmoaState.viewMode != null) url.searchParams.set('vm', cmoaState.viewMode);
        if (cmoaState.dmytime) url.searchParams.set('dmytime', cmoaState.dmytime);
        if (cmoaState.u0 != null) url.searchParams.set('u0', cmoaState.u0);
        if (cmoaState.u1 != null) url.searchParams.set('u1', cmoaState.u1);
        Object.keys(cmoaState.extraParams).forEach(key => {
            const value = cmoaState.extraParams[key];
            if (value == null || value === '') return;
            const lower = key.toLowerCase();
            if (['cid', 'src', 'p', 'vm', 'q', 'dmytime', 'u0', 'u1'].includes(lower)) return;
            url.searchParams.set(key, value);
        });
        return url.toString();
    }

    function cmoaContentType(headerString) {
        if (!headerString || typeof headerString !== 'string') return null;
        for (const line of headerString.split(/\r?\n/)) {
            const i = line.indexOf(':');
            if (i === -1) continue;
            if (line.slice(0, i).trim().toLowerCase() === 'content-type') {
                return line.slice(i + 1).trim() || null;
            }
        }
        return null;
    }

    // The image CDN is cross-origin, so a plain page fetch is CORS-blocked.
    // Real parallelism comes from the shared transport lanes: the gm lane plus
    // every local fetch-proxy port the bridge advertises, each its own
    // HTTP/1.1 origin, so the 6-connections-per-origin limit stops being the
    // ceiling. Hence laneFetch() rather than GM_xmlhttpRequest (one lane).
    async function cmoaFetchViaLanes(url) {
        await waitOutCooldown();
        const t0 = performance.now();
        // Opt in only when the bridge is willing to fetch this CDN: the fetch
        // proxy is not transparent - it forwards to the host named in
        // x-bwdd-upstream and refuses the rest - so a port configured for
        // another store would answer a CMOA path from the wrong CDN. A generic
        // bridge allows every port; one hardcoded to BookWalker allows none.
        const allowProxy = proxyCanServe(hostOf(url));
        const res = await laneFetch(url, 45000, { allowProxy: allowProxy });
        if (!res || !res.ok) {
            const e = new Error('HTTP ' + (res ? res.status : '0'));
            e.status = res ? res.status : 0;
            throw e;
        }
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        recordLane(res._lane, performance.now() - t0, bytes.byteLength);
        const type = (res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || 'image/jpeg';
        return { bytes, type };
    }

    // Fallback for environments with no gm lane (no GM_xmlhttpRequest exposed,
    // or no grant); a plain same-context fetch is the last resort.
    async function cmoaFetchBinary(url) {
        const referer = location.href;
        const viaGM = () => new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') { reject(new Error('GM_xmlhttpRequest unavailable')); return; }
            let settled = false;
            const finish = fn => { if (!settled) { settled = true; fn(); } };
            try {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    timeout: 45000,
                    responseType: 'arraybuffer',
                    headers: { 'Referer': referer, 'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
                    onload: r => finish(() => {
                        if (r.status >= 200 && r.status < 300) {
                            const bytes = new Uint8Array(r.response || []);
                            resolve({ bytes, type: cmoaContentType(r.responseHeaders) || 'image/jpeg' });
                        } else {
                            const e = new Error('HTTP ' + r.status);
                            e.status = r.status;
                            reject(e);
                        }
                    }),
                    onerror: () => finish(() => reject(new Error('GM_xhr failed'))),
                    ontimeout: () => finish(() => reject(new Error('GM_xhr timeout'))),
                    onabort: () => finish(() => reject(new Error('GM_xhr aborted'))),
                });
            } catch (e) { finish(() => reject(e)); }
        });
        try {
            return await cmoaFetchViaLanes(url);
        } catch (laneError) {
            // A real HTTP answer (403/404/...) is meaningful and repeating the
            // identical request on another lane just wastes a round trip; only a
            // transport failure (status 0 / no response) is worth another lane.
            if (laneError && laneError.status) throw laneError;
            cmoaLog('lane transport failed, falling back', safeLogText(laneError && laneError.message));
        }
        try {
            return await viaGM();
        } catch (gmError) {
            if (typeof GM_xmlhttpRequest === 'function' && !/unavailable/.test(gmError && gmError.message || '')) throw gmError;
            // The CDN URL is self-signed (cid + src + p), so it needs no
            // cookies; sending them would also make this request fail CORS
            // preflight, since a credentialed request cannot use a wildcard
            // Access-Control-Allow-Origin.
            const res = await fetchWithTimeout(url, { credentials: 'omit', referer: referer }, 45000);
            if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
            const buf = await res.arrayBuffer();
            return { bytes: new Uint8Array(buf), type: res.headers.get('content-type') || 'image/jpeg' };
        }
    }

    async function cmoaDecodeImage(bytes, mimeType) {
        const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
        const blobType = (typeof mimeType === 'string' && mimeType !== 'application/octet-stream') ? mimeType : undefined;
        const blob = new Blob([buffer], { type: blobType });
        if (typeof createImageBitmap === 'function') {
            try {
                const bmp = await createImageBitmap(blob);
                return {
                    element: bmp, width: bmp.width, height: bmp.height,
                    cleanup: () => { try { if (bmp.close) bmp.close(); } catch (e) {} },
                };
            } catch (e) { /* fall through to an <img> decode */ }
        }
        return new Promise((resolve, reject) => {
            const objectUrl = URL.createObjectURL(blob);
            const img = new Image();
            img.decoding = 'async';
            img.onload = () => resolve({
                element: img,
                width: img.naturalWidth || img.width,
                height: img.naturalHeight || img.height,
                cleanup: () => { try { URL.revokeObjectURL(objectUrl); img.src = ''; } catch (e) {} },
            });
            img.onerror = e => { try { URL.revokeObjectURL(objectUrl); } catch (_) {} reject(e || new Error('image decode failed')); };
            img.src = objectUrl;
        });
    }

    // Re-encode through a canvas. This is where the correct output codec is
    // applied (and, for a lossless selection, where PNG/WebP is chosen).
    async function cmoaCanvasToBlob(canvas, mime, quality) {
        const q = typeof quality === 'number' ? quality : undefined;
        if (typeof canvas.toBlob === 'function') {
            const direct = await new Promise(resolve => canvas.toBlob(resolve, mime, q));
            if (direct) return direct;
            if (mime && mime !== 'image/png') {
                const fallback = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
                if (fallback) return fallback;
            }
        }
        const dataUrl = canvas.toDataURL(mime || 'image/png');
        const comma = dataUrl.indexOf(',');
        const binary = atob(comma !== -1 ? dataUrl.slice(comma + 1) : dataUrl);
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
        return new Blob([out], { type: mime || 'image/png' });
    }

    function cmoaExtFor(type) {
        const t = typeof type === 'string' ? type.split(';')[0].trim().toLowerCase() : '';
        if (t === 'image/png') return 'png';
        if (t === 'image/webp') return 'webp';
        if (t === 'image/jpeg' || t === 'image/jpg') return 'jpg';
        return null;
    }

    // Reassemble one scrambled page and re-encode it to the selected codec.
    // ext is set only when the original payload was kept as-is.
    async function cmoaProcessPage(descriptor, payload) {
        const reader = cmoaState.reader || cmoaGetReader();
        if (!reader || typeof reader.getImageDescrambleCoords !== 'function' || !descriptor || !descriptor.image) {
            cmoaLog('descramble skipped: reader unavailable', descriptor && descriptor.index);
            return { blob: new Blob([payload.bytes], { type: payload.type }), ext: cmoaExtFor(payload.type) };
        }
        let decoded = null;
        try {
            decoded = await cmoaDecodeImage(payload.bytes, payload.type);
        } catch (e) {
            cmoaLog('decode failed', safeLogText(e && e.message));
            return { blob: new Blob([payload.bytes], { type: payload.type }), ext: cmoaExtFor(payload.type) };
        }
        if (!decoded || !decoded.element || !decoded.width || !decoded.height) {
            if (decoded && decoded.cleanup) decoded.cleanup();
            return { blob: new Blob([payload.bytes], { type: payload.type }), ext: cmoaExtFor(payload.type) };
        }
        let plan = null;
        try {
            plan = reader.getImageDescrambleCoords(descriptor.image, decoded.width, decoded.height);
        } catch (e) {
            cmoaLog('getImageDescrambleCoords failed', safeLogText(e && e.message));
        }
        try {
            const canvas = document.createElement('canvas');
            canvas.width = (plan && plan.width > 0) ? plan.width : decoded.width;
            canvas.height = (plan && plan.height > 0) ? plan.height : decoded.height;
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('no 2D context');
            // With no plan the page is already whole; the straight copy still
            // re-encodes, so the archive extension always matches the bytes.
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            if (plan && Array.isArray(plan.transfers) && plan.transfers.length) {
                plan.transfers.forEach(transfer => {
                    if (!transfer || (typeof transfer.index === 'number' && transfer.index !== 0)) return;
                    const coords = Array.isArray(transfer.coords) ? transfer.coords : [];
                    coords.forEach(piece => {
                        if (!piece) return;
                        const pw = piece.width || 0;
                        const ph = piece.height || 0;
                        if (pw <= 0 || ph <= 0) return;
                        try {
                            ctx.drawImage(decoded.element,
                                piece.xsrc || 0, piece.ysrc || 0, pw, ph,
                                piece.xdest || 0, piece.ydest || 0, pw, ph);
                        } catch (drawError) { /* keep the remaining pieces */ }
                    });
                });
            } else {
                ctx.drawImage(decoded.element, 0, 0);
            }
            const blob = await cmoaCanvasToBlob(canvas, IMAGE_CODEC.type, IMAGE_CODEC.quality);
            if (!blob) throw new Error('canvas encode produced nothing');
            return { blob, ext: cmoaExtFor(blob.type) };
        } catch (e) {
            cmoaLog('descramble pipeline failed', safeLogText(e && e.message));
            return { blob: new Blob([payload.bytes], { type: payload.type }), ext: cmoaExtFor(payload.type) };
        } finally {
            if (decoded && decoded.cleanup) decoded.cleanup();
        }
    }

    // Walk quality × token until a page comes back. A 403 means that
    // combination is refused: blacklist the quality and evict the token, then
    // try the next, so a stale credential degrades instead of failing the volume.
    async function cmoaFetchPage(descriptor, index) {
        const preferred = cmoaState.quality || CMOA_QUALITY_ORDER[0];
        const qualities = [];
        const pushQuality = q => {
            if (q == null) return;
            const s = String(q);
            if (qualities.includes(s)) return;
            if (cmoaState.qualityBlacklist.has(s)) return;
            qualities.push(s);
        };
        pushQuality(preferred);
        CMOA_QUALITY_ORDER.forEach(pushQuality);
        if (!qualities.length) qualities.push('1');

        const tokens = [];
        const pushToken = t => {
            if (!t) return;
            const s = String(t);
            if (!tokens.includes(s)) tokens.push(s);
        };
        pushToken(cmoaState.lastGoodToken);
        pushToken(cmoaState.token);
        cmoaState.tokenPool.forEach(pushToken);
        if (!tokens.length) tokens.push(null);

        let lastError = null;
        for (const token of tokens) {
            let forbidden = false;
            for (const quality of qualities) {
                if (cmoaState.qualityBlacklist.has(String(quality))) continue;
                try {
                    const url = cmoaBuildImageUrl(descriptor, quality, token);
                    cmoaLog('fetching page', index, 'quality', quality, 'token', token);
                    const tFetch = performance.now();
                    const payload = await cmoaFetchBinary(url);
                    const fetchMs = performance.now() - tFetch;
                    if (quality !== cmoaState.quality) cmoaState.quality = quality;
                    if (token) cmoaRememberToken(token, { markGood: true, force: true });
                    cmoaState.qualityBlacklist.delete(String(quality));
                    const tProc = performance.now();
                    const processed = await cmoaProcessPage(descriptor, payload);
                    if (BWDD_DEBUG) {
                        cmoaLog('page timing', index, {
                            fetchMs: Math.round(fetchMs),
                            processMs: Math.round(performance.now() - tProc),
                            bytes: payload.bytes ? payload.bytes.length : 0,
                            quality: quality,
                        });
                    }
                    return processed;
                } catch (e) {
                    lastError = e || new Error('fetch failed');
                    const text = safeLogText((e && e.message) || e);
                    cmoaLog('page fetch failed', index, 'quality', quality, text);
                    if (/(^|\D)403(\D|$)/.test(text)) {
                        forbidden = true;
                        cmoaState.qualityBlacklist.add(String(quality));
                    }
                }
            }
            if (token && forbidden) cmoaEvictToken(token);
        }
        throw lastError || new Error('Failed to download page ' + (index + 1));
    }
