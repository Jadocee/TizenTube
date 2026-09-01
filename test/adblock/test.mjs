import { readFileSync } from 'fs';
const BLOCK = readFileSync(new URL('./block.generated.js', import.meta.url), 'utf8');

const nativeParse = JSON.parse,
    nativeStringify = JSON.stringify;
let fail = 0;
const check = (d, got, want) => {
    const ok = got === want;
    if (!ok) fail++;
    console.log(
        `${ok ? '  ok  ' : 'FAIL  '}${d.padEnd(58)} ${JSON.stringify(got)}${ok ? '' : '  want ' + JSON.stringify(want)}`,
    );
};

// TizenTube's wrapper, as adblock.js installs it.
function installWrappers() {
    const ourParse = function () {
        return nativeParse.apply(this, arguments);
    };
    const ourStringify = function () {
        return nativeStringify.apply(this, arguments);
    };
    ourParse.__tt = true;
    ourStringify.__tt = true;
    JSON.parse = ourParse;
    JSON.stringify = ourStringify;
}

// A YouTube module that captured the native JSON before we ran — the losing
// side of the race, and the whole reason this loop exists.
const yttvModule = () => ({ JSON: { parse: nativeParse, stringify: nativeStringify } });

function run(scenario) {
    return new Promise((resolve) => {
        JSON.parse = nativeParse;
        JSON.stringify = nativeStringify;
        installWrappers();
        globalThis.window = {};
        scenario();
        // eslint-disable-next-line no-eval
        (0, eval)(BLOCK);
        setTimeout(() => resolve(), 2000);
    });
}

console.log('The registry does not exist when the userscript runs (proven by every');
console.log('other feature in the mod polling for it):\n');

// 1. _yttv never appears at all.
await run(() => {});
check('no registry ever: does not throw', true, true);

// 2. _yttv appears 600ms in, holding a module that captured the native parse.
let late;
await run(() => {
    setTimeout(() => {
        late = yttvModule();
        globalThis.window._yttv = { a: late };
    }, 600);
});
check('registry appears late: module parse is patched', late.JSON.parse.__tt === true, true);
check(
    'registry appears late: module stringify is patched',
    late.JSON.stringify.__tt === true,
    true,
);

// 3. A module created much later (a surface opened after boot).
let later;
await run(() => {
    globalThis.window._yttv = { a: yttvModule() };
    setTimeout(() => {
        later = yttvModule();
        globalThis.window._yttv.b = later;
    }, 1200);
});
check('module created after boot is patched too', later.JSON.parse.__tt === true, true);

// 4. We won the race: modules already hold our wrapper. Must be left alone.
let winner;
await run(() => {
    winner = { JSON: { parse: JSON.parse, stringify: JSON.stringify } };
    globalThis.window._yttv = { a: winner };
});
check('already-correct module untouched', winner.JSON.parse.__tt === true, true);

// 5. A frozen module must not abort the pass that follows it.
let after;
await run(() => {
    const frozen = Object.freeze({
        JSON: Object.freeze({ parse: nativeParse, stringify: nativeStringify }),
    });
    after = yttvModule();
    globalThis.window._yttv = { a: frozen, b: after };
});
check('a frozen module does not stop the rest', after.JSON.parse.__tt === true, true);

// 6. Entries that are null or carry no JSON must be skipped.
let ok6;
await run(() => {
    ok6 = yttvModule();
    globalThis.window._yttv = { a: null, b: undefined, c: {}, d: { JSON: null }, e: ok6 };
});
check('null / JSON-less entries skipped', ok6.JSON.parse.__tt === true, true);

JSON.parse = nativeParse;
JSON.stringify = nativeStringify;
console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS');
process.exit(fail ? 1 : 0);
