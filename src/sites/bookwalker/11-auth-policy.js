    function authPolicySig() {
        try { return (state.auth && state.auth['Policy'] || '') + '|' + (state.auth && state.auth['Signature'] || ''); }
        catch (e) { return ''; }
    }

    async function fetchAndDescramble(relPath, seeds, q, timeoutMs, fmt) {
        const res = await cdnFetch(() => state.baseUrl + relPath + '?' + authQuery(state.auth), timeoutMs || 60000);
        if (!res.ok) throw new Error('HTTP error ' + res.status);
        const blob = await res.blob();
        return await decodeBlobMain(blob, seeds, q, fmt);
    }

