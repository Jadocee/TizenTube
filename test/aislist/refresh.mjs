// aisList.ts's fetch-and-cache path, driven with a fake fetch and a fake clock.
//
// Three separate defects lived in this function and none of them was reachable
// from the parser harness next door, because they are all about WHEN a fetch
// happens and WHAT survives a failure -- questions whose answers are invisible
// from parseList's return value. Each check below fails against the code as it
// was written:
//
//   * a warnlist failure discarded the blocklist that had just been downloaded,
//     so it was never cached and was re-downloaded and re-discarded on every
//     launch, forever
//   * one shared fetchedAt gated both lists, so enabling the warnlist inside the
//     blocklist's 12-hour window fetched nothing at all
//   * ...and a warnlist cached months ago was then used as if it were current
//
// Date.now and fetch are replaced rather than stubbed inside the module: the
// module under test is the shipping one, lifted verbatim by test/refresh.mjs
// with only its two imports repointed.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checker } from '../lib/repo.mjs';
import { store } from './stub.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = readFileSync(join(here, 'sample.txt'), 'utf8');

// --- the fakes --------------------------------------------------------------
let now = 1_000_000_000_000;
const realNow = Date.now;
Date.now = () => now;

const storage = new Map();
let storageThrows = false;
globalThis.window = {
    localStorage: {
        getItem: (k) => (storage.has(k) ? storage.get(k) : null),
        setItem: (k, v) => {
            if (storageThrows) throw new Error('QuotaExceededError');
            storage.set(k, v);
        },
    },
};

let requests = [];
let responder = () => ({ status: 200, body: SAMPLE, etag: '"v1"' });
globalThis.fetch = async (url, init) => {
    requests.push({ url, headers: (init && init.headers) || {} });
    const r = responder(url, requests.length);
    if (r.throws) throw new Error(r.throws);
    return {
        status: r.status,
        ok: r.status >= 200 && r.status < 300,
        headers: { get: (h) => (h.toLowerCase() === 'etag' ? r.etag || null : null) },
        text: async () => r.body,
    };
};

// Imported AFTER the fakes: the module captures JSON.parse and reads nothing
// else at import time, but window has to exist before readStore is ever called.
const { refresh, isAiChannel, aisListStatus, SOURCES } = await import('./mod.generated.mts');

const { check, done } = checker();
const reset = () => {
    requests = [];
    storage.clear();
    storageThrows = false;
};
const urls = () => requests.map((r) => r.url);
const blockCount = () => aisListStatus().block;

// --- the ordinary case ------------------------------------------------------
reset();
store.enableAiSList = true;
store.aisListIncludeWarnlist = false;
await refresh();
check('the blocklist is fetched', urls(), [SOURCES.block]);
check('  ...and cached', storage.has('tizentube.aislist'), true);
// The stored line is "@LangweiligeW%C3%A4hrung"; a tile carries the decoded
// form. That both sides are normalised is what makes 473 of the real list's
// entries matchable at all, and this is the only check that proves it survives
// the whole fetch-serialise-cache-deserialise round trip.
check(
    '  ...and matches a decoded handle',
    isAiChannel({ handle: '@LangweiligeW\u00e4hrung' }),
    true,
);

// A second call inside the TTL does nothing.
requests = [];
await refresh();
check('a second call inside the TTL fetches nothing', urls().length, 0);

// --- a warnlist failure must not cost the blocklist -------------------------
// This is the one that was permanent: with the warnlist on and its URL broken,
// the blocklist was downloaded and thrown away on every single launch.
reset();
store.aisListIncludeWarnlist = true;
responder = (url) =>
    url === SOURCES.warn
        ? { status: 404, body: 'Not Found' }
        : { status: 200, body: SAMPLE, etag: '"v1"' };
await refresh();
check('both lists are attempted', urls().length, 2);
check('the blocklist survives a warnlist 404', storage.has('tizentube.aislist'), true);
const afterFail = JSON.parse(storage.get('tizentube.aislist'));
check('  ...and its body was stored', typeof afterFail.block, 'string');
check('  ...with its own etag', afterFail.etags[SOURCES.block], '"v1"');
check('  ...and the failed source got no timestamp', afterFail.at[SOURCES.warn] ?? null, null);
check(
    '  ...so a hidden channel matches on the next launch',
    isAiChannel({ handle: '@LangweiligeW\u00e4hrung' }),
    true,
);

// A network throw, not just a bad status.
reset();
responder = (url) =>
    url === SOURCES.warn ? { throws: 'ENOTFOUND' } : { status: 200, body: SAMPLE, etag: '"v1"' };
await refresh();
check('the blocklist survives a warnlist throw', storage.has('tizentube.aislist'), true);
check('  ...and refresh still resolves', true, true);

// --- enabling the warnlist inside the blocklist's window --------------------
// The shared timestamp made this a no-op: age was under the TTL and the
// blocklist was populated, so the function returned before the warnlist branch.
reset();
store.aisListIncludeWarnlist = false;
responder = () => ({ status: 200, body: SAMPLE, etag: '"v1"' });
await refresh();
check('a warnlist-off run fetches one list', urls(), [SOURCES.block]);

now += 60 * 60 * 1000; // one hour: well inside the 12-hour TTL
store.aisListIncludeWarnlist = true;
requests = [];
await refresh();
check('turning the warnlist on fetches it inside the block TTL', urls(), [SOURCES.warn]);
check('  ...and only it', urls().length, 1);

// ...and once it is fetched, it is not fetched again.
requests = [];
await refresh();
check('and then stops fetching it', urls().length, 0);

// --- a stale warnlist is revalidated ----------------------------------------
now += 13 * 60 * 60 * 1000; // past the TTL for both
requests = [];
await refresh();
check('both are revalidated once stale', urls().sort(), [SOURCES.block, SOURCES.warn].sort());
check('  ...conditionally', Object.keys(requests[0].headers), ['If-None-Match']);

// --- a 304 keeps what is cached ---------------------------------------------
reset();
store.aisListIncludeWarnlist = false;
await refresh();
const before = blockCount();
now += 13 * 60 * 60 * 1000;
responder = () => ({ status: 304, body: '' });
requests = [];
await refresh();
check('a 304 is not re-parsed', blockCount(), before);
check(
    '  ...and still moves the timestamp',
    JSON.parse(storage.get('tizentube.aislist')).at[SOURCES.block],
    now,
);
requests = [];
await refresh();
check('  ...so the next call is inside the TTL again', urls().length, 0);

// --- failures that must not empty a working index ---------------------------
reset();
await refresh();
const good = blockCount();
now += 13 * 60 * 60 * 1000;
for (const bad of [
    { status: 500, body: 'oops' },
    { status: 200, body: '<!DOCTYPE html><h1>404</h1>' },
    { throws: 'network down' },
]) {
    responder = () => bad;
    await refresh();
}
check('a working index survives every kind of failure', blockCount() >= 1, true);
// The HTML case above is the one that matters most and the one that reads least
// like a failure: a captive portal answers 200 for every URL, so nothing in the
// response says anything went wrong.
check('  ...including a 200 that is a login page', blockCount(), good);
check(
    '  ...and does not cache the emptiness',
    JSON.parse(storage.get('tizentube.aislist')).at[SOURCES.block] < now,
    true,
);

// A 200 that parses to nothing is the one case that legitimately empties it --
// an upstream that publishes an empty list has published an empty list.
responder = () => ({ status: 200, body: '! Last Modified: 2026-08-01\n', etag: '"empty"' });
await refresh();
check('an empty published list empties the index', blockCount(), 0);

// --- storage that refuses -----------------------------------------------------
reset();
responder = () => ({ status: 200, body: SAMPLE, etag: '"v1"' });
storageThrows = true;
await refresh();
check('a failed write does not throw', true, true);
check(
    '  ...and the list still works this session',
    isAiChannel({ handle: '@LangweiligeW\u00e4hrung' }),
    true,
);

// --- the master switch --------------------------------------------------------
reset();
store.enableAiSList = false;
await refresh();
check('a disabled feature fetches nothing', urls().length, 0);
check('  ...and matches nothing', isAiChannel({ handle: '@LangweiligeW\u00e4hrung' }), false);

Date.now = realNow;
done();
