#!/usr/bin/env node
// =============================================================================
// ebookjapan adapter — the parts that must not rot silently
// =============================================================================
// Deliberately no browser: the glue tripwire is the one thing whose failure is
// invisible until a run is already descrambling nothing, so it is checked
// straight out of the built artifact. If the embedded glue and its pinned
// checksum ever drift apart, this fails before a page is fetched.
//
// The browser-side behaviour of the adapter (detection, branding, state
// isolation, the panel) is covered by tests/test_site_dispatch.js, and its
// placement in every build by tests/test_split_builds.js.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  PASS  ' + name + (detail ? '  — ' + detail : '')); }
  else { failed++; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}

// Mirrors ebjGlueChecksum() in src/sites/ebookjapan/01-glue.js exactly.
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}

const ARTIFACTS = ['ebookjapan-only.user.js', 'omnimanga-native-downloader.user.js'];

// The body of one top-level fragment function, so an ordering claim can be
// asserted against the code rather than against the whole artifact. The search
// starts at the declaration line, which deliberately excludes any doc comment
// above it (a comment that merely mentions a transport must not be able to
// satisfy an order check).
function fnBody(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return null;
  const ends = [
    src.indexOf('\n    async function ', start + 1),
    src.indexOf('\n    function ', start + 1),
  ].filter(i => i !== -1);
  return src.slice(start, ends.length ? Math.min.apply(null, ends) : src.length);
}

// The doc comment above that function plus its body: a decision has to stay
// documented, not just implemented.
function fnDoc(src, name) {
  const body = fnBody(src, name);
  if (body == null) return null;
  const decl = src.indexOf('function ' + name + '(');
  const doc = src.lastIndexOf('/**', decl);
  return doc !== -1 ? src.slice(doc, decl + body.length) : body;
}

// Evaluate the shipped timing accumulator in Node. It is pure arithmetic over
// performance.now() samples, so the built bytes can be loaded and driven
// directly: this checks the numbers the run reports, not just that a function
// with the right name exists.
function loadTiming(src) {
  const a = src.indexOf('const EBJ_TIMING_SAMPLES');
  const b = src.indexOf('function ebjTimingPublish(');
  if (a === -1 || b <= a) return null;
  const block = src.slice(a, b);
  try {
    const factory = new Function(block +
      '\nreturn { ebjTimingNew, ebjTimingAdd, ebjTimingLane, ebjTimingLine, ebjTimingRaw,' +
      ' ebjMedian, EBJ_TIMING_SAMPLES };');
    return factory();
  } catch (e) { return null; }
}

for (const file of ARTIFACTS) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  console.log('\n' + file);

  const grab = (name) => {
    const i = src.indexOf('const ' + name + ' =');
    if (i === -1) return null;
    const j = src.indexOf(';', i);
    return (src.slice(i, j).match(/'([A-Za-z0-9+/=]*)'/g) || []).map(s => s.slice(1, -1)).join('');
  };

  const glueB64 = grab('EBJ_GLUE_B64');
  const wasmB64 = grab('EBJ_WASM_B64');
  check('the pinned glue is embedded', !!glueB64 && glueB64.length > 1000,
    glueB64 ? glueB64.length + ' base64 chars' : 'missing');
  check('the wasm module is embedded', !!wasmB64 && wasmB64.length > 10000,
    wasmB64 ? wasmB64.length + ' base64 chars' : 'missing');

  const glue = Buffer.from(glueB64 || '', 'base64');
  const wasm = Buffer.from(wasmB64 || '', 'base64');
  const bytes = Number((/const EBJ_GLUE_BYTES = (\d+)/.exec(src) || [])[1]);
  const sum = (/const EBJ_GLUE_SUM = '([0-9a-f]+)'/.exec(src) || [])[1];
  const actual = fnv1a32(glue.toString('utf8'));

  check('the glue decodes to its pinned length', glue.length === bytes,
    glue.length + ' vs pinned ' + bytes);
  check('the glue matches its pinned checksum', actual === sum,
    actual + ' vs pinned ' + sum);
  check('the wasm module starts with the wasm magic', wasm.slice(0, 4).toString('hex') === '0061736d',
    wasm.slice(0, 4).toString('hex'));
  check('the adapter registers under its own id', /id: 'ebookjapan'/.test(src));
  check('the codec is mapped, not assumed', /function ebjCodec\(/.test(src));
  check('the paint gate survives', /function canvasStats\(/.test(src) && /mean < 6/.test(src));
  check('the autograph is never null', /autographed: aov/.test(src) && !/autographed: null/.test(src));

  // The run pipeline's requirements, asserted against what actually ships, so a
  // later refactor of core cannot quietly drop one of them.
  check('pages arrive through the shared lane pool', /await laneFetch\(/.test(src));
  check('a lane reply is checked, not assumed', /if \(!res \|\| !res\.ok\)/.test(src));
  check('the run goes through the shared harness', /createRunHarness\(/.test(src));
  check('failed pages get a second pass', /harness\.failedIdx\.size/.test(src));
  check('the in-thread path is still there as the fallback', /out = await descramblePage\(glue, bitmap, row, geo,/.test(src));
  check('the panel is populated before a run starts', /async refresh\(\)/.test(src));
  check('the adapter satisfies its contract', /run\(ui, mode, options\)/.test(src) && /getCid\(\)/.test(src) && /archiveDefault\(/.test(src));

  // ---------------------------------------------------------------------
  // Per-page stage timing. The complaint is a run that starts fast and falls
  // to ~1 page/s, and the whole point of these numbers is to say which of
  // fetch / descramble / write owns it. A missing or unwired stage would send
  // the next session optimising the wrong one, so both the accumulator and its
  // two surfaces (panel details + console log) are pinned.
  // ---------------------------------------------------------------------
  check('per-page stage timing exists', /function ebjTimingNew\(/.test(src) && /function ebjTimingAdd\(/.test(src));
  check('fetch, descramble and the archive write are timed separately',
    /ebjTimingAdd\(ebjTiming, 'fetch'/.test(src) &&
    /ebjTimingAdd\(ebjTiming, 'descramble'/.test(src) &&
    /ebjTimingAdd\(ebjTiming, 'write'/.test(src) &&
    /ebjTimingAdd\(ebjTiming, 'decode'/.test(src));
  check('the retry pass and the canary fetches are timed too',
    (src.match(/ebjTimingAdd\(ebjTiming, 'fetch'/g) || []).length >= 2 &&
    (src.match(/ebjTimingAdd\(ebjTiming, 'descramble'/g) || []).length >= 2);
  check('every page reports the transport that served it', /function ebjTimingLane\(/.test(src) && /ebjTimingLane\(ebjTiming, got\.lane\)/.test(src));
  check('the summary carries totals plus min/median/max per stage',
    /min\/median\/max over/.test(src) && /function ebjMedian\(/.test(src) && /function ebjTimingStageText\(/.test(src));
  check('the page-phase wall clock is wired around the fetch/descramble window',
    /ebjTiming\.start = ebjNow\(\)/.test(src) &&
    /ebjTiming\.phaseMs = ebjNow\(\) - ebjTiming\.start/.test(src) &&
    /function ebjTimingRate\(/.test(src));
  check('the timing summary is logged through ebjLog', /ebjLog\('timing', line\)/.test(src));
  check('the timing summary reaches the run details via setRunDetails',
    /function ebjTimingPublish\(/.test(src) && /setRunDetails\(el, existing \?/.test(src) &&
    /ebjTimingPublish\(ui, harness, ebjTiming\)/.test(src));
  check('the automation result carries the same numbers',
    /harness && harness\.runResult/.test(src) && /rr\.timing = \{/.test(src) &&
    /descrambleMs: Math\.round\(t\.descramble\.total\)/.test(src));
  check('the failure path reports the timing too, not just the happy path',
    (src.match(/ebjTimingPublish\(ui, harness, ebjTiming\)/g) || []).length >= 2);
  check('per-page logging stays off (no line per page)', !/ebjLog\([^)]*pageIdx/.test(src));

  const TM = loadTiming(src);
  check('the shipped timing accumulator is loadable and arithmetic', !!TM);
  if (TM) {
    const t = TM.ebjTimingNew();
    [100, 300, 200, 400, 500].forEach(v => TM.ebjTimingAdd(t, 'fetch', v));
    check('timing accumulates a stage total', t.fetch.total === 1500, String(t.fetch.total));
    check('timing tracks min and max', t.fetch.min === 100 && t.fetch.max === 500,
      t.fetch.min + ' / ' + t.fetch.max);
    check('timing computes the median of the samples', TM.ebjMedian(t.fetch.ring) === 300,
      String(TM.ebjMedian(t.fetch.ring)));
    TM.ebjTimingLane(t, 'gm');
    TM.ebjTimingLane(t, 'gm');
    [10, 20, 30].forEach(v => TM.ebjTimingAdd(t, 'decode', v));
    [40, 90, 60].forEach(v => TM.ebjTimingAdd(t, 'descramble', v));
    [5, 7, 9].forEach(v => TM.ebjTimingAdd(t, 'write', v));
    t.pages = 5;
    t.phaseMs = 1000;
    const line = TM.ebjTimingLine(t);
    check('the one-line breakdown names fetch, cpu, write and wall',
      /^timing: /.test(line) && /fetch /.test(line) && /cpu /.test(line) && /write /.test(line) &&
      /wall 1\.0s \(5\.0 pages\/s\)/.test(line) && /lanes gm 2/.test(line),
      line.slice(0, 110));
    check('the raw lines expose one min/median/max line per stage plus the wall clock',
      TM.ebjTimingRaw(t).length === 5 && /^fetch: /.test(TM.ebjTimingRaw(t)[0]) &&
      /^write: /.test(TM.ebjTimingRaw(t)[3]) && /^wall: /.test(TM.ebjTimingRaw(t)[4]),
      TM.ebjTimingRaw(t).join(' | ').slice(0, 140));
    for (let i = 0; i < 4000; i++) TM.ebjTimingAdd(t, 'fetch', i + 1);
    check('the sample ring stays bounded on a long book',
      t.fetch.ring.length <= TM.EBJ_TIMING_SAMPLES && TM.EBJ_TIMING_SAMPLES === 512,
      t.fetch.ring.length + ' samples');
  }

  // ---------------------------------------------------------------------
  // The retry pass must be bounded-parallel and reuse the main gate. The old
  // serial `for (const i of Array.from(harness.failedIdx))` awaited one full
  // main-thread descramble per iteration, which is the "fast, then 1 page/s"
  // tail; it must not come back, and the page index must come from the retry
  // cursor rather than a leftover main-loop index.
  // ---------------------------------------------------------------------
  check('the retry pass is no longer a serial awaited loop',
    !/for \(const i of Array\.from\(harness\.failedIdx\)\)/.test(src));
  check('the retry pass is fed through the main worker() and gate',
    /ebjRetryList = Array\.from\(harness\.failedIdx\)/.test(src) &&
    /for \(let w = 0; w < concurrency; w\+\+\) retryWorkers\.push\(worker\(\)\)/.test(src));
  check('the retry cursor yields the retried index, and the page index derives from it',
    /const ebjNextJob = \(\) =>/.test(src) &&
    /ebjRetryList\[ebjRetryAt\+\+\]/.test(src) &&
    /const pageIdx = i \+ 1;/.test(src));
  check('the retry stays bounded to the same gate as the main pass',
    (src.match(/for \(let w = 0; w < concurrency; w\+\+\)/g) || []).length >= 2);

  // ---------------------------------------------------------------------
  // The fetch order is a deliberate decision, not an untested default: GM is
  // the only transport this page's CSP lets reach either the CDN or a loopback
  // bridge port, so it is tried first and the shared lanes stay the fallback.
  // If someone flips it, this fails and points at the reasoning in the body.
  // ---------------------------------------------------------------------
  const fetchBody = fnBody(src, 'ebjFetchPage');
  const fetchDoc = fnDoc(src, 'ebjFetchPage');
  check('ebjFetchPage is present for the order check', !!fetchBody);
  if (fetchBody) {
    check('GM is attempted before the shared lanes',
      fetchBody.indexOf('GM_xmlhttpRequest') !== -1 &&
      fetchBody.indexOf('laneFetch(') !== -1 &&
      fetchBody.indexOf('GM_xmlhttpRequest') < fetchBody.indexOf('laneFetch('));
    check('the fetch order records why the bridge lane cannot serve here',
      !!fetchDoc && /connect-src/.test(fetchDoc) && /allowProxy/.test(fetchDoc) && /proxyUrlFor/.test(fetchDoc));
  }

  // The resolve helpers must exist or the run dies before it starts. apiHeaders
  // went missing with the standalone's GM layer and every resolve threw a
  // ReferenceError that only ever reached console.warn, so Save looked inert.
  check('the viewer API headers helper is defined', /const apiHeaders =/.test(src));
  check('a failed run reaches the panel, not just the console', /setRunDetails\(ui\.details/.test(src));
  check('the live debug surface is exported', /__bwddEbookjapanDebug/.test(src));
  check('the run announces itself before it does anything', /ebjLog\('run', 'entered:/.test(src));

  // These must be declarations in the run's own scope: the finally that
  // terminates the pool cannot see a let declared inside the arming try, and
  // that threw "ebjPool is not defined" after a run had already saved.
  check('the pool is declared in the run function scope',
    /let ebjPool = null;/.test(src) && /let ebjCanary = null;/.test(src));
  check('a page whose CSP refuses blob: workers is probed, not respawned',
    /function ebjWorkerAllowed\(/.test(src) && /ebjSkipPool/.test(src));
}

console.log('');
if (failed) { console.log(failed + ' FAILED'); process.exit(1); }
console.log('ALL ' + passed + ' CHECKS PASSED');
