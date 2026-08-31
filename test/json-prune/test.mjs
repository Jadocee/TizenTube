// The json-prune matcher, and the ad rules the mod actually ships.
//
// The rules are lifted out of adblock.ts by test/refresh.mjs rather than copied,
// so this exercises what runs on a television. The cases that matter most are
// the ones the previous hardcoded branches got wrong: a property nested rather
// than at the top level, and a promoted tile in a list nobody had written a
// branch for.
import { checker } from '../lib/repo.mjs';
import { prune, applyRule, pruneTokens, textCouldMatch } from './mod.generated.mts';
import { AD_RULES } from './rules.generated.mts';

const { check, done } = checker();
const clone = (v) => JSON.parse(JSON.stringify(v));

// --- the grammar ------------------------------------------------------------
let o = { a: { b: { c: 1 } } };
applyRule(o, { path: 'a.b.c' });
check('a literal path deletes its key', 'c' in o.a.b, false);

o = { a: { b: 1 }, x: { b: 2 } };
applyRule(o, { path: '*.b', replaceWith: 0 });
check('* matches any one key', `${o.a.b}${o.x.b}`, '00');

o = { deep: { deeper: { deepest: { target: 1 } } }, target: 2 };
applyRule(o, { path: '**.target', replaceWith: 0 });
check('** matches at every depth', `${o.deep.deeper.deepest.target}${o.target}`, '00');

o = { list: [{ target: 1 }, { target: 2 }] };
applyRule(o, { path: '**.target', replaceWith: 0 });
check('** descends through arrays', `${o.list[0].target}${o.list[1].target}`, '00');

o = { a: 1 };
applyRule(o, { path: 'a', replaceWith: [] });
check('replaceWith keeps the key', Array.isArray(o.a) && o.a.length === 0, true);
o = { a: 1 };
applyRule(o, { path: 'a' });
check('omitting replaceWith deletes it', 'a' in o, false);

// A rule that matches nothing must not invent keys.
o = { a: 1 };
applyRule(o, { path: 'nope.nothing', replaceWith: 0 });
check('a rule that matches nothing changes nothing', JSON.stringify(o), '{"a":1}');

// --- dropItemsWith ----------------------------------------------------------
o = { items: [{ good: 1 }, { adSlotRenderer: {} }, { good: 2 }] };
applyRule(o, { path: 'items', dropItemsWith: 'adSlotRenderer' });
check('promoted items are removed, real ones kept', o.items.length, 2);
check('  ...and the survivors are the real ones', JSON.stringify(o.items), '[{"good":1},{"good":2}]');

o = { items: [{ a: { b: { c: 1 } } }, { keep: 1 }] };
applyRule(o, { path: 'items', dropItemsWith: 'a.b.c' });
check('dropItemsWith follows a nested path', JSON.stringify(o.items), '[{"keep":1}]');

// --- the shipped rules, against realistic payload shapes --------------------
// The regression the rewrite exists for: nested rather than top level.
let payload = { adPlacements: [1], continuation: { adPlacements: [2, 3] } };
prune(payload, AD_RULES);
check('top-level adPlacements is emptied', payload.adPlacements.length, 0);
check('NESTED adPlacements is emptied too', payload.continuation.adPlacements.length, 0);

payload = { playerAds: [{}], adSlots: [{}], watchNext: { playerAds: [{}], adSlots: [{}] } };
prune(payload, AD_RULES);
check('playerAds becomes false at any depth',
      `${payload.playerAds}${payload.watchNext.playerAds}`, 'falsefalse');
check('adSlots is emptied at any depth',
      payload.adSlots.length + payload.watchNext.adSlots.length, 0);

// A grid surface: never covered by the old branches, which handled only the home
// sectionList and a shelf's horizontalList.
payload = {
    contents: { tvBrowseRenderer: { content: { tvSurfaceContentRenderer: { content: {
        gridRenderer: { items: [{ tileRenderer: { id: 'real' } }, { adSlotRenderer: {} }] },
    } } } } },
};
prune(payload, AD_RULES);
const grid = payload.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.gridRenderer.items;
check('a promoted tile in a GRID is dropped', grid.length, 1);
check('  ...and the real tile survives', grid[0].tileRenderer.id, 'real');

// The home shelf the old code did cover, still covered.
payload = { contents: [{ shelfRenderer: { content: { horizontalListRenderer: {
    items: [{ tileRenderer: {} }, { adSlotRenderer: {} }] } } } }, { adSlotRenderer: {} }] };
prune(payload, AD_RULES);
check('the home section list still drops its ad', payload.contents.length, 1);
check('  ...and so does the shelf inside it',
      payload.contents[0].shelfRenderer.content.horizontalListRenderer.items.length, 1);

// Shorts reels.
payload = { entries: [
    { command: { reelWatchEndpoint: { adClientParams: { isAd: true } } } },
    { command: { reelWatchEndpoint: { videoId: 'keep' } } },
] };
prune(payload, AD_RULES);
check('a promoted reel is dropped', payload.entries.length, 1);
check('  ...and the real reel survives', payload.entries[0].command.reelWatchEndpoint.videoId, 'keep');

// Nothing to do: a clean payload must come out identical.
const clean = { contents: [{ tileRenderer: { id: 'a' } }], videoDetails: { videoId: 'x' } };
const before = JSON.stringify(clean);
prune(clean, AD_RULES);
check('a payload with no ads is left untouched', JSON.stringify(clean), before);

// --- the cheap pre-check ----------------------------------------------------
const tokens = pruneTokens(AD_RULES);
check('tokens exclude the wildcards', tokens.includes('*') || tokens.includes('**'), false);
check('tokens include the real keys', tokens.includes('adPlacements') && tokens.includes('adSlotRenderer'), true);
check('text without any token is skipped', textCouldMatch('{"videoDetails":{}}', tokens), false);
check('text with a token is not skipped', textCouldMatch('{"adPlacements":[]}', tokens), true);
// A non-string source cannot be ruled out, so it must run.
check('a non-string source always runs', textCouldMatch(undefined, tokens), true);

// --- bounded ----------------------------------------------------------------
// This runs inside JSON.parse on a TV; a pathological payload must not hang it.
const deep = {};
let node = deep;
for (let i = 0; i < 5000; i++) { node.next = { filler: i }; node = node.next; }
node.adPlacements = [1];
const started = process.hrtime.bigint();
prune(deep, AD_RULES);
const ms = Number(process.hrtime.bigint() - started) / 1e6;
check('a deeply nested payload completes quickly', ms < 500, true);

done();
