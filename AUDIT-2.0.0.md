# 2.0.0 audit, architecture, quality, performance, reusability

Snapshot 2026-09-25: everything below is the working tree on top of `3b18079`
(Release v1.5.1), 35 uncommitted paths, i.e. the whole fragment architecture,
the tests, the CI and the ebookjapan module. Another author is
concurrently editing `src/sites/ebookjapan/`, so the ebookjapan figures here are a
moving target.

## 1. What is actually here

Measured from `src/manifest.json` and the built artifacts, not estimated.

| module | files | lines | bytes | share | comments |
| --- | --- | --- | --- | --- | --- |
| `sites/ebookjapan` | 5 | 1539 | 288474 | 37% | 5% |
| `core` | 18 | 5782 | 273970 | 35% | 20% |
| `sites/bookwalker` | 18 | 2555 | 127281 | 16% | 12% |
| `sites/cmoa` | 3 | 1089 | 54979 | 7% | 22% |
| `feature/availability` | 1 | 438 | 22672 | 3% | 20% |
| `feature/unified-link` | 1 | 55 | 2788 | 0% | 37% |
| `entry` | 1 | 47 | 2477 | 0% | 31% |
| `_meta` | 3 | 52 | 2164 | 0% | 94% |
| **total** | **50** | **11557** | **774805** | | **14%** |

| artifact | bytes | comments | embedded wasm/glue |
| --- | --- | --- | --- |
| combined | 773565 | 106727 (14%) | 213144 (28%) |
| bookwalker-only | 409764 | 75479 (18%) | n/a |
| cmoa-only | 337298 | 71520 (21%) | n/a |
| ebookjapan-only | 570880 | 74694 (13%) | 213144 (37%) |

Three facts that shape every decision below:

1. **The source is the artifact.** `src/` totals 774805 B and the combined
   artifact is 773565 B: build.mjs concatenates, it does not transform. Anything
   true of the source is true of what ships.
2. **The heavy bytes are not the code you wrote.** 213 KB of the combined script
   (28%) is the ebookjapan wasm plus its glue, base64'd into a string literal in
   `src/sites/ebookjapan/01-glue.js` (a 218780 B file).
3. **That wasm is decoded on demand, not at parse time**, `ebjLoadGlue()`
   (`01-glue.js:83`) guards on a cached core, `atob`s, checksums, compiles the
   glue with `new Function`, then instantiates the wasm. The two b64 literals are
   single string tokens, so the parser skips over them.
   **Correction to an earlier draft of this audit:** it is *not* true that
   nothing reaches it at boot. On ebookjapan the boot poll's `site.refresh()`
   (`70-site.js:113` → `05-run.js:348-354` → `00-state.js:123`) gets there about
   500 ms after `document-end`. BookWalker and CMOA never touch it before a
   download. So the heaviest store pays a wasm decode shortly after boot, on
   every page view, see P-1 below.

Boot cost, measured in Chrome against the test fixture (median of 5, panel
`#bwdd-root` present):

| artifact | panel ready |
| --- | --- |
| combined | 113 ms |
| bookwalker-only | 84 ms |

Parse cost in isolation is **not** measurable the obvious way: `new vm.Script`
(and even `produceCachedData`) reports 0.1-0.3 ms for every artifact, because V8
pre-parses function bodies lazily and the whole artifact is one IIFE body. Those
numbers measure the pre-parse, not a real compile. The honest number is the
end-to-end 84-113 ms above, and the 29 ms delta between the two is the extra
cross-store work, not the extra bytes.

## 2. Architecture as found

**The build model is the architecture.** There is no module system: `src/` is a
set of plain-JS fragments, `src/manifest.json` fixes their order in one IIFE, and
`src/targets.json` decides which fragments each of the four artifacts gets. A
function defined in fragment 12 is simply in scope in fragment 40; the dependency
graph exists only in the manifest's ordering. Optional features are entire
modules, guarded at the call site with `typeof fn === 'function'` because the
identifier genuinely does not exist in a build that omits them (`70-site.js` and
`51-panel.js` both do this for `lookupAvailability` and `unifiedDownloaderLink`).

**The per-store seam is the good part.** Every store implements one adapter and
registers it (`30-adapter.js:9`, `cmoa/02-run.js:218`, `ebookjapan/05-run.js:303`)
against a contract documented in the source at `core/70-site.js:17-25`:
`id, label, panelTitle, matches(), install(), refresh(), getBook(), getPreview(),
getCid(), run()`. The shared panel, the button wiring and the poll loop are
identical for every store (`70-site.js:67-70`), and only the adapter's answers
differ. Measured coupling backs this up: **only five files in all of `src/` name
a store id**, and of the ten host mentions in `src/core/`, nine are the
availability catalog's data table (`32-availability.js:20-102`) and one is the
documented BookWalker bridge default (`21-transport-pool.js:420-421`).

**The CLI used to share this repo and shared no code with it.** The userscript
is the browser, cross-store path. `cli/` was a Node path that was BookWalker-only:
every one of its store host mentions was `bookwalker.jp`, `free-volume.js`
alone had 51, and it never `require`d anything from `src/`. It reimplemented
BookWalker loader/cr extraction (`free-volume.js:178-207`) that the userscript
does not contain, because the userscript reads `c9P()` out of the live page and a
headless Node process cannot; that duplication was justified.

It has since been extracted to the sibling project `../bookwalker-native-cli/`
(see §7). Two things to know about the split:

- **It consumes this repo's build.** The CLI injects the userscript and talks to
  the `window.__bwddAutomation` API, so its default script path is
  `../bookwalker-native-downloader/bookwalker-native-downloader.user.js`
  (`cli/constants.js`), overridable with `BWDD_US` or `--script`. Deleting or
  renaming the combined artifact breaks the CLI.
- **`window.__bwddAutomation` stays here.** It is CLI-facing code inside `src/`
  (`core/11-automation.js:186`, with `core/10-util.js` and `core/13-pagecache.js`),
  and removing it would break the CLI entirely. It is the contract between the
  two projects, not a leftover.

**One asymmetry worth naming:** `detectSite()` (`70-site.js:43`) falls back to
the BookWalker adapter when no adapter claims the host. It is deliberate and
commented (tests and devtools inject a bare copy), but it means "no store
matched" and "BookWalker" are indistinguishable at that point.

## 3. Reusability: adding a fourth store

The adapter contract makes a new store mostly additive. The touch list, in order:

1. `src/sites/<store>/`, new fragments: at minimum a state/identity fragment
   and a fragment calling `registerSite({...})` with the full contract.
2. `src/manifest.json`, add every new fragment with a **new module label**, in
   dependency order.
3. `src/targets.json`, add the target (`name`, `out`, `matches`, `connects`,
   `modules`) **and add the module to the `both` target's list**. This second half
   is the sharp edge: `build.mjs`'s `checkManifest` throws when a module has no
   target at all, but forgetting `both` is silent, the new store would ship as a
   standalone script and be absent from the combined one.
4. `src/core/32-availability.js`, add a catalog entry (`siteId`, `label`,
   `color`, `origin`, `hosts`, `search`, and either per-volume parsing or a
   `freeBadge` regex).
5. `tests/test_split_builds.js`, the `EXPECT` array hardcodes the three host
   names. Without a new entry the new artifact is still built and still checked
   for metadata, but never booted, so the "does it actually run" coverage silently
   does not exist for it.
6. `tests/test_availability.js`, the fixture host map (`:101-103`) needs a search
   page for the new store if it carries the cross-store card.
7. `README.md` and `src/README.md`, the artifact table and module table.

No certificate work is needed: the fixtures map every host to 127.0.0.1 and
Chrome runs with `--ignore-certificate-errors`.

Two known gaps in that path today:

- `32-availability.js` still has `siteId: null` for ebookjapan, written when the
  module had not registered a site. It now does (`05-run.js:303`), so the
  "you are reading on this store" logic does not recognise ebookjapan. One line.
- Stale "both stores" wording from when there were two: `src/entry/90-boot.js:4`,
  `src/core/61-run-harness.js:166`, `src/README.md:9,39,171`.

Verdict: **adding a store is a well-defined ~7-file change**, and the hard part
(the panel, the download harness, the transport pool) does not move. The
single real hazard is step 3's silent half.

## 4. Comments: the data, and what I recommend

You asked me to remove comments. I measured before touching anything, and I do not
think that is the right move, but it is your call, so here is the whole picture.

**The saving is 14-21% of each artifact**: 106727 B in the combined, 75479 B in
bookwalker-only, 71520 B in cmoa-only, 74694 B in ebookjapan-only.

**What it would cost:**

- **It buys almost no speed.** Comments are skipped by the parser as trivia. Boot
  is 84-113 ms and is dominated by real work (site detection, network capture
  install, the first poll). The 29 ms gap between the combined and single-store
  builds is the cross-store feature running, not bytes being parsed.
- **It breaks two test invariants that are load-bearing.** `test_artifacts.js`
  asserts every included fragment body appears **verbatim** in the artifact, and
  `test_split_builds.js` asserts no excluded module's fragment body appears. Both
  are what make "the committed artifact is exactly what `src/` produces" a real
  claim. Stripping comments in the artifact means fragment bodies are no longer
  present verbatim, and both checks must be weakened to something much flimsier.
- **It needs a real tokenizer, not a regex.** `//` and `/* */` inside strings,
  template literals and regexes are common in this codebase (URLs alone make
  `//` frequent). A regex strip would corrupt the build, and the failure would be
  a syntax error in a generated file rather than anything pointing at the cause.
- **The comments are the only documentation the architecture has.** With no
  module system and implicit cross-fragment coupling, the `Contract:` block at
  `70-site.js:17-25` and the "why this exists" notes are what make 11557 lines
  navigable. Several explain non-obvious site behaviour that cannot be inferred
  from the code at all.
- **GreasyFork hosts the source for reading.** I could not read their rules page
  (client-side render) to confirm whether comment-stripped uploads are even
  acceptable there, so treat that as unverified rather than safe.

**Recommendation: keep them.** If artifact size becomes a real problem, the only
remaining lever is the fact that each single-store artifact duplicates the entire
shared core, which is inherent to the standalone-file model. The 213 KB wasm is
**not** a lever worth pulling: the artifact grants only `GM_xmlhttpRequest` (no
`@resource`/`GM_getResourceText`), `@connect` does not include github.com, and
`01-glue.js:19-23,92-99` has a byte/sum tripwire that a downloaded asset would
have to satisfy. Externalising it buys 198 KB, costs a new permission and an
offline regression. One 198 KB string literal costs approximately nothing to
parse. See the performance section.

If you still want action on comments, the version I would do is a **curation
pass, not a strip**: delete comments that restate the code, keep every comment
that says why, and never touch the artifact, source only. That is a review over
50 files with a concurrent author in the tree, so it wants its own branch and its
own diff to read, and it will save single-digit percent, not 20.

## 5. Performance

Verified good:

- **The wasm is lazy** (§1), the single largest potential startup cost is not
  paid at startup.
- **Boot is 84-113 ms**, which is not a problem for a panel that waits on the
  viewer's own page state anyway.
- **Cross-store lookups are cached** (`availabilityMemory`, keyed on
  `seed|volNum`) and re-run only when the detected book or volume changes
  (`70-site.js`), rather than on every poll tick.

- **Timer hygiene is real.** Every `setInterval` in `src/` has a matching
  `clearInterval` in the same file: 10 intervals across 8 files, 16 clears, no
  file with an interval and no clear (`31-mokuro.js`, `60-mokuro-flow.js`,
  `61-run-harness.js`, `sites/bookwalker/21-trial-zip.js`, `sites/bookwalker/22-run.js`,
  `sites/cmoa/02-run.js`, `sites/ebookjapan/05-run.js`). The panel's single
  `MutationObserver` (`51-panel.js:1037`) disconnects itself inside its own
  callback, it is a one-shot "wait until the stats column has content" latch, not
  a permanent watcher. The remaining risk is not whether a clear exists but
  whether every early-return path reaches it, which only a per-path read settles.
- **Cross-store network is bounded and time-limited.** Every availability query
  goes through `gmFetch(url, 15000)` (`32-availability.js:200,248`); `gmFetch`'s
  own default is 20 s (`30-stats.js:15`).

One small thing worth a cap: `availabilityMemory` (`32-availability.js:119`) is a
session-lifetime `Map` keyed `seed|volNum` with no eviction (`:428`). Entries are
small and bounded by what the user browses, so this is a note rather than a leak,
but an eviction cap would remove the question entirely.

## 6. 2.0.0 release checklist

Ordered, with the ones that need a decision marked.

1. **Decide the combined script's identity.** `targets.json` still names it
   "BookWalker + CMOA Native Downloader" and its description mentions two stores,
   while its `@match` covers all three (`ebookjapan.yahoo.co.jp/viewer/*`). On a
   GreasyFork entry whose "Applies to" lists three hosts, that reads as a bug.
   **Needs your wording.**
2. **Decide the comment question** (§4). **Needs your call.**
3. `npm run bump major`, updates `src/core/00-identity.js`, the README title and
   `package.json` in one step, then rebuilds all four artifacts.
4. **CHANGELOG:** the file has a `## v1.9.0` section for a version that never
   shipped. Rename it to `## v2.0.0` rather than listing a version nobody can
   install, and fold in the 2.0.0 highlights.
5. Fix the stale two-store wording: `src/entry/90-boot.js:4`,
   `src/core/61-run-harness.js:166`, `src/README.md:9,39,171`.
6. `src/core/32-availability.js`, set ebookjapan's `siteId: 'ebookjapan'` now
   that it registers a site.
7. `npm test` (the userscript suite: 14 files) and `npm run check:build`.
8. Commit and push `main`. **This publishes nothing**, `ci.yml` only builds and
   tests.
9. `git tag v2.0.0 && git push origin main --tags`, `release.yml` verifies the
   tag against the core version, runs the same gate, publishes the GitHub Release
   with all four artifacts, then refreshes the `release` branch.
10. Create the three new GreasyFork entries and point all four at
    `https://raw.githubusercontent.com/GolyBidoof/bookwalker-ebookjapan-cmoa-native-downloader/release/<artifact>.user.js`
    (`npm run sync-urls` prints them). Entry 594508 → `bookwalker-only.user.js`.
11. Paste the release notes per entry (`npm run notes -- v2.0.0`), or link the
    releases page instead.
12. Verify each entry shows 2.0.0 and that the release-branch raw URLs resolve.
13. **Before making the repo public**, decide what ships. The CLI set and its
    handover docs have already moved out (§7), and the stray empty `save` file is
    gone, so what remains untracked is the intended project itself.

## 7. The CLI extraction (done)

The Node CLI never belonged in this repo: it shared no code with `src/`, it was
BookWalker-only, and its own handover said `bin/`, `cli/`, `extension/` and the
stress report were "intentionally untracked/preserved". It now lives in
`../bookwalker-native-cli/` with its own `package.json`, README and `.gitignore`.

Moved: `cli/` (22 files), `bin/`, `extension/` (loaded by
`cli/public-capture.js` with `--load-extension`), `stress-test-report.md`,
`FREE_VOLUME_HANDOVER.md`, `BROWSER_SESSION_HANDOVER.md`.

Changed to make the split work:

- `cli/constants.js`, the default userscript path now points at the sibling repo
  (`SIBLING_REPO_SCRIPT`), still overridable with `BWDD_US`. `cli/runner.js` and
  `cli/public-capture.js` had two more copies of that path and now use the one
  constant, so there is a single place to fix if either project moves.
- `package.json`, `test` is just `node tests/run.js`; `test:cli`, `headless`,
  `run` and the `bin` block are gone; `sharp` moved to `devDependencies` because
  only the browser tests use it now (the userscript cannot).
- `README.md`, `RELEASING.md`, `.gitignore`, references and now-dead CLI entries
  removed. `output/` stays in `.gitignore`: `src/` and `tests/` both use it.
- The stray empty `save` file was deleted.

Verified after the move: the CLI suite passes from its new home (39/39 files, 193
assertions), its resolved default script path exists, and the userscript suite is
unaffected.

## 8. Independent audits (three subagents, `src/` only)

Run after the CLI extraction, so they cover `src/` and the build only. Line
numbers are source-relative. Where a subagent and I disagree, the disagreement is
noted.

### 8.1 Architecture and reusability

The coupling map is small and mostly declared. Genuine cross-fragment edges
number a handful: `core/21-transport-pool.js:165-166` calls
`buildWorkerSource()` from `sites/bookwalker/07-worker-descramble.js` behind a
`typeof` guard (the only core→store edge), `32-availability.js:365` reads the core
global `ACTIVE_SITE`, and `61-run-harness.js:211,241` → `60-mokuro-flow.js` →
`31-mokuro.js` chains the shared OCR stage.

**Adding a fourth store** is a 12-step change: new `src/sites/<store>/` fragments;
a `registerSite({...})` call with the full contract; drive `run()` through
`createRunHarness` (not a copy of `22-run.js`); append to `src/manifest.json`
**after `core/70-site.js`**; add the module to `targets.json` *and to `both`*; a
`AVAILABILITY_STORES` entry; update the tooltip in `34-unified-link.js:49-50`;
bridge/proxy gating if the store's CDN should use proxy ports; the docs tables;
and three test files (`test_split_builds.js:28-30` and its binary store inference
at `:123-124`, `test_site_dispatch.js:83-130`, `test_availability.js:101-103`).
It is a well-defined change, and the hard parts (panel, harness, transport pool)
do not move.

**Top architecture problems**, worst first:

- **P-1 `BookWalker does not use the shared run harness`**, `createRunHarness`
  is called only from `cmoa/02-run.js:67` and `ebookjapan/05-run.js:122`.
  `bookwalker/22-run.js` (792 lines) and `21-trial-zip.js` re-implement it, with
  three near-identical copies of the mokuro open+poll, finalize+report and
  ZIP-download blocks. `61-run-harness.js:4-6` and `src/README.md:102-121` both
  claim otherwise. **L**, but this is the single biggest maintainability item in
  the repo.
- **P-2 `Only BookWalker locked the panel during a run`**, *fixed in this pass.*
  `ui.setRunLock(true)` appeared once in all of `src/`, at `bookwalker/22-run.js:16`;
  the harness only ever released it. CMOA and ebookjapan could therefore start a
  second concurrent run over the same book. The harness now acquires the lock in
  its constructor and releases it in `cleanup()`, which both callers run in a
  `finally` (`cmoa/02-run.js:205`, `ebookjapan/05-run.js:540`), so the lock cannot
  outlive a failed run. Both the acquire and the release are `typeof`-guarded, so
  a reduced `ui` degrades to no lock rather than throwing at teardown.
- **P-3 `Three undeclared interfaces`**, the adapter object, the `ui` bag and the
  options bag have no validation, and the `ui` surface is hand-mirrored for
  headless at `11-automation.js:77-93` against the real one at `51-panel.js:1271`.
  A new store can call a `ui` member that is not stubbed and silently no-op when
  driven headlessly. **M**
- **P-4 `Store-specific assumptions in shared code`**, the availability catalog,
  the three-store tooltip (`34-unified-link.js:49-50`), the `'BookWalker Volume'`
  fallback (`30-stats.js:494`), the automation run banner (`11-automation.js:143`),
  the proxy allowlist default (`21-transport-pool.js:420-421`) and one global
  `@grant`. **M**
- **P-5 `A typo in a target's module list failed silently`**, *fixed in this
  pass*: `build.mjs` now errors on a module a target names that no fragment
  declares, with a test that builds a deliberately broken copy and asserts the
  failure (`tests/test_artifacts.js`).
- **P-6 `Manifest order is load-bearing and was unchecked`**, `SITE_REGISTRY` is
  a `const` (`70-site.js:26`) and `detectSite` is first-match-wins (`:34-39`), so
  a store fragment above `70-site.js` is a TDZ `ReferenceError` and one above
  another store silently wins shared hosts. *Fixed*: `build.mjs` now rejects a
  fragment that calls `registerSite()` before the fragment that defines it, also
  covered by the new test.
- **P-7 `Tests hardcode the store count`**, `test_split_builds.js:123-124`
  infers the expected adapter with a binary if/else ending in `'ebookjapan'`;
  `test_availability.js:211` asserts exactly two pills. **M**
- **P-8 `Documentation has drifted`**, `src/README.md:9-11` omits
  `ebookjapan-only.user.js`, `:36-43` omits `sites/ebookjapan`, the core table
  omits `34-unified-link.js`, `:118-121` repeats the false harness claim, `:22`
  still uses a 1.6.5 example, and `src/manifest.json:7` says "both stores". Since
  this README is the only contract a new author has, drift here is how the next
  store gets built wrong. **S**

**Three things that are genuinely well designed** (verified, not assumed):

1. **The adapter seam holds.** The core is store-agnostic in fact, not just in
   intent: there are no `cmoa*`/`ebj*` identifiers anywhere in
   `src/sites/bookwalker/`, and no BookWalker identifier in the other two.
   `entry/90-boot.js:37,43-45` merges the active adapter's surface rather than
   naming a store.
2. **Targets drive metadata, so an artifact cannot claim a store it cannot
   handle.** `build.mjs:56-81` renders `@name/@match/@connect/@icon` from
   `targets.json`; `build.mjs:102-126` rejects unlisted fragments and orphan
   modules; `test_artifacts.js` asserts each artifact contains exactly its
   allowed fragments and no excluded ones.
3. **`typeof`-guarded seams instead of broken references.** `70-site.js:136-139`,
   `21-transport-pool.js:165-166` (no worker pool rather than a crash) and
   `13-pagecache.js:62-63`, plus one genuinely shared OCR stage
   (`60-mokuro-flow.js` called by both the harness and BookWalker's hand-rolled
   paths).

### 8.2 Code quality

No `TODO`/`FIXME`/`HACK`/`XXX` markers exist anywhere in `src/`.

**Dead code.** Confirmed unreferenced: `activeSite()` (`70-site.js:46`),
`isPublicFreeBootstrapPage()` (`bookwalker/06-auth-helpers.js:7`, re-inlined at
`20-auth-lifecycle.js:247`), `renderStatsCards` (`30-stats.js:480`) and
`showBars(ui)` (`51-panel.js:1330`), both reachable only through the debug export
at `90-boot.js:40`; the adapter `state` field, which nothing reads (tests read
`window.__bwdd.state`, which comes from `debug:{state}`); most of the harness's
exported API (`61-run-harness.js:417-428`). **Per-target dead code is the
interesting kind**: `core/22-transport-health.js` and all of
`core/23-transport-burst.js` are dead in the CMOA and ebookjapan builds, because
their only callers are BookWalker fragments, so those artifacts ship breaker and
burst logic they cannot reach.

**Duplication.** Beyond P-1: the retry-failed-pages loop exists twice
(`22-run.js:608-629` vs `cmoa/02-run.js:175-187`); the GM_xhr envelope exists four
times (`21-transport-pool.js:381`, `30-stats.js:15`, `31-mokuro.js:52,82`,
`cmoa/01-fetch.js:87`); the CRC32 table twice (`41-zip.js:2-14`,
`08-worker-main.js:2-17`); canvas→Blob twice (`cmoa/01-fetch.js:168`,
`ebookjapan/02-descramble.js:487`); the BookWalker CDN host four times; and the
timeouts `45000`/`4000`/`60000` are unnamed literals repeated 7/4/4 times.

**Three real bugs, worst first.** Two are fixed as of this pass; see the note at the end.

1. **`bookwalker/22-run.js:104-105`** dereferences
   `config[contents[0].file].FileLinkInfo.PageLinkInfoList[0].Page` unguarded on a
   network-derived manifest. A section without `FileLinkInfo` aborts the entire
   non-trial run before a single page is fetched, and the panel shows only
   `Error: Cannot read properties of undefined…`. The trial path guards the
   identical shape (`21-trial-zip.js:113-116`).
2. **`bookwalker/22-run.js:544`**, `failedIdx.add(jobSeq + 1)` runs before the
   only `jobSeq++` (`:548`), so a missing manifest section marks the *next* page
   as failed and drops the section from `realTotal` (`:569`). "Saved N of M" and
   the retry rounds are then quietly wrong.
3. **`bookwalker/20-auth-lifecycle.js:260`** ,
   `if (!state.auth || !state.baseUrl && !cFirst)` binds as
   `!state.auth || (!state.baseUrl && !cFirst)`. With `cFirst` true, auth present
   and `baseUrl` absent, the `/c` fallback is skipped and the run dies with
   "Failed to capture session auth…" (`:268`). The intent reads like
   `(!state.auth || !state.baseUrl) && !cFirst`.

**Fixed in this pass.** Bugs 1 and 2. `22-run.js` now dereferences the manifest
through the same defensive chain the trial path already used at line 74 for the
identical shape, so one section without `FileLinkInfo` no longer aborts the whole
run with a `TypeError` before a single page is fetched.

For bug 2 the fix is not a re-index but a deletion: `jobSeq + 1` is the index of
the *next* page, which has not been counted yet, so the old line marked an
innocent page as failed, self-healing only if that page happened to succeed ,
and when the missing section was last it left an index beyond `realTotal` that no
job could ever clear, so `failedIdx` never emptied. That phantom then made
`finishedOk` false and blocked the post-run cache clear. A missing section is now
recorded in `missingSections`, is allowed to force the partial message (without
it a run could report "Saved 250 of 250" while a section had failed, since the
missing section contributes no page indices to `total`), and no longer reports as
finished-ok.

**Bug 3 is fixed, and git history is what settled it.** An earlier draft of this
section recommended leaving it alone, because the second `/c` call might be
load-bearing for a public/free reader. `git log -S` disproves that premise:
`cFirst` and `publicBootstrap` appear in **no commit in the repository**, they
were introduced in the current uncommitted work, so there is no shipped behaviour
depending on them. In v1.5.1 (`bookwalker-native-downloader.user.js:5911-5931`) the
sequence was nested and strictly sequential:

```js
if (!state.auth || !state.baseUrl) {
    try { if (trial…) d = await refreshAuthTrial(); } catch (e) {}
    if (!state.auth || !state.baseUrl) {
        try { await refreshAuthViaPb(); } catch (e) {}
        if (!state.auth || !state.baseUrl) {   // /c, once, and only as the fallback
            try { d = await refreshAuthViaC(); } catch (e) { d = null; }
        }
    }
    if (!state.auth || !state.baseUrl) { throw new Error(hint); }
}
```

So `/c` was called **at most once per sequence, and only after `/pb` had left us
still missing**. The parenthesised condition restores exactly that invariant:
`(!state.auth || !state.baseUrl) && !cFirst`. The `cFirst` branch's `/c` is no
longer repeated, and the non-`cFirst` path is v1.5.1's `/pb` → `/c` verbatim.
`refreshAuthBest()` (`20-auth-lifecycle.js:85-97`) already carried the other half
of the v1.5.1 semantics forward unchanged, `/c` after `/pb`, skipped when `/pb`
moved the policy signature.

One deliberate difference remains, and it is not a regression: v1.5.1 had no
public/free route, so it always tried `/pb` first. The `cFirst` branch suppresses
`/pb` on that route because a synthetic bookmark advances a public reader's
position. Matching v1.5.1 *literally* would mean deleting the `cFirst` branch and
re-accepting that; matching its *invariant*, one `/c`, as a fallback, is what
the code now does.

Also fixed in this pass: `gmFetch`'s plain-fetch path (`30-stats.js:31`) had no
timeout while the other two paths did, so one unresponsive host could leave the
stats card pending forever; both un-bounded paths now abort and clear their
timers.

### 8.3 Performance

Boot is bounded and not a problem: parse of one concatenated artifact plus ~30 KB
of CSS plus DOM work, with the wasm reached only via the ebookjapan boot-poll
caveat above. Userscript-visible cost is dominated by run-time work, not bytes.

**Timer hygiene is good.** Every `setInterval` in `src/` has a matching
`clearInterval` reachable on its completion path (`60-mokuro-flow.js:69`,
`61-run-harness.js:146`, `31-mokuro.js:363`, `cmoa/02-run.js:256`,
`ebookjapan/05-run.js:357`, `bookwalker/22-run.js:169,195`, `21-trial-zip.js:72`),
and the panel's `MutationObserver` (`51-panel.js:1037`) disconnects itself on
first fire. All object URLs have matching revokes.

**Top 8 by user-visible impact:**

1. **ebookjapan resolved twice concurrently. Folded into the harness fix above
   as the second release blocker:** *fixed in this pass.* `ebjResolvePages`
   (`ebookjapan/00-state.js:86-210`) has no in-flight guard, unlike CMOA's
   `collecting` flag (`cmoa/00-state.js:387`), and is triggered by both the boot
   poll (`70-site.js:113`) and the run timer (`ebookjapan/05-run.js:357`). Both
   read `ebjCore === null` (`01-glue.js:84`) before either sets it (`:123`), so
   the user paid two wasm decodes/instantiations and two `open_book` sessions,
   which raced on the same `ebjState`. `ebjResolvePages` is now a single-flight
   wrapper keyed on the target: concurrent callers share one attempt, a rejected
   attempt does not wedge the memo, and different targets are never merged.
   Covered by `tests/test_run_safety.js`, which slices the shipped bytes out and
   drives them.
2. **ebookjapan computes full-frame `getImageData` for every page**, though the
   stats are consumed only by the page-1 gate (`ebookjapan/04-worker.js:91` vs
   `05-run.js:160-167`). One GPU→CPU sync and a transient allocation per wasted
   page. **S**
3. **CMOA descrambles and encodes on the main thread**, `src/sites/cmoa` uses no
   workers at all; `cmoa/02-run.js:161-173` runs ~20-26 jobs through
   `cmoa/01-fetch.js:205-255`. Jank plus live canvas backing. **L**
4. **The boot poll calls `site.refresh()` every 500 ms** regardless of whether
   anything changed (`70-site.js:108-115`), which is what makes 1 worse. **S**
5. **Zip mode retains every page blob until the run ends**
   (`bookwalker/22-run.js:131,281-285,736`), peaking at roughly the whole book.
   **M**
6. **Availability walks candidates sequentially at 15 s each with no in-flight
   dedupe** (`32-availability.js:244-266,410-427`). *Partly fixed in this pass*:
   one shared fan-out per key, and the cache is now capped at 50 entries.
   Sequential candidate walks remain. **S**
7. **Untimed fetch paths**, ebookjapan's resolve (`00-state.js:68,91,116`) still
   has none. *Fixed* for `gmFetch`. **S**
8. **The bridge `/health` endpoint is fetched twice per tick**
   (`51-panel.js:261` and `:271`) plus a boot-time IndexedDB prune
   (`70-site.js:97`). **S**

**Leaks.** `availabilityMemory` was unbounded (now capped);
`ebjPoolWaiters` (`ebookjapan/04-worker.js:121`) keeps an entry for a worker that
dies without posting, since `pool.terminate()` does not clear it; BookWalker's
`ocrBuffer` (`22-run.js:221`) and `zip.entries` hold page blobs for the run's
duration.

## 9. Recommended order before 2.0.0, status

1. **The two decisions that blocked everything else**, done. The combined script
   is `Omnimanga Native Downloader` (§10), and the comments were trimmed 17%
   rather than removed.
2. **The three BookWalker bugs in §8.2**, all three fixed. Git history settled
   the third (§8.2).
3. **P-2 and perf 1**, the two release blockers, both fixed in this pass and
   covered by `tests/test_run_safety.js` (15 checks): the run lock is now held by
   the shared harness, and ebookjapan resolves a volume once at a time. Perf 2/4
   (per-page `getImageData`, the unconditional 500 ms `refresh()`) remain open but
   are not release gates.
4. **P-1 (BookWalker onto the shared harness)**, still the big one, still **L**,
   still deliberately not attempted in the same window as a version bump.
5. **P-8 doc drift**, done (§10).
6. **Still open for the tag:** commit the tree (HEAD is `3b18079 Release v1.5.1`,
   with the whole architecture untracked), rename `## v1.9.0` → `## v2.0.0` in the
   changelog, decide the artifact filename, and wait for the concurrent ebookjapan
   author to settle.

## 10. Decisions taken, and the state of the tree

**The combined script is renamed `Omnimanga Native Downloader`.** Applied to
`src/targets.json` (`both.name`, plus `description` and `banner`, which both still
said two stores), the README title and the `src/README.md` tables. The old name
"BookWalker + CMOA Native Downloader" predated the ebookjapan module and read as a
bug next to an `@match` list covering three hosts.

**The artifact filename did change, and so did the repository.** The combined
artifact is now `omnimanga-native-downloader.user.js` (26 references:
`targets.json`, the pill's constant, twelve `BWDD_US` defaults across the test
harness, the docs, and the separate CLI project) and the GitHub repository is
`bookwalker-ebookjapan-cmoa-native-downloader`. `tests/test_artifacts.js` asserts
the artifact name the pill carries against `both.out`, and the panel test asserts
the GitHub repository URL, so neither rename can half-land. One consequence is
operational rather than cosmetic: GreasyFork entry 594508 still syncs the old
filename, which no longer exists in any release, so it will stop updating rather
than silently change - it has to be repointed at `bookwalker-only.user.js`.

**Documentation drift (P-8) is fixed** in `README.md`, `src/README.md` and
`src/manifest.json`: the artifact table now lists all four scripts, the tree and
the core table list `sites/ebookjapan` and `34-unified-link.js`, the "why one
file" section says three stores, the `npm run bump` example moved off 1.6.5, and
the run-harness section now states plainly that **only CMOA and ebookjapan create
a harness today** and that BookWalker's paths hand-roll the same stages, it
previously implied BookWalker used it, which is the same false claim as
`61-run-harness.js:4-6`.

**Comments: trimmed, not removed** (the decision above). The pass covers the 49
files outside `src/sites/ebookjapan/`, the rule is keep every *why*, delete
restatement, orphaned blocks and stale claims. Because the fragments are
concatenated verbatim, "no code changed" is verifiable rather than asserted: a
baseline snapshot of `src/` was taken first, and each fragment is compared
before/after with comments stripped, on top of the full suite.

**The tree is moving underneath this audit.** `src/sites/ebookjapan/05-run.js`
grew 400 → 604 lines (+10,180 B) at 02:39 during this session, the concurrent
author, not this pass. The combined artifact went 774,861 B (measured in §1) to
786,445 B for that reason, not because of the rename (which is worth ~200 B). All
byte figures in §1 are a snapshot of that moment; the architecture holds, the
numbers drift.
