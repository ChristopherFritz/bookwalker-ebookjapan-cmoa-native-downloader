
    // =====================================================================
    // 1. Capture the viewer's own network responses (browser data reuse)
    // =====================================================================
    const state = {
        cid: (new URLSearchParams(location.search)).get('cid') || '',
        fileBases: {},
        auth: null,        // {hti, cfg, bid, uuid, pfCd, Policy, Signature, Key-Pair-Id}
        baseUrl: null,     // e.g. https://bw-bv-epubs.bookwalker.jp/3_product/<cid>/1/<pid>/
        cti: null,         // title
        configBody: null,  // encrypted configuration_pack.json text
        configFromUrl: null,
        resumePageNames: Object.create(null)
    };
    const RESUME_KEY_PREFIX = '/NFBR.a6iMark/NFBR.ResumeData/';

    function resumeStem(url) {
        const path = String(url || '').split(/[?#]/, 1)[0];
        const base = path.slice(path.lastIndexOf('/') + 1);
        const stem = base.replace(/\.(?:x?html?)$/i, '');
        return fsSafePath(stem);
    }

    function rememberResumeData(key, value) {
        const match = String(key || '').match(/^\/NFBR\.a6iMark\/NFBR\.ResumeData\/([^/]+)\/1$/);
        if (!match) return;
        try {
            const data = JSON.parse(String(value || ''));
            const page = Number(data && data.page);
            const name = resumeStem(data && data.url);
            if (!Number.isInteger(page) || page < 0 || !name) return;
            const cid = match[1];
            if (!state.resumePageNames[cid]) state.resumePageNames[cid] = Object.create(null);
            state.resumePageNames[cid][page] = name;
        } catch (e) {}
    }

    function readCurrentResumeData() {
        try {
            const key = RESUME_KEY_PREFIX + state.cid + '/1';
            rememberResumeData(key, localStorage.getItem(key));
        } catch (e) {}
    }

    function installResumeDataCapture() {
        try {
            const proto = window.Storage && window.Storage.prototype;
            if (proto && !proto.__bwddResumeDataCapture) {
                const original = proto.setItem;
                const wrapped = function (key, value) {
                    const result = original.apply(this, arguments);
                    try { rememberResumeData(key, value); } catch (e) {}
                    return result;
                };
                wrapped.__bwddResumeDataCapture = true;
                proto.setItem = wrapped;
                proto.__bwddResumeDataCapture = true;
            }
        } catch (e) {}
        readCurrentResumeData();
    }

    function bookWalkerPageName(index, source) {
        const observed = state.resumePageNames[state.cid] && state.resumePageNames[state.cid][index - 1];
        const name = observed || resumeStem(source);
        // The page number keeps names unique when one source file contains
        // multiple images. Padding also keeps filename-based readers in order.
        const detail = name ? ' ' + Array.from(name).slice(0, 170).join('') : '';
        return String(index).padStart(4, '0') + detail + '.' + IMAGE_CODEC.ext;
    }

    if (!isHeadlessPage()) installResumeDataCapture();

    // Headless auth refreshes must correlate like one browser session. Do not
    // mint a new BID on every retry/endpoint call, but never consult browser
    // storage in this mode.
    let headlessBid = null;

    // Shared protocol/presentation constants (single source of truth).
    const AUTH_PARAM_KEYS = ['hti', 'cfg', 'bid', 'uuid', 'pfCd', 'Policy', 'Signature', 'Key-Pair-Id'];
