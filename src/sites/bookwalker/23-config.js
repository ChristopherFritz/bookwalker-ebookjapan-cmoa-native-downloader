    function decodeConfig(content) {
        const c = String(content || '');
        if (c.indexOf('"data":"') === -1) {
            try {
                const j = JSON.parse(c);
                if (j && j.configuration && j.configuration.contents) {
                    state.keys = null;
                    state.plaintextConfig = true;
                    return j;
                }
            } catch (e) {}
        }
        const DATA_STR = '"data":"';
        const dataOffset = c.indexOf(DATA_STR) + DATA_STR.length;
        const dataEndOffset = c.indexOf('"', dataOffset);
        if (dataOffset < DATA_STR.length || dataEndOffset < dataOffset) {
            throw new Error('Invalid configuration pack');
        }
        const fk = processFilename('configuration_pack.json');
        let st = A8j(c, dataOffset, dataEndOffset);
        st = A3b(0, st); st = B0p(fk, st); st = A7L(fk, st); st = A6I(fk, st); st = A2F(st);
        st = B0L(fk, st); st = A3b(1, st); st = A3b(2, st); st = A3b(3, st); st = tB0l(fk, st);
        const [jsonStr] = A6e(st);
        state.keys = [st[2], st[3], st[4]];
        return JSON.parse(jsonStr);
    }

