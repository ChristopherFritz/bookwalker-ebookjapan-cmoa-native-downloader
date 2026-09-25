// Check the shipped naming and ZIP code without requiring a browser. Filename
// order matters after extraction and in readers that sort ZIP names themselves.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const fragment = file => fs.readFileSync(path.join(root, 'src', file), 'utf8');
const context = vm.createContext({
  URLSearchParams, TextEncoder, Blob, setTimeout,
  location: { search: '?cid=book-1' },
  isHeadlessPage: () => true,
  IMAGE_CODEC: { ext: 'jpg' },
});
vm.runInContext(
  fragment('sites/bookwalker/00-state.js') +
  fragment('core/40-naming.js') +
  fragment('core/41-zip.js') +
  '\nglobalThis.api = { bookWalkerPageName, rememberResumeData, buildStoreZip };',
  context
);
const { bookWalkerPageName, rememberResumeData, buildStoreZip } = context.api;
const results = [];
function check(name, pass, detail) {
  results.push(pass);
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + ' — ' + detail);
}

(async () => {
  const names = Array.from({ length: 12 }, (_, i) =>
    bookWalkerPageName(i + 1, 'OEBPS/text/p-' + String(i + 1).padStart(4, '0') + '.xhtml'));
  check('BookWalker names retain the source stem and padded page number',
    names[0] === '0001 p-0001.jpg' && names[9] === '0010 p-0010.jpg',
    names[0] + ', ' + names[9]);
  check('double-digit pages remain in filename order',
    names.slice().sort().join('|') === names.join('|'), names.slice().sort().join(', '));

  rememberResumeData('/NFBR.a6iMark/NFBR.ResumeData/book-1/1',
    JSON.stringify({ page: 9, url: 'OEBPS/text/special.xhtml' }));
  check('a captured resume name overrides the manifest stem for its page',
    bookWalkerPageName(10, 'OEBPS/text/p-0010.xhtml') === '0010 special.jpg',
    bookWalkerPageName(10, 'OEBPS/text/p-0010.xhtml'));

  const blob = new Blob(['page'], { type: 'image/jpeg' });
  const zip = await buildStoreZip(names.slice().reverse().map(name => ({ path: name, blob })));
  const bytes = new Uint8Array(await zip.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const decoder = new TextDecoder();
  const zipNames = [];
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    zipNames.push(decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength)));
    offset += 30 + nameLength + extraLength + view.getUint32(offset + 18, true);
  }
  check('ZIP entries are in page order even when submitted in reverse',
    zipNames.join('|') === names.join('|'), zipNames.join(', '));

  const failed = results.filter(pass => !pass).length;
  console.log(failed ? '\n' + failed + ' FAILED' : '\nALL ' + results.length + ' CHECKS PASSED');
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error('FATAL', error); process.exitCode = 1; });
