// Which sidebar entries get removed, against a real guide payload.
//
// guide.json is a genuine tvhtml5 /youtubei/v1/guide response (session fields
// stripped). It is the reason this harness exists: the previous filter walked
// only `items`, and the capture shows a guide keeps its entries in three places.
//
//   items    9  Search, Home, Subscriptions, Library, Music, Live, Gaming,
//               News, Sports
//   footer   1  Settings
//   topbar   1  Sign in
//
// It is signed out, so it has no Watch Later row -- that is an account-level
// entry. The Watch Later assertions therefore run against a synthesised entry,
// and the harness says so rather than pretending otherwise.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checker } from '../lib/repo.mjs';
import {
    filterGuide,
    shouldRemoveEntry,
    isWatchLaterEntry,
    isGuidePayload,
    WATCH_LATER_BROWSE_IDS,
} from './guideFilter.generated.mts';

const { check, done } = checker();
const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(join(HERE, 'guide.json'), 'utf8');
const fresh = () => JSON.parse(RAW);

const icons = (payload) => {
    const out = [];
    const walk = (o) => {
        if (Array.isArray(o)) return o.forEach(walk);
        if (o && typeof o === 'object') {
            if (o.guideEntryRenderer) out.push(o.guideEntryRenderer.icon?.iconType);
            Object.values(o).forEach(walk);
        }
    };
    walk(payload);
    return out;
};

// --- the capture itself -----------------------------------------------------
const original = fresh();
check('the fixture is recognised as a guide', isGuidePayload(original), true);
check('it carries eleven entries in total', icons(original).length, 11);
check('  ...nine of them in items', icons({ items: original.items }).length, 9);
// This is the gap the capture exposed. Filtering only `items` misses these.
check('  ...one in the footer', icons({ f: original.footer }), ['SETTINGS']);
check('  ...and one in the topbar', icons({ t: original.topbar }), ['SIGN_IN']);

// --- hiding by icon ---------------------------------------------------------
let payload = fresh();
check('nothing is removed with no options set', filterGuide(payload, {}), 0);
check('  ...and the payload is untouched', icons(payload).length, 11);

payload = fresh();
check(
    'two chosen icons are removed',
    filterGuide(payload, { disabledIcons: ['GAMING', 'NEWS'] }),
    2,
);
const left = icons(payload);
check('  ...exactly those two', left.includes('GAMING') || left.includes('NEWS'), false);
check('  ...and nothing else went with them', left.length, 9);
check('  ...home survives', left.includes('WHAT_TO_WATCH'), true);

// The topbar is deliberately never filtered: it is the account row, and an
// account row removed on a television cannot be got back without reinstalling.
payload = fresh();
check('the account row is never removed', filterGuide(payload, { disabledIcons: ['SIGN_IN'] }), 0);
check('  ...even though it is a guide entry', icons(payload).includes('SIGN_IN'), true);

// The footer IS filtered, which is what the old walk could not do.
payload = fresh();
check('a footer entry can be removed', filterGuide(payload, { disabledIcons: ['SETTINGS'] }), 1);
check('  ...and it is gone', icons(payload).includes('SETTINGS'), false);

// --- Watch Later ------------------------------------------------------------
// Synthesised: a signed-out guide has no Watch Later row, so its exact browseId
// could not be captured. Several forms are accepted for that reason, and each
// one is asserted so the list cannot silently rot down to nothing.
const watchLaterEntry = (browseId, icon) => ({
    guideEntryRenderer: {
        ...(browseId ? { navigationEndpoint: { browseEndpoint: { browseId } } } : {}),
        ...(icon ? { icon: { iconType: icon } } : {}),
        formattedTitle: { simpleText: 'Watch Later' },
    },
});
for (const id of WATCH_LATER_BROWSE_IDS) {
    check(
        `browseId ${id} is recognised`,
        isWatchLaterEntry(watchLaterEntry(id).guideEntryRenderer),
        true,
    );
}
check(
    'the icon alone is enough',
    isWatchLaterEntry(watchLaterEntry(null, 'WATCH_LATER').guideEntryRenderer),
    true,
);
check(
    'an ordinary entry is not Watch Later',
    isWatchLaterEntry(original.items[0].guideSectionRenderer.items[1].guideEntryRenderer),
    false,
);
check('null is not', isWatchLaterEntry(null), false);

payload = fresh();
payload.items[0].guideSectionRenderer.items.push(watchLaterEntry('VLWL', 'WATCH_LATER'));
check(
    'the setting off leaves Watch Later alone',
    filterGuide(payload, { hideWatchLater: false }),
    0,
);
check('  ...and it is still there', icons(payload).includes('WATCH_LATER'), true);
check('the setting on removes it', filterGuide(payload, { hideWatchLater: true }), 1);
check('  ...and only it', icons(payload).length, 11);
check('  ...leaving the real entries alone', icons(payload).includes('WHAT_TO_WATCH'), true);

// --- channel rows -----------------------------------------------------------
// The app gives a channel row a thumbnail rather than an icon. None of the
// signed-out entries has one, so this is asserted both ways.
payload = fresh();
check('no signed-out entry is a channel row', filterGuide(payload, { hideChannels: true }), 0);
payload = fresh();
payload.items[0].guideSectionRenderer.items.push({
    guideEntryRenderer: {
        thumbnail: { thumbnails: [{ url: 'x' }] },
        formattedTitle: { simpleText: 'A Channel' },
    },
});
check('a channel row is removed when asked', filterGuide(payload, { hideChannels: true }), 1);
check('  ...and kept when not', filterGuide(fresh(), { hideChannels: false }), 0);

// --- combinations -----------------------------------------------------------
payload = fresh();
payload.items[0].guideSectionRenderer.items.push(watchLaterEntry('VLWL', 'WATCH_LATER'));
check(
    'every rule applies at once',
    filterGuide(payload, { disabledIcons: ['GAMING'], hideWatchLater: true }),
    2,
);

// --- junk -------------------------------------------------------------------
// This runs inside JSON.parse for every parse the page makes, and a throw is
// caught by customGuideAction's handler -- which would silently cost the filter
// for that payload.
let threw = null;
const JUNK = [
    null,
    undefined,
    0,
    '',
    'str',
    [],
    {},
    { items: null },
    { items: [null] },
    { items: [{ guideSectionRenderer: null }] },
    { items: [{ guideSectionRenderer: { items: null } }] },
];
for (const v of JUNK) {
    try {
        filterGuide(v, { disabledIcons: ['GAMING'], hideChannels: true, hideWatchLater: true });
        isGuidePayload(v);
        shouldRemoveEntry(v, { disabledIcons: ['GAMING'] });
        isWatchLaterEntry(v);
    } catch (e) {
        threw = `${JSON.stringify(v)} threw ${e.message}`;
    }
}
check('junk never throws', threw, null);
check('a non-guide payload is not treated as one', isGuidePayload({ contents: {} }), false);

// A splice must not make the walk skip the entry that moved into its place --
// the trap processShelves records. Two adjacent removals prove it.
payload = fresh();
const section = payload.items[0].guideSectionRenderer.items;
check(
    'adjacent entries are both removed',
    filterGuide(payload, { disabledIcons: ['GAMING', 'NEWS', 'TROPHY'] }),
    3,
);
check('  ...leaving the rest intact', icons(payload).length, 8);

done();
