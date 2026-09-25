**One script for all three stores: BookWalker, CMOA and ebookjapan.** It reads the viewer's own signed CDN URLs, fetches every page file directly, rebuilds each page offline at full resolution, and hands you the volume as a ZIP or CBZ without turning a single page.

- **Original-resolution pages**, laid out as `Series/Volume/page-0001.jpg`. Full editions, free and trial samples, and subscription viewers.
- **"Also available on" pills** under the book details tell you whether the other shops carry the series, what the volume costs and how many volumes are free, linking to the product page rather than a viewer. A shop that does not carry the book gets no pill at all.
- **Reading stats before you commit**: Natively level with JLPT band colours, ratings and reader counts, plus Manga Kotoba vocabulary totals.
- **Optional Mokuro OCR** through [mokuro-bridge](https://github.com/GolyBidoof/mokuro-bridge). Pages stream across as they are descrambled and come back as the `.cbz` / `.mokuro` / `.webp` trio that [reader.mokuro.app](https://reader.mokuro.app/) reads, kept locally or uploaded to MEGA, Google Drive, OneDrive or WebDAV.
- **Resume, not restart**: pages are cached as they arrive, an interrupted run continues where it stopped, and a partial failure names the pages that are missing.

Only need one store? [BookWalker](https://greasyfork.org/en/scripts/594508-bookwalker-native-downloader), [CMOA](https://greasyfork.org/en/scripts/597317-cmoa-native-downloader) and [ebookjapan](https://greasyfork.org/en/scripts/597318-ebookjapan-native-downloader) are separate, smaller builds that contain no other store's code.

Needs a userscript manager (Tampermonkey or Violentmonkey). The stats cards and store pills read each shop's public page, so Tampermonkey asks for cross-origin access to them; decline it and downloading and OCR work exactly the same.

For personal, lawful use: download only what you are entitled to access. MIT licensed. Source, issues and releases on [GitHub](https://github.com/GolyBidoof/bookwalker-ebookjapan-cmoa-native-downloader).
