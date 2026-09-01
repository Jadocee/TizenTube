import { chromium as findChromium, chromiumExecutable, skip, readRepo } from '../lib/repo.mjs';

const chromium = await findChromium();
if (!chromium) skip('Playwright is not installed; this harness needs a real browser');
import { readFileSync } from 'fs';
const bundle = readRepo('dist', 'userScript.js');

const browser = await chromium.launch({ executablePath: chromiumExecutable() });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message || e)));

// The script first in <head>, exactly where the proxy now puts it, with a body
// that only exists after it has run — and a slow tail so the parser is still
// working when the module bodies execute.
await page.route('**/tv*', (route) =>
    route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><html><head>
<title>YouTube</title></head><body><div id="container"></div>
<video></video><script src="/tizentube/userScript.js"></script></body></html>`,
    }),
);
await page.route('**/tizentube/userScript.js', (route) =>
    route.fulfill({
        status: 200,
        contentType: 'application/javascript; charset=utf-8',
        body: bundle,
    }),
);

await page.goto('https://www.youtube.com/tv', { waitUntil: 'load' });

const early = await page.evaluate(() => ({
    ranBeforeBody: !!window.__ttSawNoBody,
    hasQueue: !!window.queuedVideos,
    pipFlag: typeof window.isPipPlaying,
    jsonPatched: JSON.parse.toString().indexOf('native code') === -1,
}));

// Give the deferred work (whenBodyReady, the 250ms polls) time to land.
await page.waitForTimeout(3000);

const late = await page.evaluate(() => ({
    styleEls: document.querySelectorAll('style').length,
    ttStyle: [...document.querySelectorAll('style')].some((s) =>
        s.textContent.includes('ytaf-ui-container'),
    ),
    panel: !!document.querySelector('.ytaf-ui-container'),
}));

let fail = 0;
const check = (d, got, want) => {
    const ok = got === want;
    if (!ok) fail++;
    console.log(
        `${ok ? '  ok  ' : 'FAIL  '}${d.padEnd(56)} ${JSON.stringify(got)}${ok ? '' : '  want ' + JSON.stringify(want)}`,
    );
};

console.log('Bundle loaded LAST, as TizenBrew still injects it:\n');
check('no uncaught errors during document-start execution', errors.length, 0);
if (errors.length) errors.slice(0, 6).forEach((e) => console.log('        ' + e));
check('JSON.parse was replaced', early.jsonPatched, true);
check('queue global installed', early.hasQueue, true);
check('PiP global installed', early.pipFlag, 'boolean');
// --- the Response.json() route ----------------------------------------------
// JSON.parse was the only interception point. YouTube's TV app reads InnerTube
// responses with Response.json() whenever the server-side bedrock-networking
// flag is off, and the engine parses those internally -- never touching
// JSON.parse. Every payload taking that route arrived with its ads intact.
const viaResponse = await page.evaluate(async () => {
    const body = JSON.stringify({
        adPlacements: [{ ad: 1 }],
        playerAds: [{ ad: 2 }],
        watchNext: { adPlacements: [{ ad: 3 }] },
        contents: [{ tileRenderer: { id: 'real' } }, { adSlotRenderer: {} }],
    });
    const parsed = await new Response(body).json();
    return {
        hooked: Response.prototype.json.toString().indexOf('native code') === -1,
        top: parsed.adPlacements.length,
        nested: parsed.watchNext.adPlacements.length,
        playerAds: parsed.playerAds,
        kept: parsed.contents.length,
        keptId: parsed.contents[0]?.tileRenderer?.id,
    };
});

console.log('\nRead through Response.json(), which used to bypass the mod entirely:');
check('Response.prototype.json is hooked', viaResponse.hooked, true);
check('top-level adPlacements emptied', viaResponse.top, 0);
check('nested adPlacements emptied', viaResponse.nested, 0);
check('playerAds neutralised', viaResponse.playerAds, false);
check('the promoted tile is dropped', viaResponse.kept, 1);
check('the real tile survives', viaResponse.keptId, 'real');

// --- the home surface, end to end through the real bundle -------------------
// The only evidence obtainable without a television that the shelf pass runs at
// all: a home-shaped payload read the way the app reads one, checked for the
// preview command the tile did not arrive with and for the shelf that every
// filter emptied.
const home = await page.evaluate(async () => {
    const videoTile = (id) => ({
        tileRenderer: {
            style: 'TILE_STYLE_YTLR_DEFAULT',
            contentId: id,
            onSelectCommand: { watchEndpoint: { videoId: id } },
            header: {
                tileHeaderRenderer: {
                    thumbnail: {
                        thumbnails: [
                            {
                                url: `https://i.ytimg.com/vi/${id}/default.jpg`,
                                width: 120,
                                height: 90,
                            },
                            {
                                url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
                                width: 480,
                                height: 360,
                            },
                        ],
                    },
                },
            },
            // `lines` is what addLongPress reads for the subtitle, and without it that
            // pass bails before it clones -- which quietly made the re-entry check
            // below cover only half of what clones a tile.
            metadata: {
                tileMetadataRenderer: {
                    title: { simpleText: id },
                    lines: [
                        {
                            lineRenderer: {
                                items: [
                                    { lineItemRenderer: { text: { simpleText: 'A Channel' } } },
                                ],
                            },
                        },
                    ],
                },
            },
        },
    });
    const shelf = (items) => ({
        shelfRenderer: { content: { horizontalListRenderer: { items } } },
    });
    // A tile shaped like the ones YouTube actually sends: every one of the 223
    // default tiles in the captured browse responses arrived WITH a server menu,
    // so this is the live path -- and until now no fixture had ever given a tile
    // one, so only the synthesise branch was ever exercised.
    const servedTile = (id, channelId) => {
        const t = videoTile(id);
        t.tileRenderer.onLongPressCommand = {
            showMenuCommand: {
                contentId: id,
                title: { simpleText: id },
                subtitle: { simpleText: `A Channel \u2022 @achannel` },
                menu: {
                    menuRenderer: {
                        items: [
                            {
                                menuNavigationItemRenderer: {
                                    text: { runs: [{ text: 'Play' }] },
                                    navigationEndpoint: { watchEndpoint: { videoId: id } },
                                },
                            },
                            {
                                menuNavigationItemRenderer: {
                                    text: { runs: [{ text: 'Go to channel' }] },
                                    navigationEndpoint: { browseEndpoint: { browseId: channelId } },
                                },
                            },
                        ],
                    },
                },
            },
        };
        return t;
    };
    const body = JSON.stringify({
        contents: {
            sectionListRenderer: {
                contents: [
                    shelf([videoTile('keep')]),
                    // Every item here is a promoted tile, so the ad rules empty the list and
                    // leave a heading above a blank strip.
                    shelf([{ adSlotRenderer: {} }, { adSlotRenderer: {} }]),
                ],
            },
        },
    });
    // Count re-entry. The tile helpers clone with JSON.parse(JSON.stringify(x)),
    // and after the mod patches JSON.parse that idiom means the PATCHED one -- so
    // every clone of a single tile ran the whole response pass again: the ad
    // prune, the shelf walk, DeArrow. The `processed` WeakSet cannot stop it
    // either, because a clone is by definition an object it has never seen. The
    // wrapper goes on AFTER the mod's, so it counts only what the mod itself
    // calls while handling this payload.
    const patched = JSON.parse;
    let reentries = 0;
    JSON.parse = function (...a) {
        reentries++;
        return patched.apply(this, a);
    };

    const parsed = await new Response(body).json();
    JSON.parse = patched;
    const shelves = parsed.contents.sectionListRenderer.contents;
    const tile =
        shelves[0]?.shelfRenderer?.content?.horizontalListRenderer?.items?.[0]?.tileRenderer;

    // The tiles a shelf pages in as you scroll along it arrive as their own
    // response, and that path never got previews at all -- so they worked for the
    // first screenful of each shelf and silently stopped.
    // The append branch, end to end through the real bundle.
    const served = await new Response(
        JSON.stringify({
            contents: {
                sectionListRenderer: { contents: [shelf([servedTile('served', 'UCtest123')])] },
            },
        }),
    ).json();
    const servedMenu =
        served.contents.sectionListRenderer.contents[0].shelfRenderer.content.horizontalListRenderer
            .items[0].tileRenderer.onLongPressCommand.showMenuCommand.menu.menuRenderer.items;

    const continued = await new Response(
        JSON.stringify({
            continuationContents: { horizontalListContinuation: { items: [videoTile('later')] } },
        }),
    ).json();
    const gridded = await new Response(
        JSON.stringify({
            continuationContents: { gridContinuation: { items: [videoTile('grid')] } },
        }),
    ).json();

    const rowText = (r) =>
        (r.menuServiceItemRenderer || r.menuNavigationItemRenderer)?.text?.runs?.[0]?.text || '';
    const rowEndpoints = (r) =>
        Object.keys(
            (r.menuServiceItemRenderer || r.menuNavigationItemRenderer)?.serviceEndpoint || {},
        ).filter((k) => k !== 'clickTrackingParams');

    return {
        shelfCount: shelves.length,
        reentries,
        servedRowCount: servedMenu.length,
        servedKeepsServerRows: servedMenu.slice(0, 2).map(rowText).join('|'),
        servedAddedRows: servedMenu.slice(2).map(rowText),
        // Every appended row must ride an endpoint the app will render, or it is
        // dropped with nothing on screen to say so.
        servedAddedEndpoints: servedMenu
            .slice(2)
            .map(rowEndpoints)
            .map((e) => e.join(',')),
        // The synthesise branch must NOT run on a tile that already has a menu.
        servedNotOverwritten:
            !!served.contents.sectionListRenderer.contents[0].shelfRenderer.content
                .horizontalListRenderer.items[0].tileRenderer.onLongPressCommand.showMenuCommand
                .contentId,
        continuationHasPreview:
            !!continued.continuationContents.horizontalListContinuation.items[0].tileRenderer
                .onFocusCommand?.startInlinePlaybackCommand,
        gridHasPreview:
            !!gridded.continuationContents.gridContinuation.items[0].tileRenderer.onFocusCommand
                ?.startInlinePlaybackCommand,
        hasPreview: !!tile?.onFocusCommand?.startInlinePlaybackCommand,
        duration: tile?.onFocusCommand?.startInlinePlaybackCommand?.durationMs,
        endpointVideoId:
            tile?.onFocusCommand?.startInlinePlaybackCommand?.playbackEndpoint?.watchEndpoint
                ?.videoId,
        // The clone must not be the same object as the select command, or the app
        // mutating one would mutate both.
        endpointIsCopy:
            tile?.onFocusCommand?.startInlinePlaybackCommand?.playbackEndpoint !==
            tile?.onSelectCommand,
    };
});

console.log('\nA home payload, read the way the app reads one:');
check('a video tile gains the inline playback command', home.hasPreview, true);
check('  ...with a real duration', typeof home.duration === 'number' && home.duration > 0, true);
check("  ...aimed at that tile's own video", home.endpointVideoId, 'keep');
check('  ...through a clone, not the select command itself', home.endpointIsCopy, true);
check('the shelf every filter emptied is dropped', home.shelfCount, 1);
check('tiles paged into a shelf get previews too', home.continuationHasPreview, true);
check('  ...and so do grid continuations', home.gridHasPreview, true);
// Response.json parses internally, so the mod's own JSON.parse should not be
// touched at all while handling this payload. Anything above zero is a tile
// clone re-entering the whole pass.
check('cloning a tile does not re-run the response pass', home.reentries, 0);

console.log('\nThe append branch -- what runs on every real tile:');
check("the server's own rows are kept", home.servedKeepsServerRows, 'Play|Go to channel');
check('  ...and its showMenuCommand is not overwritten', home.servedNotOverwritten, true);
check('three rows are appended', home.servedAddedRows.length, 3);
check('  ...Add to Queue first', home.servedAddedRows[0], 'Add to Queue');
check(
    '  ...then the two suppression rows',
    home.servedAddedRows.slice(1).every((t) => /Hide this video|recommend/.test(t)),
    true,
);
// A row carrying anything outside the app's six-endpoint allowlist renders as
// nothing at all. playlistEditEndpoint is the one the mod already rides.
check(
    'every appended row rides a renderable endpoint',
    home.servedAddedEndpoints.every((e) => e === 'playlistEditEndpoint'),
    true,
);

// A non-JSON body must still behave like a Response.
const nonJson = await page.evaluate(async () => {
    try {
        await new Response('not json').json();
        return 'resolved';
    } catch (e) {
        return 'rejected';
    }
});
check('a non-JSON body still rejects', nonJson, 'rejected');

console.log('\nAfter the DOM exists and the deferred work has run:');
check('TizenTube stylesheet applied', late.ttStyle, true);
check('theme panel built', late.panel, true);

// --- the same injection, with a registry that is not the registry -----------
// window._yttv is YouTube's own module map. The mod finds it by looking for an
// entry with a `mappings` property -- but other objects carry that name too, and
// calling .get() on one of them throws. At late injection the module bodies run
// synchronously, so a throw there aborts every module imported after it: ad
// blocking, SponsorBlock, the stylesheet and the settings panel all disappear
// while the app still launches and looks normal. That is the shape of
// "adblocking not working on launch".
const page2 = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors2 = [];
page2.on('pageerror', (e) => errors2.push(String(e.message || e)));
await page2.route('**/tv*', (route) =>
    route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><html><head><title>YouTube</title>
<script>window._yttv = { decoy: { mappings: { notAGetter: true } } };</script>
</head><body><div id="container"></div>
<video></video><script src="/tizentube/userScript.js"></script></body></html>`,
    }),
);
await page2.route('**/tizentube/userScript.js', (route) =>
    route.fulfill({
        status: 200,
        contentType: 'application/javascript; charset=utf-8',
        body: bundle,
    }),
);
await page2.goto('https://www.youtube.com/tv', { waitUntil: 'load' });
await page2.waitForTimeout(3000);

const hostile = await page2.evaluate(() => ({
    jsonPatched: JSON.parse.toString().indexOf('native code') === -1,
    hasQueue: !!window.queuedVideos,
    sponsorblock: 'sponsorblock' in window,
    ttStyle: [...document.querySelectorAll('style')].some((s) =>
        s.textContent.includes('ytaf-ui-container'),
    ),
    panel: !!document.querySelector('.ytaf-ui-container'),
}));

console.log('\nWith a decoy _yttv entry present before the bundle runs:');
check('no uncaught errors', errors2.length, 0);
if (errors2.length) errors2.slice(0, 6).forEach((e) => console.log('        ' + e));
check('ad blocking still installed (JSON.parse replaced)', hostile.jsonPatched, true);
check('SponsorBlock still loaded', hostile.sponsorblock, true);
check('queue global still installed', hostile.hasQueue, true);
check('stylesheet still applied', hostile.ttStyle, true);
check('theme panel still built', hostile.panel, true);

// --- injected after load, which is where a module-scope throw is fatal ------
// The scenario above still runs the bundle while the parser is working, so
// readyState is 'loading' and pipLoad goes on the load listener -- a throw there
// is contained. Injected AFTER load, readyState is 'complete' and pipLoad runs
// synchronously at module scope, where a throw aborts every module imported
// after it. pictureInPicture is the ninth of thirty-nine, so that is most of
// the mod: no ad blocking, no SponsorBlock, no stylesheet, no settings panel,
// on an app that launches and looks perfectly normal.
const page3 = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors3 = [];
page3.on('pageerror', (e) => errors3.push(String(e.message || e)));
await page3.route('**/tv*', (route) =>
    route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><html><head><title>YouTube</title>
<script>window._yttv = { decoy: { mappings: { notAGetter: true } } };</script>
</head><body><div id="container"></div><video></video></body></html>`,
    }),
);
await page3.goto('https://www.youtube.com/tv', { waitUntil: 'load' });
await page3.evaluate((src) => {
    const s = document.createElement('script');
    s.textContent = src;
    document.head.appendChild(s);
}, bundle);
await page3.waitForTimeout(3000);

const after = await page3.evaluate(() => ({
    readyState: document.readyState,
    jsonPatched: JSON.parse.toString().indexOf('native code') === -1,
    sponsorblock: 'sponsorblock' in window,
    hasQueue: !!window.queuedVideos,
    ttStyle: [...document.querySelectorAll('style')].some((s) =>
        s.textContent.includes('ytaf-ui-container'),
    ),
}));

console.log(
    '\nInjected after load, with the same decoy (module bodies run at readyState complete):',
);
check('the document really was complete', after.readyState, 'complete');
check('no uncaught errors', errors3.length, 0);
if (errors3.length) errors3.slice(0, 6).forEach((e) => console.log('        ' + e));
check('ad blocking survived', after.jsonPatched, true);
check('SponsorBlock survived', after.sponsorblock, true);
check('the modules after PiP still ran', after.hasQueue, true);
check('the stylesheet survived', after.ttStyle, true);

// --- the filters that need a setting turned on ------------------------------
// mods/config.ts reads localStorage ONCE at module scope, so a config-dependent
// filter can only be exercised by a page whose storage was seeded before the
// bundle ran. This is the only way to prove the WIRING as opposed to the
// predicate: a harness that drives hasMembersOnlyBadge() directly still passes
// with the call site deleted.
const seeded = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const seedErrors = [];
seeded.on('pageerror', (e) => seedErrors.push(String(e.message || e)));
await seeded.route('**/tv*', (route) =>
    route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><html><head><title>YouTube</title>
<script>localStorage['ytaf-configuration'] = JSON.stringify({
  hideMembersOnlyVideos: true,
  enableHideRecommendations: true,
  hiddenChannels: ['UCblocked A Blocked Channel'],
  enableAiSList: true,
});
// The AiSList cache, in its own key -- deliberately NOT in the config blob,
// which is rewritten wholesale on every settings change. Handles are stored
// percent-decoded and case-folded, which is what the parser writes.
localStorage['tizentube.aislist'] = JSON.stringify({
  block: JSON.stringify({ h: ['@aislopper'], i: [], m: '2026-07-19' }),
  fetchedAt: Date.now(),
});</script></head><body><div id="container"></div>
<video></video><script src="/tizentube/userScript.js"></script></body></html>`,
    }),
);
await seeded.route('**/tizentube/userScript.js', (route) =>
    route.fulfill({
        status: 200,
        contentType: 'application/javascript; charset=utf-8',
        body: bundle,
    }),
);
await seeded.goto('https://www.youtube.com/tv', { waitUntil: 'load' });
await seeded.waitForTimeout(1500);

const filtered = await seeded.evaluate(async () => {
    const line = (badge) => ({
        lineRenderer: {
            items: [
                ...(badge
                    ? [{ lineItemRenderer: { badge: { metadataBadgeRenderer: { style: badge } } } }]
                    : []),
                { lineItemRenderer: { text: { simpleText: 'A Channel' } } },
            ],
        },
    });
    const tile = (id, badge, channelId, subtitle) => ({
        tileRenderer: {
            style: 'TILE_STYLE_YTLR_DEFAULT',
            contentId: id,
            onSelectCommand: { watchEndpoint: { videoId: id } },
            header: {
                tileHeaderRenderer: {
                    thumbnail: { thumbnails: [{ url: 'u', width: 480, height: 360 }] },
                },
            },
            metadata: { tileMetadataRenderer: { title: { simpleText: id }, lines: [line(badge)] } },
            ...(channelId || subtitle
                ? {
                      onLongPressCommand: {
                          showMenuCommand: {
                              contentId: id,
                              subtitle: { simpleText: subtitle || 'A Channel \u2022 @achannel' },
                              menu: {
                                  menuRenderer: {
                                      items: channelId
                                          ? [
                                                {
                                                    menuNavigationItemRenderer: {
                                                        text: { runs: [{ text: 'Go to channel' }] },
                                                        navigationEndpoint: {
                                                            browseEndpoint: { browseId: channelId },
                                                        },
                                                    },
                                                },
                                            ]
                                          : [],
                                  },
                              },
                          },
                      },
                  }
                : {}),
        },
    });
    const body = JSON.stringify({
        contents: {
            sectionListRenderer: {
                contents: [
                    {
                        shelfRenderer: {
                            content: {
                                horizontalListRenderer: {
                                    items: [
                                        tile('keep', null, null),
                                        tile('members', 'BADGE_STYLE_TYPE_MEMBERS_ONLY', null),
                                        tile('blocked', null, 'UCblocked'),
                                        tile('otherchan', null, 'UCallowed'),
                                        // Identified only by its @handle, which is what AiSList entries are:
                                        // measured, both published files are 100% handles and zero channel ids.
                                        tile(
                                            'aislop',
                                            null,
                                            null,
                                            'An AI Channel \u2022 @AiSlopper',
                                        ),
                                    ],
                                },
                            },
                        },
                    },
                ],
            },
        },
    });
    const parsed = await new Response(body).json();
    const items =
        parsed.contents.sectionListRenderer.contents[0].shelfRenderer.content.horizontalListRenderer
            .items;
    return items.map((i) => i.tileRenderer.contentId);
});

console.log('\nWith the filters switched on, through the real bundle:');
check('no uncaught errors on the seeded page', seedErrors.length, 0);
if (seedErrors.length) seedErrors.slice(0, 4).forEach((e) => console.log('        ' + e));
check('the members-only tile is dropped', filtered.includes('members'), false);
check('the hidden channel is dropped', filtered.includes('blocked'), false);
check('an ordinary tile survives', filtered.includes('keep'), true);
check('  ...and so does a different channel', filtered.includes('otherchan'), true);
// Matched by @handle alone, case-insensitively: the tile says "@AiSlopper" and
// the stored list says "@aislopper".
check('a channel on the AiSList is dropped', filtered.includes('aislop'), false);
check('exactly two tiles remain', filtered.length, 2);

// LAST, after every check. It used to sit above the seeded page, so this
// harness -- the only end-to-end proof that the three config-gated filters are
// actually WIRED UP -- printed its ALL PASS banner and then printed the
// failures underneath it. The exit code was right; the transcript was not, and
// the transcript is what anyone reading a suite run actually sees.
console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS');

await browser.close();
process.exit(fail ? 1 : 0);
