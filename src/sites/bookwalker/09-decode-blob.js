    async function decodeBlobMain(blob, seeds, q, fmt) {
        // Same approach as workerMain: blit tiles straight from the decoded
        // bitmap instead of round-tripping the frame through getImageData.
        const codec = fmt ? { type: fmt, ext: IMAGE_CODEC.ext } : IMAGE_CODEC;
        const bmp = await createImageBitmap(blob);
        const W = bmp.width, H = bmp.height;
        const S = seeds.Size;
        const needsScale = !!(S && S.Width && S.Height && (W !== S.Width || H !== S.Height));
        const needsTiles = !seeds.noDescramble;
        if (!needsTiles && !needsScale && codec.type === 'image/jpeg' && blob.type === 'image/jpeg') {
            if (bmp.close) bmp.close();
            return blob;
        }
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');
        if (needsTiles) {
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
            outCanvas = document.createElement('canvas');
            outCanvas.width = S.Width;
            outCanvas.height = S.Height;
            outCanvas.getContext('2d').drawImage(canvas, 0, 0);
        }
        return await new Promise((res2, rej) =>
            outCanvas.toBlob(b => b ? res2(b) : rej(new Error('toBlob')), codec.type, q));
    }

