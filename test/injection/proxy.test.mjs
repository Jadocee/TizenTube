// Where the proxy puts the userscript tag, and on which requests.
//
// This harness used to carry its own copy of the injection logic and assert
// against that copy. Eight of its assertions therefore proved only that the
// harness agreed with itself: moving the real tag back to the end of the
// document -- the exact regression the comment in index.ts warns about, where
// the mod loads after every one of YouTube's own scripts and JSON.parse has
// already been captured -- left it printing ALL PASS.
//
// It now runs the real block, lifted out of standalone/service/index.ts by
// test/refresh.mjs on every run, so a change to the proxy shows up here.
import { readRepo } from '../lib/repo.mjs';
import { injectUserScript } from './inject.generated.mjs';

const src = readRepo('standalone', 'service', 'index.ts');

let fail = 0;
const check = (d, got, want) => { const ok = got === want; if (!ok) fail++;
  console.log(`${ok?'  ok  ':'FAIL  '}${d.padEnd(58)} ${JSON.stringify(got)}${ok?'':'  want '+JSON.stringify(want)}`); };

const PORT = 8099, USERSCRIPT_PATH = '/tizentube/userScript.js';
const TV = { url: '/tv?foo=1' };
const inject = (text, req = TV) => injectUserScript(text, req, PORT, USERSCRIPT_PATH);

// --- position: the whole point of the block ---------------------------------
const yt = '<!doctype html><html><head><script src="/s/desktop/app.js"></script><title>YouTube</title></head><body><div id=container></div></body></html>';
const out = inject(yt);
check('tag lands before YouTube\'s first script', out.indexOf('tizentube/userScript.js') < out.indexOf('/s/desktop/app.js'), true);
check('tag is inside <head>', out.indexOf('tizentube/userScript.js') > out.indexOf('<head>'), true);
check('served from localhost, not a CDN', out.includes('cdn.jsdelivr.net'), false);
check('no cache-busting query', /userScript\.js\?/.test(out), false);
check('the document is otherwise untouched', out.replace(/<script src="http:\/\/localhost:8099\/tizentube\/userScript\.js"><\/script>/, ''), yt);

// --- which requests get it --------------------------------------------------
// The gate was never covered: injecting on the wrong responses, or failing to
// inject on /tv, is as broken as injecting in the wrong place.
check('/tv is injected', inject(yt, { url: '/tv' }).includes('tizentube'), true);
check('/tv with a query is injected', inject(yt, { url: '/tv?bar=2' }).includes('tizentube'), true);
check('/tv_config is left alone', inject(yt, { url: '/tv_config' }).includes('tizentube'), false);
check('another path is left alone', inject(yt, { url: '/watch' }).includes('tizentube'), false);
check('/tv further down the path is left alone', inject(yt, { url: '/foo/tv' }).includes('tizentube'), false);

// --- shapes that are not a normal document ----------------------------------
const withAttrs = inject('<html><head lang="en"><script src="x"></script></head>');
check('head with attributes', withAttrs.indexOf('tizentube') < withAttrs.indexOf('src="x"'), true);
check('uppercase HEAD still matches', inject('<HTML><HEAD><script src="x"></script>').includes('tizentube'), true);
check('no <head> at all falls back to <html>', inject('<html><body>hi</body></html>').includes('tizentube'), true);
check('no tags at all still injects', inject('hello').startsWith('<script'), true);

// A '$' in the matched text must not be read as a replacement pattern. This is
// the trap styleSheet.ts documents too: String.replace reads $& and $1 in the
// replacement, which is why the real code uses a function.
check('$ in markup is not a replacement pattern', inject('<html><head data-x="$&$1">').includes('$&$1'), true);

// --- the route must never fail the request ----------------------------------
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
