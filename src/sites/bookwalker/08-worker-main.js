    function workerMain() {
        let crcTable = null;
        async function crcForZip(blob) {
            if (!crcTable) {
                crcTable = new Int32Array(256);
                for (let n = 0; n < 256; n++) {
                    let c = n;
                    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
                    crcTable[n] = c;
                }
            }
            const bytes = new Uint8Array(await blob.arrayBuffer());
            let crc = -1;
            for (let i = 0; i < bytes.length; i++) {
                crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 255];
            }
            return (crc ^ -1) >>> 0;
        }
        async function processPage(data) {
            const { id, relPath, seeds, auth, baseUrl, q, fmt, timeoutMs, needCrc, blob: inputBlob } = data;
            const outType = fmt || 'image/jpeg';
            try {
                let blob = inputBlob;
                if (!blob) {
                    const qs = new URLSearchParams();
                    for (const k of AUTH_PARAM_KEYS) {
                        if (auth[k] !== undefined && auth[k] !== null) qs.set(k, auth[k]);
                    }
                    const url = baseUrl + relPath + '?' + qs.toString();
                    let res = null, lastErr = null;
                    for (let attempt = 0; attempt < 3; attempt++) {
                        const ctrl = new AbortController();
                        const timer = setTimeout(() => ctrl.abort(), timeoutMs || 60000);
                        try {
                            res = await fetch(url, { credentials: 'omit', signal: ctrl.signal });
                            if (res && res.ok) {
                                try { blob = await res.blob(); }
                                catch (e) { lastErr = e; res = null; }
                            }
                        } catch (e) {
                            lastErr = e;
                            res = null;
                        } finally {
                            clearTimeout(timer);
                        }
                        if (res && (res.ok || res.status === 403)) break;
                        await new Promise(r => setTimeout(r, 1200 * (attempt + 1)));
                    }
                    if (res && res.status === 403) return { id, error: 'auth-expired' };
                    if (!res) throw lastErr || new Error('fetch failed after retries');
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                }
                const bmp = await createImageBitmap(blob);
                const W = bmp.width, H = bmp.height;
                const S = seeds.Size;
                const needsScale = !!(S && S.Width && S.Height && (W !== S.Width || H !== S.Height));
                const needsTiles = !seeds.noDescramble;
                if (!needsTiles && !needsScale && outType === 'image/jpeg' && blob.type === 'image/jpeg') {
                    // Nothing has to change about this page. Decoding and
                    // re-encoding it costs ~57ms on a 1600x2400 scan (measured)
                    // to produce a slightly worse copy of the bytes we already
                    // hold, so hand the original straight back.
                    if (bmp.close) bmp.close();
                    const unchanged = { id, blob };
                    if (needCrc) unchanged.crc = await crcForZip(blob);
                    return unchanged;
                }
                const canvas = new OffscreenCanvas(W, H);
                const ctx = canvas.getContext('2d');
                if (needsTiles) {
                    // Blit each tile straight from the decoded bitmap into its
                    // destination rect. The previous version pulled the whole
                    // frame back with getImageData, copied the tiles in JS and
                    // pushed it back with putImageData, about 46MB of avoidable
                    // memory traffic per page, which is what stopped the decoder
                    // keeping up with the fetcher. Measured 2.08x on 14 cores.
                    for (const t of A9p(seeds, W, H)) {
                        ctx.drawImage(bmp, t.destX, t.destY, t.width, t.height,
                            t.srcX, t.srcY, t.width, t.height);
                    }
                } else {
                    ctx.drawImage(bmp, 0, 0);
                }
                if (bmp.close) bmp.close();
                let outCanvas = canvas;
                if (needsScale) {
                    outCanvas = new OffscreenCanvas(S.Width, S.Height);
                    outCanvas.getContext('2d').drawImage(canvas, 0, 0);
                }
                let outBlob;
                if (typeof outCanvas.convertToBlob === 'function') {
                    outBlob = await outCanvas.convertToBlob({ type: outType, quality: q });
                } else {
                    outBlob = await new Promise((res2, rej) => outCanvas.toBlob(b => b ? res2(b) : rej(new Error('toBlob')), outType, q));
                }
                const result = { id, blob: outBlob };
                if (needCrc) result.crc = await crcForZip(outBlob);
                return result;
            } catch (e) {
                const msg = safeLogText((e && e.message) || e);
                return { id, error: /abor/i.test(msg) ? 'timeout' : msg };
            }
        }

        self.onmessage = async (ev) => {
            const isBatch = Array.isArray(ev.data.jobs);
            const jobs = isBatch ? ev.data.jobs : [ev.data];
            // processPage allocates an independent bitmap/canvas per item, so
            // Promise.all overlaps codec work without sharing mutable surfaces.
            // Acknowledge each result as soon as it finishes: if a sibling hangs,
            // the pool can commit this page and time out only the unfinished one.
            if (!isBatch) {
                self.postMessage(await processPage(ev.data));
                return;
            }
            await Promise.all(jobs.map(async job => {
                const result = await processPage(job);
                self.postMessage({ batchId: ev.data.batchId, result });
            }));
        };
    }

