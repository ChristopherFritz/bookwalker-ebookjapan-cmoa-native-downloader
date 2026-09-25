**Saves the book open in the [ebookjapan](https://ebookjapan.yahoo.co.jp) reader** as a ZIP or CBZ of original-resolution page images, without turning a page. It opens a session through the viewer's own API and descrambles each page with the same WebAssembly module the reader uses, so there are no screenshots and no page flipping.

- **Original-resolution pages**, laid out as `Series/Volume/page-0001.jpg`. Purchased volumes and free volumes included.
- **Reading stats before you commit**: Natively level with JLPT band colours, ratings and reader counts, plus Manga Kotoba vocabulary totals.
- **Optional Mokuro OCR** through [mokuro-bridge](https://github.com/GolyBidoof/mokuro-bridge). Pages stream across as they are descrambled and come back as the `.cbz` / `.mokuro` / `.webp` trio that [reader.mokuro.app](https://reader.mokuro.app/) reads, kept locally or uploaded to MEGA, Google Drive, OneDrive or WebDAV.
- **Resume, not restart**: pages are cached as they arrive, an interrupted run continues where it stopped, and a partial failure names the pages that are missing.
- Want BookWalker and CMOA as well? A pill in the panel links the [all-in-one build](https://greasyfork.org/en/scripts/597313-omnimanga-native-downloader).

Needs a userscript manager (Tampermonkey or Violentmonkey). For personal, lawful use: download only what you are entitled to access. MIT licensed. Source, issues and releases on [GitHub](https://github.com/GolyBidoof/bookwalker-ebookjapan-cmoa-native-downloader).
