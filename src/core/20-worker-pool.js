    const WORKER_BATCH_SIZE = 2;

    function workerBatchSize(type) {
        // JPEG is the default and benefits from two overlapping codec jobs.
        // Lossless WebP/PNG encoders have much higher peak memory/CPU cost, so
        // keep a conservative single-page queue for those formats.
        return type === 'image/jpeg' ? WORKER_BATCH_SIZE : 1;
    }

