// The per-tile and per-shelf decisions the home page depends on.
//
// These used to be inline conditions spread through adblock.ts, reachable only
// by parsing a whole InnerTube payload, so none of them was covered. They are
// pure functions now and this runs the shipping module verbatim.
import { checker } from '../lib/repo.mjs';
import {
    bestThumbnail,
    previewableTile,
    startInlinePlayback,
    pageNameFromHash,
    shelfIsEmpty,
    hasMembersOnlyBadge,
    MEMBERS_ONLY_BADGE,
    DEFAULT_PREVIEW_DURATION_MS,
} from './tileFixes.generated.mts';

const { check, done } = checker();

// --- picking a thumbnail ----------------------------------------------------
// The old code synthesised `https://i.ytimg.com/vi/<id>/sddefault.jpg` at a
// declared 640x480 -- a 4:3 frame announced as fact to a renderer laying out a
// 16:9 tile -- and carried over a query string from a DIFFERENT variant's URL,
// where an `sqp` signature is issued per image and can fail validation.
const THUMBS = [
    { url: 'https://i.ytimg.com/vi/abc/default.jpg?sqp=one', width: 120, height: 90 },
    { url: 'https://i.ytimg.com/vi/abc/hqdefault.jpg?sqp=two', width: 480, height: 360 },
    { url: 'https://i.ytimg.com/vi/abc/mqdefault.jpg?sqp=three', width: 320, height: 180 },
];
check('picks the widest entry supplied', bestThumbnail(THUMBS).width, 480);
check('  ...keeping its own url and query string', bestThumbnail(THUMBS).url, THUMBS[1].url);
check('  ...and never synthesising one', /sddefault/.test(bestThumbnail(THUMBS).url), false);
// Applying it twice must not narrow the choice further, since several surfaces
// can walk the same payload.
check('is a fixed point', bestThumbnail([bestThumbnail(THUMBS)]).url, THUMBS[1].url);
check('empty array yields null', bestThumbnail([]), null);
check('null yields null', bestThumbnail(null), null);
check('undefined yields null', bestThumbnail(undefined), null);
check('a non-array yields null', bestThumbnail('nope'), null);
check('entries with no url are skipped', bestThumbnail([{ width: 9999 }, THUMBS[0]]).url, THUMBS[0].url);
check('an entry with no width still beats nothing', bestThumbnail([{ url: 'x' }]).url, 'x');
check('  ...but loses to one that declares a width', bestThumbnail([{ url: 'x' }, THUMBS[0]]).width, 120);

// --- which tiles get a preview ----------------------------------------------
const videoTile = () => ({
    tileRenderer: {
        style: 'TILE_STYLE_YTLR_DEFAULT',
        contentId: 'abc',
        onSelectCommand: { watchEndpoint: { videoId: 'abc' } },
    },
});
check('a plain video tile is previewable', previewableTile(videoTile()), true);

const channelTile = { tileRenderer: { onSelectCommand: { browseEndpoint: { browseId: 'UC1' } } } };
check('a channel tile is not', previewableTile(channelTile), false);
const shortsTile = { tileRenderer: { onSelectCommand: { reelWatchEndpoint: { videoId: 'abc' } } } };
check('a Shorts tile is not', previewableTile(shortsTile), false);

const ytOwnFocus = videoTile();
ytOwnFocus.tileRenderer.onFocusCommand = { playbackEndpoint: {} };
check('YouTube\'s own focus playback wins', previewableTile(ytOwnFocus), false);
const ytExecutor = videoTile();
ytExecutor.tileRenderer.onFocusCommand = { commandExecutorCommand: {} };
check('YouTube\'s own command executor wins', previewableTile(ytExecutor), false);

// Idempotence. A payload can reach both JSON.parse and Response.json, and a
// shelf can be cloned into a second surface.
const already = videoTile();
already.tileRenderer.onFocusCommand = startInlinePlayback({ watchEndpoint: {} }, null);
check('a tile we already handled is skipped', previewableTile(already), false);

check('a tile with no select command is not', previewableTile({ tileRenderer: {} }), false);
check('a non-tile is not', previewableTile({ adSlotRenderer: {} }), false);
check('null is not', previewableTile(null), false);

// --- the command itself -----------------------------------------------------
const cmd = startInlinePlayback({ watchEndpoint: { videoId: 'abc' } }, { durationMs: 12000, muted: true });
check('carries the requested duration', cmd.startInlinePlaybackCommand.durationMs, 12000);
check('carries the requested mute', cmd.startInlinePlaybackCommand.muted, true);
check('mutes false by default', startInlinePlayback({}, null).startInlinePlaybackCommand.muted, false);
check('keeps the endpoint it was handed',
      cmd.startInlinePlaybackCommand.playbackEndpoint.watchEndpoint.videoId, 'abc');
for (const [label, duration] of [['NaN', NaN], ['zero', 0], ['negative', -1], ['absent', undefined]]) {
    check(`a ${label} duration falls back to the default`,
          startInlinePlayback({}, { durationMs: duration }).startInlinePlaybackCommand.durationMs,
          DEFAULT_PREVIEW_DURATION_MS);
}
check('a NaN delay falls back rather than reaching the payload',
      Number.isFinite(startInlinePlayback({}, { delayMs: NaN }).startInlinePlaybackCommand.delayMs), true);

// --- which surface are we on ------------------------------------------------
// The vocabulary here is fixed by the settings list: search, home, music,
// gaming, subscriptions, library, more.
check('a bare hash is the home page', pageNameFromHash(''), 'home');
check('  ...as is a lone slash', pageNameFromHash('/'), 'home');
check('  ...and one still carrying its #', pageNameFromHash('#/'), 'home');
check('search is search', pageNameFromHash('/search?q=cats'), 'search');
check('a browse id keeps working', pageNameFromHash('/browse?c=FEtopics_home'), 'home');
check('  ...for music', pageNameFromHash('/browse?c=FEmusic'), 'music');
check('  ...for subscriptions', pageNameFromHash('/browse?c=FEsubscriptions'), 'subscriptions');
check('something unrecognised yields nothing rather than a wrong page',
      pageNameFromHash('/watch'), '');
check('null does not throw', pageNameFromHash(null), '');
check('a number does not throw', pageNameFromHash(42), '');

// --- shelves filtered down to nothing ---------------------------------------
const shelfWith = (items) => ({ shelfRenderer: { content: { horizontalListRenderer: { items } } } });
check('a shelf filtered to zero is empty', shelfIsEmpty(shelfWith([])), true);
// Deliberately not "fewer than two": a one-tile shelf may be one a continuation
// is about to fill.
check('a one-tile shelf is not', shelfIsEmpty(shelfWith([videoTile()])), false);
check('a shelf shape with no list is not', shelfIsEmpty({ shelfRenderer: {} }), false);
check('a non-shelf is not', shelfIsEmpty({ richItemRenderer: {} }), false);
check('null is not', shelfIsEmpty(null), false);

// --- members-only videos -----------------------------------------------------
// A TV tile keeps its badges INSIDE its metadata lines, not in a top-level
// `badges` array as the web client does. That path is where all 259 badges in
// the captured browse responses sit -- the "4K", "CC" and "8K" labels -- so the
// fixtures below are built in the real shape. The MEMBERS_ONLY style itself
// comes from the app's own YtlrMetadataBadgeRenderer style map; no captured tile
// carried one, because every capture is signed out.
const badgedTile = (style, label) => ({
    tileRenderer: {
        style: 'TILE_STYLE_YTLR_DEFAULT',
        contentId: 'abc',
        onSelectCommand: { watchEndpoint: { videoId: 'abc' } },
        metadata: { tileMetadataRenderer: {
            title: { simpleText: 'A video' },
            lines: [
                { lineRenderer: { items: [
                    { lineItemRenderer: { badge: { metadataBadgeRenderer: { style, label } } } },
                    { lineItemRenderer: { text: { simpleText: '150K views' } } },
                ] } },
            ],
        } },
    },
});
check('a members-only badge is found', hasMembersOnlyBadge(badgedTile(MEMBERS_ONLY_BADGE, 'Members only').tileRenderer), true);
// The two badges that DO appear on real tiles must not be mistaken for it.
check('a 4K badge is not members-only', hasMembersOnlyBadge(badgedTile('BADGE_STYLE_TYPE_SIMPLE', '4K').tileRenderer), false);
check('a CC badge is not members-only', hasMembersOnlyBadge(badgedTile('BADGE_STYLE_TYPE_SIMPLE', 'CC').tileRenderer), false);
check('a verified badge is not members-only', hasMembersOnlyBadge(badgedTile('BADGE_STYLE_TYPE_VERIFIED', null).tileRenderer), false);
check('an unbadged tile is not members-only', hasMembersOnlyBadge(videoTile().tileRenderer), false);
// Found wherever it sits: the badge is on line 0 above, but nothing says it
// always will be.
const secondLine = badgedTile('BADGE_STYLE_TYPE_SIMPLE', '4K');
secondLine.tileRenderer.metadata.tileMetadataRenderer.lines.push(
    { lineRenderer: { items: [{ lineItemRenderer: { badge: { metadataBadgeRenderer: { style: MEMBERS_ONLY_BADGE } } } }] } });
check('a badge on a later line is still found', hasMembersOnlyBadge(secondLine.tileRenderer), true);
check('a tile with no metadata is not members-only', hasMembersOnlyBadge({ contentId: 'x' }), false);
check('null is not', hasMembersOnlyBadge(null), false);

// --- junk -------------------------------------------------------------------
// Every one of these runs inside JSON.parse for every response the app parses.
// A throw is swallowed by adblock.ts's catch and silently costs the whole pass
// for that payload, which is the worst possible way for this to fail.
let threw = null;
const JUNK = [null, undefined, 0, '', 'string', [], {}, [null], [{}], NaN, true];
for (const fn of [bestThumbnail, previewableTile, pageNameFromHash, shelfIsEmpty, hasMembersOnlyBadge]) {
    for (const value of JUNK) {
        try {
            fn(value);
        } catch (e) {
            threw = `${fn.name}(${JSON.stringify(value)}) threw ${e.message}`;
        }
    }
}
for (const value of JUNK) {
    try {
        startInlinePlayback(value, value);
    } catch (e) {
        threw = `startInlinePlayback(${JSON.stringify(value)}) threw ${e.message}`;
    }
}
check('no exported function throws on junk', threw, null);

// --- cost -------------------------------------------------------------------
// These run per tile on every payload, and a television SoC has no headroom.
const tiles = Array.from({ length: 300 }, videoTile);
const before = Date.now();
for (const tile of tiles) {
    previewableTile(tile);
    bestThumbnail(THUMBS);
}
check('300 tiles cost under 100ms', Date.now() - before < 100, true);

done();
