// The per-tile and per-shelf decisions the home page depends on.
//
// These used to be inline conditions spread through adblock.ts, reachable only
// by parsing a whole InnerTube payload, so none of them was covered. They are
// pure functions now and this runs the shipping module verbatim.
import { checker, readRepo } from '../lib/repo.mjs';
import {
    bestThumbnail,
    previewableTile,
    startInlinePlayback,
    pageNameFromHash,
    shelfIsEmpty,
    hasMembersOnlyBadge,
    MEMBERS_ONLY_BADGE,
    DEFAULT_PREVIEW_DURATION_MS,
    shelfCanShrink,
    deArrowableTile,
    shrinkShelf,
    SHRINKABLE_TILE_STYLES,
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
check(
    'entries with no url are skipped',
    bestThumbnail([{ width: 9999 }, THUMBS[0]]).url,
    THUMBS[0].url,
);
check('an entry with no width still beats nothing', bestThumbnail([{ url: 'x' }]).url, 'x');
check(
    '  ...but loses to one that declares a width',
    bestThumbnail([{ url: 'x' }, THUMBS[0]]).width,
    120,
);

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
check("YouTube's own focus playback wins", previewableTile(ytOwnFocus), false);
const ytExecutor = videoTile();
ytExecutor.tileRenderer.onFocusCommand = { commandExecutorCommand: {} };
check("YouTube's own command executor wins", previewableTile(ytExecutor), false);

// Idempotence. A payload can reach both JSON.parse and Response.json, and a
// shelf can be cloned into a second surface.
const already = videoTile();
already.tileRenderer.onFocusCommand = startInlinePlayback({ watchEndpoint: {} }, null);
check('a tile we already handled is skipped', previewableTile(already), false);

check('a tile with no select command is not', previewableTile({ tileRenderer: {} }), false);
check('a non-tile is not', previewableTile({ adSlotRenderer: {} }), false);
check('null is not', previewableTile(null), false);

// --- the command itself -----------------------------------------------------
const cmd = startInlinePlayback(
    { watchEndpoint: { videoId: 'abc' } },
    { durationMs: 12000, muted: true },
);
check('carries the requested duration', cmd.startInlinePlaybackCommand.durationMs, 12000);
check('carries the requested mute', cmd.startInlinePlaybackCommand.muted, true);
check(
    'mutes false by default',
    startInlinePlayback({}, null).startInlinePlaybackCommand.muted,
    false,
);
check(
    'keeps the endpoint it was handed',
    cmd.startInlinePlaybackCommand.playbackEndpoint.watchEndpoint.videoId,
    'abc',
);
for (const [label, duration] of [
    ['NaN', NaN],
    ['zero', 0],
    ['negative', -1],
    ['absent', undefined],
]) {
    check(
        `a ${label} duration falls back to the default`,
        startInlinePlayback({}, { durationMs: duration }).startInlinePlaybackCommand.durationMs,
        DEFAULT_PREVIEW_DURATION_MS,
    );
}
check(
    'a NaN delay falls back rather than reaching the payload',
    Number.isFinite(startInlinePlayback({}, { delayMs: NaN }).startInlinePlaybackCommand.delayMs),
    true,
);

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
check(
    'something unrecognised yields nothing rather than a wrong page',
    pageNameFromHash('/watch'),
    '',
);
check('null does not throw', pageNameFromHash(null), '');
check('a number does not throw', pageNameFromHash(42), '');

// --- shelves filtered down to nothing ---------------------------------------
const shelfWith = (items) => ({
    shelfRenderer: { content: { horizontalListRenderer: { items } } },
});
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
        metadata: {
            tileMetadataRenderer: {
                title: { simpleText: 'A video' },
                lines: [
                    {
                        lineRenderer: {
                            items: [
                                {
                                    lineItemRenderer: {
                                        badge: { metadataBadgeRenderer: { style, label } },
                                    },
                                },
                                { lineItemRenderer: { text: { simpleText: '150K views' } } },
                            ],
                        },
                    },
                ],
            },
        },
    },
});
check(
    'a members-only badge is found',
    hasMembersOnlyBadge(badgedTile(MEMBERS_ONLY_BADGE, 'Members only').tileRenderer),
    true,
);
// The two badges that DO appear on real tiles must not be mistaken for it.
check(
    'a 4K badge is not members-only',
    hasMembersOnlyBadge(badgedTile('BADGE_STYLE_TYPE_SIMPLE', '4K').tileRenderer),
    false,
);
check(
    'a CC badge is not members-only',
    hasMembersOnlyBadge(badgedTile('BADGE_STYLE_TYPE_SIMPLE', 'CC').tileRenderer),
    false,
);
check(
    'a verified badge is not members-only',
    hasMembersOnlyBadge(badgedTile('BADGE_STYLE_TYPE_VERIFIED', null).tileRenderer),
    false,
);
check('an unbadged tile is not members-only', hasMembersOnlyBadge(videoTile().tileRenderer), false);
// Found wherever it sits: the badge is on line 0 above, but nothing says it
// always will be.
const secondLine = badgedTile('BADGE_STYLE_TYPE_SIMPLE', '4K');
secondLine.tileRenderer.metadata.tileMetadataRenderer.lines.push({
    lineRenderer: {
        items: [
            {
                lineItemRenderer: {
                    badge: { metadataBadgeRenderer: { style: MEMBERS_ONLY_BADGE } },
                },
            },
        ],
    },
});
check('a badge on a later line is still found', hasMembersOnlyBadge(secondLine.tileRenderer), true);
check(
    'a tile with no metadata is not members-only',
    hasMembersOnlyBadge({ contentId: 'x' }),
    false,
);
check('null is not', hasMembersOnlyBadge(null), false);

// --- junk -------------------------------------------------------------------
// Every one of these runs inside JSON.parse for every response the app parses.
// A throw is swallowed by adblock.ts's catch and silently costs the whole pass
// for that payload, which is the worst possible way for this to fail.
let threw = null;
const JUNK = [null, undefined, 0, '', 'string', [], {}, [null], [{}], NaN, true];
for (const fn of [
    bestThumbnail,
    previewableTile,
    pageNameFromHash,
    shelfIsEmpty,
    hasMembersOnlyBadge,
]) {
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

// --- compact shelves --------------------------------------------------------
// The flag is YouTube's own: the app turns tvhtml5Style.effects.shrink into an
// `isShrunk` prop that drives the tile box, the thumbnail, the virtual list's
// item pitch and the shelf row height together. THE PREDICATE IS THE WHOLE
// FEATURE. The app shortens the ROW for any shelf carrying the flag, but two
// item kinds keep their full height regardless -- a lockupViewModel, and any
// tileRenderer carrying `styling` -- so a shelf containing either ends up with
// 21.625rem of card in an 18.375rem row and roughly 78px sliced off the bottom
// of every card: the channel name and the view count. Measured on the live
// search surface, where every item is a lockupViewModel today: 4 of 4 children
// overflowed their shelf. Each rejection below is one of those traps.
const tile = (style = 'TILE_STYLE_YTLR_DEFAULT', extra = {}) => ({
    tileRenderer: { style, ...extra },
});
const shelf = (items, extra = {}) => ({
    content: { horizontalListRenderer: { items } },
    ...extra,
});

check('an ordinary browse shelf shrinks', shelfCanShrink(shelf([tile(), tile()])), true);
for (const style of SHRINKABLE_TILE_STYLES) {
    check(`  ...${style} is shrinkable`, shelfCanShrink(shelf([tile(style)])), true);
}

// A row that shrinks around cards that do not.
check(
    'a lockupViewModel item blocks it',
    shelfCanShrink(shelf([tile(), { lockupViewModel: {} }])),
    false,
);
check('  ...as does a grid button', shelfCanShrink(shelf([{ gridButtonRenderer: {} }])), false);
check(
    '  ...and a tile carrying styling, which skips the shrink branch',
    shelfCanShrink(
        shelf([tile('TILE_STYLE_YTLR_DEFAULT', { styling: { scale: 'TILE_SCALE_MD' } })]),
    ),
    false,
);
// A GAME poster is 18.813rem and a Shorts tile 21.25rem against an 18.375rem row.
check(
    '  ...and a style with no smaller size, which would be clipped',
    shelfCanShrink(shelf([tile('TILE_STYLE_YTLR_GAME')])),
    false,
);
check(
    '  ...even when only one tile in the shelf is wrong',
    shelfCanShrink(shelf([tile(), tile(), tile('TILE_STYLE_YTLR_SHORTS')])),
    false,
);

// A typed shelf can shrink its row without shrinking its cards.
check(
    'a typed shelf is left alone',
    shelfCanShrink(
        shelf([tile()], { tvhtml5ShelfRendererType: 'TVHTML5_SHELF_RENDERER_TYPE_GRID' }),
    ),
    false,
);
check(
    '  ...but the UNKNOWN type is just an ordinary shelf',
    shelfCanShrink(
        shelf([tile()], { tvhtml5ShelfRendererType: 'TVHTML5_SHELF_RENDERER_TYPE_UNKNOWN' }),
    ),
    true,
);
// Asking for the opposite.
check(
    "the app's own enlarge mode wins",
    shelfCanShrink(shelf([tile()], { tvhtml5Style: { effects: { enlarge: true } } })),
    false,
);

// Shapes rather than crashes.
check('a shelf with no items does not shrink', shelfCanShrink(shelf([])), false);
check('  ...nor one with no list at all', shelfCanShrink({}), false);
check('  ...nor null', shelfCanShrink(null), false);
check('  ...nor a string', shelfCanShrink('shelf'), false);

// --- setting the flag -------------------------------------------------------
const target = shelf([tile()]);
shrinkShelf(target);
check('the flag is written where the app reads it', target.tvhtml5Style.effects.shrink, true);
shrinkShelf(target);
check('  ...and setting it twice is the same', target.tvhtml5Style.effects.shrink, true);
// Additive: the app reads siblings of `shrink` off the same object, so
// replacing effects wholesale would drop whatever else the server sent.
const withEffects = shelf([tile()], { tvhtml5Style: { effects: { spotlight: true } } });
shrinkShelf(withEffects);
check('  ...preserving other effects', withEffects.tvhtml5Style.effects.spotlight, true);
check('  ...alongside the new one', withEffects.tvhtml5Style.effects.shrink, true);
const withStyle = shelf([tile()], { tvhtml5Style: { somethingElse: 1 } });
shrinkShelf(withStyle);
check('  ...and other tvhtml5Style fields', withStyle.tvhtml5Style.somethingElse, 1);
check('junk does not throw', shrinkShelf(null) ?? 'no throw', 'no throw');

// --- who DeArrow can be asked about -----------------------------------------
// One request per tile goes out to a third party, so every tile that cannot
// have branding is a question nobody asked, sent from a television. And the
// thumbnail path overwrites the tile's ONLY thumbnail, so a tile whose
// contentId is not a video id would get a URL built from a channel or playlist
// id -- nonsense that cannot load.
const video = (extra = {}) => ({
    tileRenderer: {
        contentId: 'dQw4w9WgXcQ',
        onSelectCommand: { watchEndpoint: { videoId: 'dQw4w9WgXcQ' } },
        ...extra,
    },
});
check('an ordinary video tile can be asked about', deArrowableTile(video()), true);
check(
    'a channel tile cannot',
    deArrowableTile({
        tileRenderer: {
            contentId: 'UCuAXFkgsw1L7xaCfnd5JJOw',
            onSelectCommand: { browseEndpoint: {} },
        },
    }),
    false,
);
check(
    '  ...nor a playlist tile',
    deArrowableTile({
        tileRenderer: {
            contentId: 'PLrAXtmRdnEQy6nuLMfO6uKk',
            onSelectCommand: { watchPlaylistEndpoint: {} },
        },
    }),
    false,
);
check('  ...nor a shelf button', deArrowableTile({ gridButtonRenderer: {} }), false);
check(
    '  ...nor a reel',
    deArrowableTile(video({ onSelectCommand: { watchEndpoint: {}, reelWatchEndpoint: {} } })),
    false,
);
check(
    '  ...nor a Shorts-typed tile',
    deArrowableTile(video({ tvhtml5ShelfRendererType: 'TVHTML5_TILE_RENDERER_TYPE_SHORTS' })),
    false,
);
// The id has to be an id. A contentId carrying a channel or playlist id on a
// tile that somehow has a watchEndpoint would build a URL for a video that does
// not exist.
check(
    'a contentId that is not a video id is refused',
    deArrowableTile({
        tileRenderer: {
            contentId: 'UCuAXFkgsw1L7xaCfnd5JJOw',
            onSelectCommand: { watchEndpoint: {} },
        },
    }),
    false,
);
check(
    '  ...as is a missing one',
    deArrowableTile({ tileRenderer: { onSelectCommand: { watchEndpoint: {} } } }),
    false,
);
// A tile whose contentId LOOKS like a video id but which does not select a
// video -- the id check alone would wave this through, so this is the case that
// makes the watchEndpoint test load-bearing rather than decorative.
check(
    'an eleven-character id without a watchEndpoint is refused',
    deArrowableTile({
        tileRenderer: { contentId: 'dQw4w9WgXcQ', onSelectCommand: { browseEndpoint: {} } },
    }),
    false,
);
check(
    '  ...and one with no select command at all',
    deArrowableTile({ tileRenderer: { contentId: 'dQw4w9WgXcQ' } }),
    false,
);
check('junk does not throw', deArrowableTile(null), false);

// --- the substitution must stay behind a load check -------------------------
// This is the ONLY path in the mod that can leave a tile with no image at all:
// it replaces the single thumbnail a real TV payload carries, and the generator
// answers 204-with-no-body for a frame it has not made yet. Asserted as source
// shape because the failure is a network reply, not a value.
const adblockSrc = readRepo('mods', 'features', 'adblock.ts');
const adblockCode = adblockSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
check(
    'the DeArrow thumbnail is probed before it is used',
    /new Image\(\)/.test(adblockCode) && /naturalWidth/.test(adblockCode),
    true,
);
check(
    '  ...and the swap happens only inside the load handler',
    /onload\s*=[\s\S]{0,400}?thumb\.thumbnails\s*=/.test(adblockCode),
    true,
);
check('  ...with the original kept until then', /probe\.onerror\s*=/.test(adblockCode), true);
check(
    '  ...and only video tiles are asked about',
    adblockCode.includes('deArrowableTile(item)'),
    true,
);

// --- the predicate against REAL captured shelves ----------------------------
// It shipped having only ever been run against objects written by hand in this
// file to match somebody's understanding of the shape. That is how a feature
// reaches a television and does nothing: every assertion passed, because every
// assertion was asking the code to agree with the same assumption that built it.
//
// shelves.captured.json holds the shelfRenderers out of fifteen real TV browse
// responses -- six topic surfaces, gaming, search, and three watch-next replies
// -- reduced to the fields this predicate reads (tvhtml5ShelfRendererType,
// tvhtml5Style, and each item's renderer kind plus a tileRenderer's style and
// styling). Reduced, not synthesised: every value below came off the wire.
//
// WHAT IS NOT IN IT, because an earlier version of this comment claimed it was:
// there is no home capture and no subscriptions capture. The only typed shelves
// here are GRID, from the watch-next replies; GRID_XL, SHORTS and EDU -- the
// types the surrounding commits say a signed-in home is built from -- appear
// nowhere. So the typed-shelf assertion below is real but it is policing
// watch-next, and the home claim that scopes this feature in the settings panel
// rests on the live-app measurement recorded in the commit, NOT on this corpus.
// Capturing a signed-in home needs an account; until one is captured, that claim
// has no fixture behind it and this comment should not imply otherwise.
//
// NOR DOES THIS CORPUS CARRY THE MUTATION LOAD ON ITS OWN. Measured, after the
// commit message overstated it: truncating this file to the hand-written
// fixtures alone still catches accepting typed shelves (1 failure), rejecting
// everything (6) and letting a lockupViewModel through (2). Adding the captured
// shelves takes those to 2, 8 and 2. The gain is real but marginal; the reason
// to keep them is that they are the app's shapes rather than ours, so they will
// catch a drift in what YouTube sends that no hand-written object can.
const captured = JSON.parse(readRepo('test', 'tile-fixes', 'shelves.captured.json'));
const shelfType = (shelf) =>
    (shelf.tvhtml5ShelfRendererType || 'UNTYPED').replace('TVHTML5_SHELF_RENDERER_TYPE_', '');

check('there are captured surfaces to check', captured.length > 0, true);
const allShelves = captured.flatMap((s) => s.shelves);
check('  ...with shelves in them', allShelves.length > 10, true);

// THE FEATURE IS NOT DEAD. If a future edit makes the predicate reject
// everything, it becomes a silent no-op everywhere rather than only on the
// surfaces it cannot reach -- and nothing else here would notice.
const accepted = allShelves.filter((sh) => shelfCanShrink(sh));
check('the predicate accepts real shelves', accepted.length > 0, true);
const topicSurfaces = captured.filter((s) => s.surface.includes('FEtopics'));
const topicAccepted = topicSurfaces.flatMap((s) => s.shelves).filter((sh) => shelfCanShrink(sh));
check('  ...including most topic-surface shelves', topicAccepted.length >= 8, true);

// AND IT NEVER ACCEPTS A TYPED ONE. This is the clipping guard, and it is the
// assertion that matters: the app keys its tile-size table on the shelf type and
// returns before it reads the shrink flag, while its row-height function has a
// DIFFERENT per-type list -- so a typed shelf that slipped through could shorten
// the row while every card keeps its height.
const typedAccepted = allShelves.filter((sh) => sh.tvhtml5ShelfRendererType && shelfCanShrink(sh));
check('  ...and never a typed shelf', typedAccepted.map(shelfType), []);
// Likewise anything whose items are not all plain tiles.
const mixedAccepted = allShelves.filter(
    (sh) =>
        shelfCanShrink(sh) &&
        (sh.content?.horizontalListRenderer?.items || []).some((it) => !it?.tileRenderer),
);
check('  ...nor one carrying a non-tile item', mixedAccepted.length, 0);

// Search is entirely lockupViewModel today and must stay refused: the row would
// shrink and the lockups would not.
const search = captured.find((s) => s.surface === 'search');
if (search) {
    check(
        'search shelves are refused',
        search.shelves.filter((sh) => shelfCanShrink(sh)).length,
        0,
    );
}

done();
