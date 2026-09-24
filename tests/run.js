#!/usr/bin/env node
'use strict';
// Runs the hermetic tests in their own processes and summarises the result.
// Pass a substring to narrow the set: `node tests/run.js lane`.
// The live bridge benchmark is opt-in: BWDD_RUN_BRIDGE_E2E=1 npm test
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const filter = process.argv.slice(2);
const runBridgeE2E = process.env.BWDD_RUN_BRIDGE_E2E === '1';
const files = fs.readdirSync(__dirname)
    .filter(f => /^test_.*\.js$/.test(f))
    .filter(f => runBridgeE2E || f !== 'test_bridge_e2e.js')
    .filter(f => !filter.length || filter.some(x => f.includes(x)))
    .sort();

if (!files.length) {
    console.error('No matching test files.');
    process.exit(1);
}

let failed = 0;
for (const f of files) {
    const r = spawnSync(process.execPath, [path.join(__dirname, f)],
        { encoding: 'utf8', timeout: 900000 });
    const out = (r.stdout || '') + (r.stderr || '');
    const ok = r.status === 0 && /ALL \d+ CHECKS PASSED/.test(out);
    const line = out.split('\n').find(l => /^(ALL \d+ CHECKS PASSED|\d+ FAILED)/.test(l.trim())) || '';
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${f}${line ? '  \u2014 ' + line.trim() : ''}`);
    if (!ok) {
        out.split('\n').filter(l => /FAIL|FATAL|Error:/.test(l)).slice(0, 12)
            .forEach(l => console.log('        ' + l.trim()));
    }
}
console.log(`\n${files.length - failed}/${files.length} test files passed`);
process.exit(failed ? 1 : 0);
