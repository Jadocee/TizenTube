// Every continuation shape the app can send, and what the mod does with it.
//
// THE BUG THIS EXISTS FOR. adblock.ts routed three continuation shapes into
// processShelves and silently ignored a fourth. The missing one was
// `tvSurfaceContentContinuation` -- the home surface's own refresh. The app
// reads it as `_.B(d.continuationContents, tvSurfaceContentContinuation)` and,
// on an `isImplicitRefresh` reply, splices the new sectionList's contents into
// the shelves already on screen. Every shelf arriving that way skipped
// hideVideo, the inline previews, the long-press menu, DeArrow and the
// compact-shelf flag.
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
    /continuationContents\?\.tvSurfaceContentContinuation\?\.content\?\.sectionListRenderer/.test(
        code,
    ),
    true,
);

done();
