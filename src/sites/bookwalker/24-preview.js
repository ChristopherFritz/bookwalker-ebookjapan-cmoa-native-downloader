    function buildBookPreview() {
        try {
            const rawTitle = state.cti || document.title || '';
            const title = cleanTitle(rawTitle) || state.cid || 'Unknown Book';
            if (!state.decodedConfig && !state.configBody) return null;
            const config = state.decodedConfig || decodeConfig(state.configBody);
            const contents = config && config['configuration'] && config['configuration']['contents'];
            if (!contents || !contents.length) return null;
            const isPlain = state.plaintextConfig || !state.keys;
            let pages = 0, W = '?', H = '?';
            for (const it of contents) {
                const cfg = config[it.file];
                if (!cfg || !cfg.FileLinkInfo) { pages++; continue; }
                const fli = cfg.FileLinkInfo;
                const pl = fli.PageLinkInfoList || [];
                const n = fli.PageCount || Math.max(1, pl.length);
                pages += n;
                if (W === '?' && pl.length) {
                    const p = pl[0].Page;
                    if (p && p.Size) { W = p.Size.Width; H = p.Size.Height; }
                }
            }
            return {
                title,
                pages,
                resolution: `${W} × ${H}`,
                type: isPlain ? 'Sample / Trial' : 'Full Edition'
            };
        } catch (e) { return null; }
    }

