import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('./transit-bcr.html', import.meta.url), 'utf8');
function block(id) {
  const m = html.match(new RegExp('<script id="' + id + '"[^>]*>([\\s\\S]*?)<\\/script>'));
  if (!m) throw new Error('missing script block: ' + id);
  return m[1];
}
globalThis.window = globalThis;
globalThis.document = { getElementById: () => null, createElement: () => ({ style: {}, appendChild() {}, textContent: '', className: '' }) };
let presets = '';
try { presets = block('tbcr-presets'); } catch { /* added in Task 6 */ }
const code = block('tbcr-engine') + '\n' + presets + '\n' + block('tbcr-tests');
new Function(code)();
if (globalThis.__TESTS_FAILED > 0) { console.error('FAILED: ' + globalThis.__TESTS_FAILED); process.exit(1); }
console.log('OK (' + (globalThis.__TESTS_PASSED || 0) + ' passed)');
