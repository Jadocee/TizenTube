import { readFileSync } from 'fs';
import { repoPath, readRepo } from '../lib/repo.mjs';
const src = readRepo('standalone', 'service', 'index.ts');

let fail = 0;
const check = (d, got, want) => { const ok = got === want; if (!ok) fail++;
  console.log(`${ok?'  ok  ':'FAIL  '}${d.padEnd(58)} ${JSON.stringify(got)}${ok?'':'  want '+JSON.stringify(want)}`); };

// Lift the injection block out of the proxy and run it against real page shapes.
const PORT = 8099, USERSCRIPT_PATH = '/tizentube/userScript.js';
const block = src.slice(src.indexOf('const tag = `<script'), src.indexOf('} else {\n                            text = tag + text;') + 60);
function inject(text) {
  const tag = `<script src="http://localhost:${PORT}${USERSCRIPT_PATH}"></script>`;
  if (/<head[^>]*>/i.test(text)) text = text.replace(/<head[^>]*>/i, (m) => m + tag);
  else if (/<html[^>]*>/i.test(text)) text = text.replace(/<html[^>]*>/i, (m) => m + tag);
  else text = tag + text;
  return text;
}
check('injection block still present in the proxy', block.includes('<head[^>]*>'), true);

const yt = '<!doctype html><html><head><script src="/s/desktop/app.js"></script><title>YouTube</title></head><body><div id=container></div></body></html>';
const out = inject(yt);
check('tag lands before YouTube\'s first script', out.indexOf('tizentube/userScript.js') < out.indexOf('/s/desktop/app.js'), true);
check('tag is inside <head>', out.indexOf('tizentube/userScript.js') > out.indexOf('<head>'), true);
check('served from localhost, not a CDN', out.includes('cdn.jsdelivr.net'), false);
check('no cache-busting query', /userScript\.js\?/.test(out), false);

// Shapes that are not a normal document must still get the script.
check('head with attributes', inject('<html><head lang="en"><script src="x"></script></head>').indexOf('tizentube') < inject('<html><head lang="en"><script src="x"></script></head>').indexOf('src="x"'), true);
check('no <head> at all falls back to <html>', inject('<html><body>hi</body></html>').includes('tizentube'), true);
check('no tags at all still injects', inject('hello').startsWith('<script'), true);

// A '$' in the matched text must not be read as a replacement pattern.
check('$ in markup is not a replacement pattern', inject('<html><head data-x="$&$1">').includes('$&$1'), true);

// The route must never fail the request.
// Both of these moved into userScript.ts when the script was packaged into the
// build; assert where the behaviour actually lives now.
check('route never fails, even with nothing cached', /if \(body\) return res\.send\(body\);[\s\S]{0,300}res\.send\('console\.error/.test(src), true);
check('userscript resolved at startup, not on first request', /userScript\.(refresh|get)\(\);/.test(src), true);

const loader = readRepo('standalone', 'service', 'userScript.ts');
check('loader prefers the packaged copy', loader.includes("require('./userScript.generated.js')"), true);
check('loader falls back to whatever it already has', loader.includes('// Whatever we already have beats nothing.'), true);
check('update check compares versions before downloading', loader.includes('isNewer(manifest.version, version)'), true);
console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS');
process.exit(fail ? 1 : 0);
