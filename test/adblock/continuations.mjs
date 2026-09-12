// Every continuation shape the app can send, and what the mod does with it.
//
// THE BUG THIS EXISTS FOR. adblock.ts handled three continuation shapes and
// silently ignored a fourth. (An earlier version of this comment said all three
// went "into processShelves"; only sectionListContinuation did. The other two
// are item lists and run the per-item passes directly -- which is the
// distinction the SHELVES/ITEMS split below exists to hold.) The missing one was
// `tvSurfaceContentContinuation` -- the home surface's own refresh. The app
// reads it as `_.B(d.continuationContents, tvSurfaceContentContinuation)` and,
// on an `isImplicitRefresh` reply, splices the new sectionList's contents into
// the shelves already on screen. Every shelf arriving that way skipped
// hideVideo, the inline previews, the long-press menu and DeArrow.
//
// It was invisible for a reason worth writing down: ads were still stripped,
// because AD_RULES prunes the whole payload regardless of shape. The one
// feature whose absence anyone would have noticed was the one feature that kept
// working.
//
// So this asserts the GENERAL form rather than the one shape: every
// continuation the app names must be either routed or explicitly declined with
// a reason. Forgetting one becomes a failure instead of a silence.
import { readRepo, checker } from '../lib/repo.mjs';

const { check, done } = checker();

const { names } = JSON.parse(readRepo('test', 'adblock', 'continuations.json'));
const src = readRepo('mods', 'features', 'adblock.ts');
// Comments are stripped: the file explains each of these immediately above
// handling it, and prose must not count as handling.
const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

/**
 * Continuations that carry no shelves or tiles, with why.
 *
 * These are continuation TOKENS and request wrappers rather than content
 * envelopes -- the app sends them to ask for more, not to deliver it -- so there
 * is nothing for processShelves to walk. Listed explicitly so that "not handled"
 * is a decision on the record rather than an omission nobody noticed.
 */
const NO_CONTENT = {
    reloadContinuation: 'a token the app sends to request a refresh, not a reply carrying one',
    nextContinuation: 'likewise a request token',
    genericPromoContinuation: 'a promo slot the ad rules prune wholesale; it carries no tiles',
    itemSectionContinuation:
        'a web-surface shape; the TV app registers it but never renders tiles through it',
};

check('the app names continuations to account for', names.length > 3, true);

const unaccounted = [];
for (const name of names) {
    const handled = code.includes(name);
    const declined = Object.hasOwn(NO_CONTENT, name);
    // Exactly one of the two. Something both handled and declined means the
    // list has gone stale in the other direction.
    if (handled && declined) unaccounted.push(`${name} (handled AND declined)`);
    else if (!handled && !declined) unaccounted.push(`${name} (neither)`);
}
check('every continuation is routed or explicitly declined', unaccounted, []);

/**
 * What each content-carrying continuation actually holds.
 *
 * A SHELF list goes through processShelves, which walks shelves and calls the
 * per-item passes inside each one. An ITEM list is already the tiles, so it runs
 * those passes directly -- routing it through processShelves would look for a
 * shelfRenderer that is not there and do nothing at all.
 *
 * The first draft of this harness asserted processShelves for both and failed
 * on the two item lists, which is the check working: it was wrong, not the code.
 */
const SHELVES = ['sectionListContinuation', 'tvSurfaceContentContinuation'];
const ITEMS = ['horizontalListContinuation', 'gridContinuation'];

check(
    'every content continuation is classified',
    names.filter(
        (n) => !Object.hasOwn(NO_CONTENT, n) && !SHELVES.includes(n) && !ITEMS.includes(n),
    ),
    [],
);

for (const name of SHELVES) {
    const at = code.indexOf(name);
    const after = at >= 0 ? code.slice(at, at + 700) : '';
    check(`${name} is walked as shelves`, /processShelves\(/.test(after), true);
}

// An item list has to reach the passes a tile needs. hideVideo and addPreviews
// are the two that are most visibly absent when a continuation is missed -- a
// watched video that will not hide, and a tile that will not preview.
for (const name of ITEMS) {
    const at = code.indexOf(name);
    const after = at >= 0 ? code.slice(at, at + 1400) : '';
    check(`${name} runs the per-item passes`, /hideVideo\(/.test(after), true);
    check('  ...including previews', /addPreviews\(/.test(after), true);
}

// And the one that was missed, named outright, so a future edit that drops it
// fails by name rather than by count.
check(
    'the home refresh is routed by its real path',
    /tvSurfaceContentContinuation\?\.content/.test(code),
    true,
);

// --- the routes have to WORK, not merely be written -------------------------
// Everything above is name-level: it reads adblock.ts as text. That catches a
// route being deleted and it cannot catch a route being INERT, which is the
// failure mode this whole harness exists for. Demonstrated, not assumed --
// change the home route to hand over the renderer instead of its `.contents`:
//
//     processShelves(...tvSurfaceContentContinuation.content.sectionListRenderer)
//
// processShelves then runs `for (let i = shelves.length - 1; i >= 0; i--)` on an
// object, `undefined - 1` is NaN, the loop body never runs, nothing throws, and
// the full suite reported 51 passed / 0 failed with every assertion above green.
// A one-token slip in a five-segment chained path put the original bug back and
// the harness written for that bug said nothing.
//
// So: pull the expression each route actually passes out of the source and
// EVALUATE it against a real response envelope. A list that is not a list, or a
// path that resolves to undefined, fails here whatever the source text says.
const { payloads } = JSON.parse(readRepo('test', 'adblock', 'continuations.json'));

/** The argument text of the first `fn(` call after `from`, brace-matched. */
function argumentOf(fn, from) {
    const at = code.indexOf(`${fn}(`, from);
    if (at < 0) return null;
    const open = at + fn.length;
    let depth = 0;
    for (let i = open; i < code.length; i++) {
        if (code[i] === '(') depth++;
        // Biome wraps a long argument onto its own line and leaves a trailing
        // comma, which `new Function` will not parse -- so the first draft of
        // this returned undefined for every wrapped route and reported them all
        // as broken. Stripped here rather than in resolve(), so what is returned
        // is always something evaluable.
        else if (code[i] === ')' && --depth === 0)
            return code
                .slice(open + 1, i)
                .trim()
                .replace(/,$/, '');
    }
    return null;
}

/** That expression's value on a real payload, with `r` bound to it. */
function resolve(expr, payload) {
    if (!expr) return undefined;
    try {
        return new Function('r', `return (${expr});`)(payload);
    } catch (_e) {
        return undefined;
    }
}

const ROUTES = [
    {
        label: 'section-list continuation',
        name: 'sectionListContinuation',
        call: 'processShelves',
        key: 'sectionListContinuation',
        kind: 'shelves',
        guard: 'r?.continuationContents?.sectionListContinuation?.contents',
    },
    {
        label: 'home refresh (sectionList)',
        name: 'tvSurfaceContentContinuation',
        call: 'processShelves',
        key: 'tvSurfaceContentContinuation',
        kind: 'shelves',
        guard: 'r?.continuationContents?.tvSurfaceContentContinuation?.content?.sectionListRenderer?.contents',
    },
    {
        label: 'home refresh (grid)',
        name: 'tvSurfaceContentContinuation',
        call: 'addPreviews',
        key: 'tvSurfaceContentContinuation.grid',
        kind: 'items',
        guard: 'r?.continuationContents?.tvSurfaceContentContinuation?.content?.gridRenderer?.items',
    },
    {
        label: 'horizontal-list continuation',
        name: 'horizontalListContinuation',
        call: 'addPreviews',
        key: 'horizontalListContinuation',
        kind: 'items',
        guard: 'r?.continuationContents?.horizontalListContinuation?.items',
    },
    {
        label: 'grid continuation',
        name: 'gridContinuation',
        call: 'addPreviews',
        key: 'gridContinuation',
        kind: 'items',
        guard: 'r?.continuationContents?.gridContinuation?.items',
    },
];

for (const route of ROUTES) {
    const payload = payloads[route.key];
    // The GUARD as well as the call. Evaluating only the call expression leaves
    // a hole: a block whose `if` was narrowed to something the payload never
    // satisfies is dead code whose call text still reads correctly, and every
    // assertion below would stay green. Both have to resolve on the same
    // envelope for the route to actually run.
    check(`${route.label}: its guard admits the payload`, !!resolve(route.guard, payload), true);
    // Whitespace-insensitive: the formatter wraps a long guard across lines and
    // indents the tail, so a literal includes() reports a guard that is there.
    check(
        '  ...and the source guards on exactly that',
        code.replace(/\s+/g, '').includes(route.guard.replace(/\s+/g, '')),
        true,
    );
    // A missing fixture would make every assertion below vacuously true.
    check(`${route.label}: has a payload to run against`, !!payload, true);

    const expr = argumentOf(route.call, code.indexOf(route.name));
    const value = resolve(expr, payload);
    check(`  ...${route.call} is handed a list`, Array.isArray(value), true);
    check('  ...that is not empty', Array.isArray(value) ? value.length : 0, 1);

    // And that it is the right KIND of list. A shelf list whose entries have no
    // shelfRenderer is what routing an item list through processShelves gives
    // you: it walks, finds nothing, and does nothing.
    const entry = Array.isArray(value) ? value[0] : null;
    check(
        route.kind === 'shelves' ? '  ...of shelves' : '  ...of tiles',
        !!(entry && (route.kind === 'shelves' ? entry.shelfRenderer : entry.tileRenderer)),
        true,
    );
}

done();
