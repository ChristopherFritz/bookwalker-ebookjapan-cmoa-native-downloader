**Saves the book open in the [BookWalker](https://bookwalker.jp) viewer** as a ZIP or CBZ of original-resolution page images, without turning a page. It reads the viewer's own signed CloudFront URLs, fetches every page file directly, reverses BookWalker's `32x32` tile scramble in a worker pool, and crops each page to its declared size so no padding edge survives.

- **Original-resolution pages**, laid out as `Series/Volume/page-0001.jpg`. Full editions, free and trial samples, and subscription viewers.
- **Reading stats before you commit**: Natively level with JLPT band colours, ratings and reader counts, plus Manga Kotoba vocabulary totals.
- **Optional Mokuro OCR** through [mokuro-bridge](https://github.com/GolyBidoof/mokuro-bridge). Pages stream across as they are descrambled and come back as the `.cbz` / `.mokuro` / `.webp` trio that [reader.mokuro.app](https://reader.mokuro.app/) reads, kept locally or uploaded to MEGA, Google Drive, OneDrive or WebDAV.
- **Resume, not restart**: pages are cached as they arrive, an interrupted run continues where it stopped, and a partial failure names the pages that are missing.
- Want CMOA and ebookjapan as well? A pill in the panel links the [all-in-one build](https://greasyfork.org/en/scripts/597313-omnimanga-native-downloader).

**Turn off other BookWalker userscripts first.** This one works by reading the viewer's own network traffic, and other downloaders and page-capture scripts interfere with it.

Needs a userscript manager (Tampermonkey or Violentmonkey). For personal, lawful use: download only what you are entitled to access. MIT licensed. Source, issues and releases on [GitHub](https://github.com/GolyBidoof/bookwalker-ebookjapan-cmoa-native-downloader).
