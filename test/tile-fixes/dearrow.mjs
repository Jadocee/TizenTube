// The DeArrow request cache, driven with a counting fake fetch.
//
// The behaviour under test is "how many requests actually left the machine",
// which is not visible from the outside of the module and not assertable from
// its return values. deArrowify() previously called fetch() once per tile with
// no cache and no de-duplication: a first home screen is on the order of a
// hundred and fifty outbound requests fired at once on a television SoC, again
// for every continuation as you scroll, and twice over for a video that appears
// on two shelves.
import { checker } from '../lib/repo.mjs';
import {
    fetchBranding,
    resetBrandingCache,
    brandingCacheSize,
    bestTitle,
    bestThumbnailTime,
    CACHE_LIMIT,
} from './dearrowCache.generated.mts';

const { check, done } = checker();

let requests = [];
function stubFetch(body, { ok = true, reject = false } = {}) {
    globalThis.fetch = (url) => {
        requests.push(url);
        if (reject) return Promise.reject(new Error('network'));
        return Promise.resolve({ ok, json: () => Promise.resolve(body) });
    };
}

const BRANDING = {
    titles: [
        { title: 'quiet', votes: 1 },
        { title: 'loudest', votes: 9 },
        { title: 'middle', votes: 4 },
    ],
    thumbnails: [
        { timestamp: 12.5, votes: 3 },
        { timestamp: 60, votes: 8 },
    ],
};

// --- one request per video, not per tile ------------------------------------
resetBrandingCache();
requests = [];
stubFetch(BRANDING);
// Thirty tiles carrying ten distinct ids, which is what a shelf with repeats
// across sections actually looks like.
const ids = Array.from({ length: 30 }, (_, i) => `vid${i % 10}`);
await Promise.all(ids.map((id) => fetchBranding(id)));
check('30 tiles over 10 videos make 10 requests', requests.length, 10);

// The same promise object, not merely an equal value: twenty tiles asking at
// once must share one in-flight request rather than starting twenty.
check(
    'a repeated id returns the identical promise',
    fetchBranding('vid0') === fetchBranding('vid0'),
    true,
);

// --- the URL --------------------------------------------------------------
check(
    'asks the branding endpoint',
    /sponsor\.ajay\.app\/api\/branding\?videoID=vid0$/.test(requests[0]),
    true,
);
resetBrandingCache();
requests = [];
await fetchBranding('a b&c=d');
check('an id with url metacharacters is encoded', /videoID=a%20b%26c%3Dd$/.test(requests[0]), true);

// --- failures are not cached ------------------------------------------------
// A transient failure on the first shelf must not poison every later one.
resetBrandingCache();
requests = [];
stubFetch(null, { reject: true });
check(
    'a rejected request resolves to null rather than throwing',
    await fetchBranding('vidX'),
    null,
);
stubFetch(BRANDING);
await fetchBranding('vidX');
check('  ...and is evicted, so a later shelf retries', requests.length, 2);

// A 404 is the NORMAL answer for a video nobody has submitted branding for.
// The old code called res.json() on it and read `.titles.length` off the
// result, so the throw landed in a catch that could not tell it from a network
// failure.
resetBrandingCache();
requests = [];
stubFetch(null, { ok: false });
check('a 404 resolves to null without reading the body', await fetchBranding('vidY'), null);

// --- bounded ----------------------------------------------------------------
resetBrandingCache();
stubFetch(BRANDING);
for (let i = 0; i < CACHE_LIMIT + 50; i++) await fetchBranding(`bulk${i}`);
check('the cache stays at its limit', brandingCacheSize() <= CACHE_LIMIT, true);
// Insertion order eviction: the oldest key goes first, so a long session cannot
// grow without bound and the videos on screen now are the ones remembered.
requests = [];
await fetchBranding('bulk0');
check('  ...and the oldest entry is the one evicted', requests.length, 1);

// --- no id, no request ------------------------------------------------------
resetBrandingCache();
requests = [];
check('an empty id resolves to null', await fetchBranding(''), null);
check('a null id resolves to null', await fetchBranding(null), null);
check('a non-string id resolves to null', await fetchBranding(42), null);
check('  ...and none of them made a request', requests.length, 0);

// --- with no fetch at all ---------------------------------------------------
const savedFetch = globalThis.fetch;
delete globalThis.fetch;
resetBrandingCache();
check(
    'an engine with no fetch resolves to null rather than throwing',
    await fetchBranding('vid0'),
    null,
);
globalThis.fetch = savedFetch;

// --- picking a winner -------------------------------------------------------
check('the best-voted title wins', bestTitle(BRANDING), 'loudest');
check('no titles yields null', bestTitle({ titles: [] }), null);
check('absent titles yields null', bestTitle({}), null);
check('null yields null', bestTitle(null), null);
check('an entry with no title string is skipped', bestTitle({ titles: [{ votes: 99 }] }), null);

check('the best-voted thumbnail time wins', bestThumbnailTime(BRANDING), 60);
check('no thumbnails yields null', bestThumbnailTime({ thumbnails: [] }), null);
check('null yields null', bestThumbnailTime(null), null);
// An entry can win the vote and still carry no timestamp -- the original code
// read `.timestamp` off the winner and produced undefined in a URL.
check(
    'a winner with no timestamp yields null',
    bestThumbnailTime({ thumbnails: [{ votes: 99 }, { timestamp: 5, votes: 1 }] }),
    null,
);

done();
