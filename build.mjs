#!/usr/bin/env node
/*
 * Builds the installable userscripts from the fragments in src/.
 *
 * The fragments are plain, ordered pieces of one IIFE: they share a single
 * closure and are concatenated in manifest order, which is also the order they
 * appear in the shipped file.  Keeping the build this dumb means the artifact
 * stays readable and diffable against src/ line-for-line, and there is no
 * bundler, no module loader and no source map to go stale.
 *
 * Targets (src/targets.json) select which modules go into an artifact:
 *
 *   both        omnimanga-native-downloader.user.js   _meta core sites/* entry
 *   bookwalker  bookwalker-only.user.js                _meta core sites/bookwalker entry
 *   cmoa        cmoa-only.user.js                      _meta core sites/cmoa entry
 *
 * The split artifacts share the compiled core but carry exactly one store's
 * module, so neither contains a line of the other store's logic.  Each target
 * also renders its own metadata block from src/_meta/00-header.txt, so the name,
 * @match and @connect never claim a store the artifact cannot handle.
 *
 *   node build.mjs                       write every target
 *   node build.mjs --target cmoa         write one target
 *   node build.mjs --check               verify every artifact matches src/
 *   node build.mjs --check --target cmoa verify one artifact
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'src');
const MANIFEST = path.join(SRC, 'manifest.json');
const TARGETS_FILE = path.join(SRC, 'targets.json');
const HEADER = '_meta/00-header.txt';
const IDENTITY = 'core/00-identity.js';

// Where an installed script looks for its next version. A release asset is used
// rather than a raw branch URL so that a half-finished push to main can never
// become somebody's update; ./releases/latest/download/<name> always resolves to
// the newest published release, and is stable across versions.
function repositoryUrl() {
    const pkg = readJson(path.join(ROOT, 'package.json'));
    const repo = typeof pkg.repository === 'string' ? pkg.repository
        : (pkg.repository && pkg.repository.url);
    if (!repo) throw new Error('package.json needs a repository URL: it is the base for @updateURL/@downloadURL');
    return String(repo).replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/$/, '');
}
const RELEASE_BASE = repositoryUrl() + '/releases/latest/download';

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function renderHeader(template, target, version) {
    const banner = target.banner.map(line => (line ? '// ' + line : '//')).join('\n');
    const subs = {
        '{{VERSION}}': version,
        '{{NAME}}': target.name,
        '{{DESCRIPTION}}': target.description,
        '{{ICON}}': target.icon,
        '{{MATCH_LINES}}': target.matches.map(m => '// @match        ' + m).join('\n'),
        '{{CONNECT_LINES}}': target.connects.map(c => '// @connect      ' + c).join('\n'),
        '{{UPDATE_URL}}': RELEASE_BASE + '/' + target.out,
        '{{DOWNLOAD_URL}}': RELEASE_BASE + '/' + target.out,
        '{{BANNER}}': banner,
    };
    let out = template;
    for (const [k, v] of Object.entries(subs)) {
        if (!out.includes(k)) throw new Error('header template is missing ' + k);
        out = out.split(k).join(v);
    }
    const left = out.match(/\{\{[A-Z_]+\}\}/);
    if (left) throw new Error('header template has an unknown placeholder: ' + left[0]);
    return out;
}

// The version has exactly one source of truth: the BWDD_VERSION literal in
// src/core/00-identity.js. The metadata @version is substituted from it, so the
// manager keys updates off the same number the panel prints and a hand-kept
// copy cannot drift. `node bump.mjs` is the only thing that should write it.
function readVersion() {
    const src = fs.readFileSync(path.join(SRC, IDENTITY), 'utf8');
    const m = src.match(/return '([0-9]+\.[0-9]+\.[0-9]+)';/);
    if (!m) throw new Error("no version literal in " + IDENTITY + " (expected: return 'x.y.z';)");
    return m[1];
}

function checkVersion(text, version) {
    const meta = (text.match(/^\/\/ @version\s+(\S+)\s*$/m) || [])[1];
    if (meta !== version) {
        throw new Error('rendered @version ' + meta + ' does not match BWDD_VERSION ' + version);
    }
}

// The fragment list is hand-maintained, so check it against the tree. A file
// dropped into src/ but never listed would be silently missing from every
// artifact, and a module no target includes would be code that ships nowhere -
// both were easy to miss behind the old bytes/lines map, which had itself
// drifted 1,789 lines out of date before it was removed.
function checkManifest(manifest) {
    const listed = new Set();
    for (const frag of manifest.fragments) {
        if (!frag.file || !frag.module) throw new Error('fragment needs file and module: ' + JSON.stringify(frag));
        if (listed.has(frag.file)) throw new Error('duplicate fragment in manifest: ' + frag.file);
        listed.add(frag.file);
        if (!fs.existsSync(path.join(SRC, frag.file))) throw new Error('missing fragment: ' + frag.file);
    }
    const skip = new Set(['manifest.json', 'targets.json']);
    const found = [];
    (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { walk(p); continue; }
            if (!/\.(js|txt)$/.test(e.name)) continue;
            const rel = path.relative(SRC, p).split(path.sep).join('/');
            if (!skip.has(rel)) found.push(rel);
        }
    })(SRC);
    const unlisted = found.filter(f => !listed.has(f)).sort();
    if (unlisted.length) throw new Error('in src/ but not in src/manifest.json: ' + unlisted.join(', '));
    const used = new Set();
    for (const t of Object.values(readJson(TARGETS_FILE))) for (const mo of t.modules) used.add(mo);
    const orphan = [...new Set(manifest.fragments.map(f => f.module))].filter(mo => !used.has(mo)).sort();
    if (orphan.length) throw new Error('module no target includes: ' + orphan.join(', '));

    // The other direction, which used to fail silently: a module name a target
    // lists but no fragment declares. A typo there produces an artifact that
    // builds, compiles and passes --check while quietly missing a whole store or
    // feature - the worst kind of release bug, because nothing looks wrong.
    const declared = new Set(manifest.fragments.map(f => f.module));
    const phantom = [...used].filter(mo => !declared.has(mo)).sort();
    if (phantom.length) throw new Error('target names a module with no fragments: ' + phantom.join(', '));

    // Manifest order is load-bearing: SITE_REGISTRY is a const and detectSite()
    // is first-match-wins, so a store fragment placed above the fragment that
    // defines registerSite() is a TDZ ReferenceError at boot, and one placed
    // above another store silently wins the hosts they share. Neither shows up
    // as a syntax error, so check the order explicitly.
    const body = f => fs.readFileSync(path.join(SRC, f.file), 'utf8');
    const defines = manifest.fragments.findIndex(f => /function\s+registerSite\s*\(/.test(body(f)));
    if (defines >= 0) {
        const early = manifest.fragments
            .map((f, i) => ({ f, i }))
            .filter(({ f, i }) => i < defines && /registerSite\s*\(\s*\{/.test(body(f)))
            .map(({ f }) => f.file);
        if (early.length) {
            throw new Error('fragment calls registerSite() before ' +
                manifest.fragments[defines].file + ' defines it: ' + early.join(', '));
        }
    }
}

function assemble(targetId) {
    const manifest = readJson(MANIFEST);
    const targets = readJson(TARGETS_FILE);
    const target = targets[targetId];
    if (!target) throw new Error('unknown target: ' + targetId + ' (have ' + Object.keys(targets).join(', ') + ')');
    const allow = new Set(target.modules);
    const version = readVersion();
    const parts = [];
    const included = [];
    for (const frag of manifest.fragments) {
        if (!allow.has(frag.module)) continue;
        let body = fs.readFileSync(path.join(SRC, frag.file), 'utf8');
        if (frag.file === HEADER) body = renderHeader(body, target, version);
        if (!body.endsWith('\n')) throw new Error('fragment must end with a newline: ' + frag.file);
        parts.push(body);
        included.push(frag.file);
    }
    const text = parts.join('');
    checkVersion(text, version);
    const out = path.join(ROOT, target.out);
    checkSyntax(text, out);
    return { text, out, included, target };
}

// A truncated or mis-concatenated fragment still looks like a plausible file to
// a diff. The artifact is installed by Tampermonkey appending it as a <script>,
// where a parse error surfaces as an opaque "Failed to execute 'appendChild'
// ... Unexpected token ','" naming a line in the generated file and nothing in
// src/. Compile every artifact here so a broken build can never leave this
// script, and so the error points at the fragment that caused it.
function checkSyntax(text, out) {
    try {
        new vm.Script(text, { filename: 'artifact' });
    } catch (e) {
        const m = /artifact:(\d+)/.exec(e.stack || '');
        const line = m ? Number(m[1]) : null;
        let where = '';
        if (line) {
            where = '\n  ' + path.relative(ROOT, out) + ':' + line +
                '\n  ' + String(text.split('\n')[line - 1] || '').trim().slice(0, 200);
        }
        throw new Error('built artifact is not valid JavaScript: ' + e.message + where);
    }
}

function parseArgs(argv) {
    const ids = [];
    let check = false;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--check') check = true;
        else if (a === '--target') { ids.push(...String(argv[++i] || '').split(',').filter(Boolean)); }
        else if (a.startsWith('--target=')) { ids.push(...a.slice(9).split(',').filter(Boolean)); }
        else throw new Error('unknown argument: ' + a);
    }
    return { ids, check };
}

function main() {
    const { ids, check } = parseArgs(process.argv.slice(2));
    checkManifest(readJson(MANIFEST));
    const all = Object.keys(readJson(TARGETS_FILE));
    const want = ids.length ? ids : all;
    let bad = 0;
    for (const id of want) {
        const { text, out, included, target } = assemble(id);
        const rel = path.relative(ROOT, out);
        if (check) {
            const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
            if (current === text) {
                console.log('up to date  ' + rel.padEnd(38) + ' (' + included.length + ' fragments, ' + text.split('\n').length + ' lines)');
            } else {
                console.log('STALE       ' + rel + (current ? '' : '  (missing)'));
                bad++;
            }
        } else {
            // Write atomically. writeFileSync truncates first, so a reader that
            // opens the file mid-write (Tampermonkey re-reading a local install)
            // can get a truncated script, which fails as a syntax error at
            // whatever line the truncation happened to land on.
            const tmp = out + '.tmp';
            fs.writeFileSync(tmp, text);
            fs.renameSync(tmp, out);
            console.log('built ' + rel + ': ' + included.length + ' fragments, ' +
                Buffer.byteLength(text) + ' bytes, ' + text.split('\n').length + ' lines' +
                '  [' + target.modules.join(' ') + ']');
        }
    }
    if (check) {
        if (bad) { console.error('\n' + bad + ' artifact(s) stale: run `node build.mjs`'); process.exit(1); }
        console.log('\nevery artifact is up to date');
    }
}

main();
