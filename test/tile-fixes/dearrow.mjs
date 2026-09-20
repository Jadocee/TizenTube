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
    MAX_CONCURRENT,
    knownBranding,
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
    // Not a redundant comparison: the two calls return DIFFERENT objects unless
    // the cache is doing its job, which is the entire assertion -- identity, not
    // equality.
    // biome-ignore lint/suspicious/noSelfCompare: asserts promise identity
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
// An entry can win the vote and still carry no timestamp, and the runner-up is
// then the answer. The first version of this returned null instead, which is
// the whole defect below wearing a different hat: a usable timestamp is part of
// being a candidate at all, not a test applied to the winner.
check(
    'a top-voted entry with no timestamp does not win',
    bestThumbnailTime({ thumbnails: [{ votes: 99 }, { timestamp: 5, votes: 1 }] }),
    5,
);
check(
    '  ...and with no usable entry at all the answer is still null',
    bestThumbnailTime({ thumbnails: [{ votes: 99 }, { votes: 1 }] }),
    null,
);

// --- `original` is a vote FOR YouTube's own title, not a submission ---------
// THE DEFECT THIS SECTION EXISTS FOR. DeArrow lets people vote to KEEP the
// original title or thumbnail, and those votes come back in the same lists with
// `original: true`. The old selection was pure max-votes, so on a popular video
// it returned YouTube's own title and the mod wrote it back over itself --
// invisible, until a badge started claiming it was the community's work.
//
// Fixtures taken from the live API rather than invented: jNQXAC9IVRw's top
// entry is `{"title":"Me at the zoo","original":true,"votes":10,"locked":true}`.
check(
    'a vote for the original title is not a community title',
    bestTitle({
        titles: [
            { title: 'Me at the zoo', original: true, votes: 10, locked: true },
            { title: 'The first video on YouTube', votes: 3 },
        ],
    }),
    'The first video on YouTube',
);
check(
    '  ...and with nothing else, there is no community title',
    bestTitle({ titles: [{ title: 'Me at the zoo', original: true, votes: 10 }] }),
    null,
);

// The thumbnail half was worse: a vote for the original carries a null
// timestamp, so it won and then failed the finite check, and
// enableDeArrowThumbnails silently did nothing on exactly the popular videos
// anyone would notice. dQw4w9WgXcQ, live.
check(
    'a vote for the original thumbnail does not hide the community one',
    bestThumbnailTime({
        thumbnails: [
            { timestamp: null, original: true, votes: 9 },
            { timestamp: 3.92349, original: false, votes: 2, locked: true },
        ],
    }),
    3.92349,
);

// --- `locked` is a moderator's pin and outranks votes -----------------------
check(
    'a locked title beats a better-voted one',
    bestTitle({
        titles: [
            { title: 'loud but unpinned', votes: 500 },
            { title: 'pinned', votes: 1, locked: true },
        ],
    }),
    'pinned',
);
check(
    '  ...and two locked entries fall back to votes',
    bestTitle({
        titles: [
            { title: 'pinned quietly', votes: 1, locked: true },
            { title: 'pinned loudly', votes: 9, locked: true },
        ],
    }),
    'pinned loudly',
);
check(
    '  ...and a locked ORIGINAL is still not a community title',
    bestTitle({
        titles: [
            { title: "YouTube's own", votes: 99, locked: true, original: true },
            { title: 'the submission', votes: 1 },
        ],
    }),
    'the submission',
);

// --- a non-answer is not remembered as an answer ----------------------------
// A 404 means "nobody has submitted branding", which IS an answer and is kept so
// the same video is not asked about on every shelf. A 429 or a 5xx means "ask
// again later", and the old code could not tell them apart: `res.ok === false`
// returned null down the SUCCESS path and only the .catch evicted, so one
// rate-limited burst taught the mod that those videos had no titles for the rest
// of the session.
resetBrandingCache();
requests = [];
globalThis.fetch = (url) => {
    requests.push(url);
    return Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve(null) });
};
check('a rate-limited request resolves to null', await fetchBranding('vidRL'), null);
await fetchBranding('vidRL');
check('  ...and is retried rather than cached as "no title"', requests.length, 2);

resetBrandingCache();
requests = [];
globalThis.fetch = (url) => {
    requests.push(url);
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) });
};
check('a 404 resolves to null', await fetchBranding('vid404'), null);
await fetchBranding('vid404');
check('  ...and is NOT retried, because it is an answer', requests.length, 1);

// --- what is already known, without waiting ---------------------------------
// The call that makes the title appear at all. Applying branding from a .then()
// is applying it after the component drew the tile, and nothing redraws it.
resetBrandingCache();
stubFetch(BRANDING);
check('nothing is known before asking', knownBranding('vidK'), undefined);
await fetchBranding('vidK');
check('  ...and it is known once the answer arrives', bestTitle(knownBranding('vidK')), 'loudest');
check('an id nobody asked about is still unknown', knownBranding('vidNever'), undefined);
check('  ...and junk ids are unknown rather than throwing', knownBranding(42), undefined);

resetBrandingCache();
globalThis.fetch = () => Promise.resolve({ ok: false, status: 404, json: () => null });
await fetchBranding('vidNone');
// null, not undefined: "asked, and there is nothing" is a different answer from
// "nobody has asked", and only the second one is worth asking again.
check('a video with no branding is known to have none', knownBranding('vidNone'), null);

// --- the wire is not flooded ------------------------------------------------
// One captured channel payload carries 163 eligible tiles, and every one of them
// used to go out in the same synchronous pass.
resetBrandingCache();
let open = 0;
let peak = 0;
const release = [];
globalThis.fetch = () => {
    open++;
    peak = Math.max(peak, open);
    return new Promise((resolve) => {
        release.push(() => {
            open--;
            resolve({ ok: true, json: () => Promise.resolve(BRANDING) });
        });
    });
};
const many = [];
for (let i = 0; i < 163; i++) many.push(fetchBranding(`flood${i}`));
check('a shelf of 163 tiles does not open 163 requests', peak <= MAX_CONCURRENT, true);
check('  ...and the cap is a real number', MAX_CONCURRENT > 0 && MAX_CONCURRENT < 163, true);
// Drained, so every one of them still completes rather than being dropped.
while (release.length) {
    const next = release.shift();
    next();
    await Promise.resolve();
}
await Promise.all(many);
check('  ...and all of them are eventually answered', peak <= MAX_CONCURRENT, true);
globalThis.fetch = savedFetch;

done();
