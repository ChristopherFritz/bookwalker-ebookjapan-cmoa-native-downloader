    function cdnBaseCandidates(fileKey, relPath) {
        const out = [];
        const add = (u) => { if (u && out.indexOf(u) === -1) out.push(u); };
        if (fileKey && state.fileBases && state.fileBases[fileKey]) add(state.fileBases[fileKey]);
        if (state.baseUrl) {
            const m = state.baseUrl.match(/^(.*?\/SVGA\/)(?:[^/]+\/)?$/);
            if (m) {
                // Pick the variant this rel actually lives in FIRST. Captures:
                // cover/front-matter/shared pages sit under SVGA/shared while
                // the body pages sit under SVGA/normal_default, a mismatched
                // first guess 403s and (in the old code) stalled the whole run
                // on breaker cooldowns. Guessing right means the first probe
                // usually 200s.
                const isShared = /(^|\/)shared\//.test(relPath || '');
                const variants = isShared ? ['shared', 'normal_default'] : ['normal_default', 'shared'];
                for (const v of variants) add(m[1] + v + '/');
            }
            add(state.baseUrl);
        }
        return out;
    }
    async function cdnFetchWithFallback(relPath, fileKey, timeoutMs) {
        const bases = cdnBaseCandidates(fileKey, relPath);
        let lastErr = null;
        for (let bi = 0; bi < bases.length; bi++) {
            try {
                const res = await cdnFetch((attempt) => {
                    const base = bases[bi] + relPath + '?' + authQuery(state.auth);
                    // Only retries carry a cache-buster, so the first attempt
                    // stays byte-identical to what the viewer itself requests.
                    return attempt > 0 ? base + '&_bwr=' + attempt + '-' + Date.now().toString(36) : base;
                }, timeoutMs || 45000);
                // Remember which base dir actually served this page family so
                // later pages skip the probe chain entirely (state.fileBases is
                // reset per run in resetRunState).
                if (fileKey && state.fileBases && !state.fileBases[fileKey]) state.fileBases[fileKey] = bases[bi];
                return res;
            } catch (e) {
                lastErr = e;
                // 403 with a still-valid policy = this base-dir guess does not
                // host the file (wrong SVGA variant). That is NOT a rate limit:
                // move to the next candidate immediately, no breaker, no auth
                // churn. (Genuinely expired policies are retried inside
                // cdnFetch, and prefetchOne rotates auth when every candidate
                // path-denies.)
                if (e && e.pathDenied) continue;
                if (breakerOpen()) {
                    await waitOutCooldown();
                    try { await refreshAuthBest(); } catch (e2) {}
                }
            }
        }
        throw lastErr || new Error('All variant endpoints failed for ' + relPath);
    }

    async function cdnFetch(urlBuilder, timeoutMs) {
        await waitOutCooldown();
        // Policy-clock renewal: every /browserWebApi/pb response mints a
        // CloudFront policy whose DateLessThan is ~60 s out (verified on all
        // live captures), and no capture shows a per-policy *request* quota on
        // valid paths. Refresh when the current policy is about to lapse OR the
        // legacy request-count budget trips; count alone was refreshing far too
        // eagerly during 128-wide bursts.
        if ((!authLooksFresh() || reqsSinceAuth >= REQS_PER_POLICY_RENEW) && authRefreshPromise === null) {
            try {
                const before = authPolicySig();
                await refreshAuthBest();
                if (authPolicySig() !== before) reqsSinceAuth = 0;
            } catch (e) {}
        }
        let lastStatus = 0;
        let lastErr = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            let res = null, err = null;
            try {
                res = await laneFetch(urlBuilder(attempt), timeoutMs || 45000);
            } catch (e) { err = e; }
            const status = res ? res.status : 0;
            reqsSinceAuth++;
            if (res && res.ok) {
                consecutiveBlocks = 0;
                return res;
            }
            lastStatus = status; lastErr = err;
            if (status === 403) {
                // A 403 while the policy still has runway is a PATH denial: this
                // base-dir guess does not host the file (captures show the same
                // token 200s under .../SVGA/shared while bare .../SVGA 403s
                // forever). Refreshing auth cannot fix a wrong path and must not
                // trip the global breaker, so signal pathDenied. Only a lapsed
                // policy is rotated and retried first.
                if (!authLooksFresh() && attempt < 2) {
                    const before = authPolicySig();
                    try { await refreshAuthBest(); } catch (e2) {}
                    if (authPolicySig() !== before) { reqsSinceAuth = 0; continue; }
                }
                // A fresh policy that still 403s is usually BookWalker's cached S3
                // error page for one object, per-URL and transient (in a
                // 308-request capture every 403 cleared on a plain retry), not a
                // path denial. One jittered retry before concluding the path
                // is wrong, so one bad edge entry cannot cost a whole page. The
                // retry carries a cache-buster: the signed policy's Resource is
                // a path wildcard, so the query string is not part of the
                // signature and the extra param cannot invalidate it.
                if (attempt === 0) {
                    await sleepMs(120 + Math.random() * 240);
                    continue;
                }
                const e2 = new Error('CDN denied path (Status: 403)');
                e2.status = 403;
                e2.pathDenied = true;
                throw e2;
            }
            const blocked = corsLikeError(err, status);
            if (blocked) {
                if (attempt < 2) { await sleepMs(1200 * (attempt + 1)); continue; }
                tripBreaker();
                const e2 = new Error('CDN rate limiter reached (Status: ' + status + ')');
                e2.status = status;
                throw e2;
            }
            if (res) { const e2 = new Error('HTTP ' + status); e2.status = status; throw e2; }
            throw (err || new Error('CDN request failed'));
        }
        const e4 = new Error('Retries exhausted for CDN slice (Last status: ' + lastStatus + ')');
        e4.status = lastStatus;
        throw e4;
    }
