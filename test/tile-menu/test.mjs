// The long-press menu's suppression rows, against real tiles.
//
// fixtures.json is lifted verbatim out of captured tvhtml5 browse responses
// (per-session tracking fields stripped), so what is asserted here is what
// YouTube actually sends rather than a shape invented to suit the code. Three of
// the four fixtures exist because the captures proved the case is real:
//
//   withChannelId   a topic-page tile: UC id AND @handle both present
//   handleOnly      a tile from a channel's OWN page, where the app omits its
//                   "Go to channel" row -- 0 of 175 such tiles yield a UC id
//   noChannelKey    one of the 5 of 175 whose subtitle tail is a series name
//                   ("Marques Brownlee • Retro Tech: Flying Cars"), not a handle
//   nonDefaultStyle a playlist tile, TILE_STYLE_YTLR_VERTICAL_LIST
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checker } from '../lib/repo.mjs';
import {
    menuItems,
    hasFeedbackRow,
    channelIdFromMenu,
    handleFromSubtitle,
    handleFromCanonicalUrl,
    channelFromMetadata,
    tileIdentity,
    channelKey,
    channelEntry,
    parseEntry,
    isChannelHidden,
    isVideoHidden,
    addEntry,
    tileIsHidden,
    offeredRows,
    MAX_HIDDEN,
    RENDERABLE_SERVICE_ENDPOINTS,
} from './tileMenu.generated.mts';

const { check, done } = checker();
const F = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures.json'), 'utf8'),
);

// --- the app's renderability filter -----------------------------------------
// A menuServiceItemRenderer whose serviceEndpoint is not one of these six is
// dropped by the app with nothing on screen to say so. playlistEditEndpoint is
// the one ADD_TO_QUEUE already rides, which is why the new rows ride it too.
check('the endpoint allowlist is recorded', RENDERABLE_SERVICE_ENDPOINTS.length, 6);
check(
    '  ...and includes the vehicle the mod uses',
    RENDERABLE_SERVICE_ENDPOINTS.includes('playlistEditEndpoint'),
    true,
);
check(
    '  ...and feedbackEndpoint, for when the server ever sends one',
    RENDERABLE_SERVICE_ENDPOINTS.includes('feedbackEndpoint'),
    true,
);

// --- real tiles: what is actually extractable -------------------------------
const withId = tileIdentity(F.withChannelId);
check(
    'a topic tile yields a video id',
    typeof withId.videoId === 'string' && withId.videoId.length > 0,
    true,
);
check('  ...a UC channel id', /^UC/.test(withId.channel.id), true);
check('  ...a handle', /^@/.test(withId.channel.handle), true);
check(
    '  ...and a display name',
    typeof withId.channel.name === 'string' && withId.channel.name.length > 0,
    true,
);

// The app does not offer "Go to channel" on a channel's own page, so the UC id
// is simply absent there -- 0 of 175 tiles in that capture had one.
const handleOnly = tileIdentity(F.handleOnly);
check('a tile on a channel page has no UC id', handleOnly.channel.id, undefined);
check('  ...but still has a handle to match on', /^@/.test(handleOnly.channel.handle), true);
check(
    '  ...so it is still matchable',
    channelKey(handleOnly.channel) === handleOnly.channel.handle,
    true,
);

// The five-in-175 case: a series name after the bullet, not a handle.
const noKey = tileIdentity(F.noChannelKey);
check('a series-name subtitle yields no channel key', channelKey(noKey.channel), null);
check(
    '  ...and the channel row is therefore not offered',
    offeredRows(F.noChannelKey, true).channel,
    false,
);
// Losing the channel row is right; losing the video row would not be.
check('  ...while the video row still is', offeredRows(F.noChannelKey, true).video, true);

// --- the subtitle parse -----------------------------------------------------
check(
    'a handle is read off the subtitle',
    handleFromSubtitle('Brawl Stars • @BrawlStars'),
    '@BrawlStars',
);
check(
    'a series name is rejected',
    handleFromSubtitle('Marques Brownlee • Retro Tech: Flying Cars'),
    null,
);
check('a name containing a bullet still parses', handleFromSubtitle('A • B • @chan'), '@chan');
check('no bullet yields null', handleFromSubtitle('Just A Name'), null);
check('null yields null', handleFromSubtitle(null), null);
check('an empty tail yields null', handleFromSubtitle('Name • '), null);
check('a bare @ is not a handle', handleFromSubtitle('Name • @'), null);

// --- menu site precedence ---------------------------------------------------
// The app prefers tileRenderer.menu and falls back to the showMenuCommand's, so
// appending to the second on a tile that has both adds rows nothing renders.
check('the showMenuCommand menu is found', Array.isArray(menuItems(F.withChannelId)), true);
const bothMenus = JSON.parse(JSON.stringify(F.withChannelId));
bothMenus.menu = { menuRenderer: { items: [{ marker: true }] } };
check('a tile-level menu outranks the showMenuCommand one', menuItems(bothMenus)[0].marker, true);
check('no menu at all yields null', menuItems({ contentId: 'x' }), null);
check('null yields null', menuItems(null), null);

// --- standing down for the server -------------------------------------------
// Not one of the 223 real tiles carried a feedback token, so this is the
// forward-compatibility hinge rather than a live path -- which is exactly why it
// has to be asserted rather than assumed.
check('no real tile carries a feedback row', hasFeedbackRow(menuItems(F.withChannelId)), false);
const withFeedback = JSON.parse(JSON.stringify(F.withChannelId));
withFeedback.onLongPressCommand.showMenuCommand.menu.menuRenderer.items.push({
    menuServiceItemRenderer: {
        text: { runs: [{ text: 'Not interested' }] },
        serviceEndpoint: { feedbackEndpoint: { feedbackToken: 'FAKE' } },
    },
});
check('a server feedback row is detected', hasFeedbackRow(menuItems(withFeedback)), true);
check(
    '  ...and the mod then offers nothing of its own',
    JSON.stringify(offeredRows(withFeedback, true)),
    JSON.stringify({ video: false, channel: false }),
);

// --- the stored form --------------------------------------------------------
check(
    'an entry is "<key> <name>"',
    channelEntry({ id: 'UC1', name: 'A Channel' }),
    'UC1 A Channel',
);
check(
    'the id wins over the handle as key',
    channelEntry({ id: 'UC1', handle: '@a', name: 'N' }),
    'UC1 N',
);
check('a handle is the key when there is no id', channelEntry({ handle: '@a', name: 'N' }), '@a N');
check('no key yields no entry', channelEntry({ name: 'only a name' }), null);
check('null yields no entry', channelEntry(null), null);
check('a nameless channel stores its key as the label', channelEntry({ id: 'UC1' }), 'UC1 UC1');
check('a name with spaces round-trips', parseEntry('UC1 A Long Name').name, 'A Long Name');
check('  ...and its key', parseEntry('UC1 A Long Name').key, 'UC1');

// --- matching ---------------------------------------------------------------
check('matches on id', isChannelHidden({ id: 'UC1' }, ['UC1 A']), true);
check('matches on handle', isChannelHidden({ handle: '@a' }, ['@a A']), true);
check(
    'matches on either when both are known',
    isChannelHidden({ id: 'UC1', handle: '@a' }, ['@a A']),
    true,
);
// The whole reason a display name is stored but never matched on: two channels
// share a name far more often than they share an id or a handle.
// The real collision this shape exists to prevent: a stored entry whose KEY
// happens to read like another channel's display name. Comparing names would
// hide a channel the user never chose -- and "News" is exactly the kind of name
// several channels share.
check(
    'a DISPLAY NAME is never compared against a stored key',
    isChannelHidden({ id: 'UC1', name: 'News' }, ['News Some Other Channel']),
    false,
);
check(
    '  ...nor when it is the only thing known about the channel',
    isChannelHidden({ name: 'News' }, ['UC9 News']),
    false,
);
check('an unrelated channel does not match', isChannelHidden({ id: 'UC2' }, ['UC1 A']), false);
check('an empty list matches nothing', isChannelHidden({ id: 'UC1' }, []), false);
check('null channel matches nothing', isChannelHidden(null, ['UC1 A']), false);
check('junk entries are skipped', isChannelHidden({ id: 'UC1' }, [null, 42, {}, 'UC1 A']), true);

check('a video matches by id', isVideoHidden('abc', ['abc Some Title']), true);
check('  ...and not by title', isVideoHidden('Some', ['abc Some Title']), false);
check('an empty id matches nothing', isVideoHidden('', ['abc T']), false);

// --- the lists stay bounded -------------------------------------------------
check('an entry is added', addEntry([], 'UC1 A'), ['UC1 A']);
check('a duplicate key is not re-added', addEntry(['UC1 A'], 'UC1 A Different Name').length, 1);
check('junk is not added', addEntry(['UC1 A'], null).length, 1);
check('an empty entry is not added', addEntry(['UC1 A'], '').length, 1);
let bulk = [];
for (let i = 0; i < MAX_HIDDEN + 25; i++) bulk = addEntry(bulk, `UC${i} Channel ${i}`);
check('the list stays bounded', bulk.length, MAX_HIDDEN);
check('  ...evicting the oldest', bulk[0], `UC25 Channel 25`);
check(
    '  ...and keeping the newest',
    bulk[bulk.length - 1],
    `UC${MAX_HIDDEN + 24} Channel ${MAX_HIDDEN + 24}`,
);

// --- filtering a shelf ------------------------------------------------------
check(
    'a hidden channel hides its tile',
    tileIsHidden(F.withChannelId, [], [channelEntry(withId.channel)]),
    true,
);
check(
    '  ...by handle too',
    tileIsHidden(F.handleOnly, [], [`${handleOnly.channel.handle} whatever`]),
    true,
);
check(
    'a hidden video hides its tile',
    tileIsHidden(F.withChannelId, [`${withId.videoId} T`], []),
    true,
);
check('an unrelated tile is kept', tileIsHidden(F.withChannelId, ['zzz T'], ['UC9 Other']), false);
check('empty lists keep everything', tileIsHidden(F.withChannelId, [], []), false);

// --- the master toggle ------------------------------------------------------
check(
    'disabled offers no rows',
    JSON.stringify(offeredRows(F.withChannelId, false)),
    JSON.stringify({ video: false, channel: false }),
);

// --- playlist tiles ---------------------------------------------------------
// adblock.ts skips any tile that is not TILE_STYLE_YTLR_DEFAULT, so the whole
// feature is absent on playlist surfaces. Recorded so it is a known limit rather
// than a surprise.
check(
    'a playlist tile is not the default style',
    F.nonDefaultStyle.style,
    'TILE_STYLE_YTLR_VERTICAL_LIST',
);

// --- the watch page ---------------------------------------------------------
// watchPivot is lifted from a real watchNext capture. Every one of the 33 pivot
// tiles in that up-next rail arrives with NO menu and NO showMenuCommand, so the
// two identity sources this file started with return null for all of them: hide
// a channel from the home feed and its videos kept appearing in the rail beside
// every video you played, with no way to hide it from there either.
check('a pivot tile has no menu at all', menuItems(F.watchPivot), null);
check(
    '  ...and no showMenuCommand subtitle',
    F.watchPivot.onLongPressCommand?.showMenuCommand?.subtitle?.simpleText ?? null,
    null,
);
check('  ...so the menu yields no channel id', channelIdFromMenu(menuItems(F.watchPivot)), null);

const pivot = tileIdentity(F.watchPivot);
check(
    'the metadata line still identifies the channel',
    pivot.channel?.id,
    'UC8NQC017i8Z0FLoet8G6bvw',
);
check('  ...and the video is still read', pivot.videoId, 'XArc1QjsXJg');
check(
    '  ...so a hidden channel is now dropped there',
    tileIsHidden(F.watchPivot, [], ['UC8NQC017i8Z0FLoet8G6bvw Nadir trs']),
    true,
);
check('  ...and the channel row is offered', offeredRows(F.watchPivot, true).channel, true);

// canonicalBaseUrl is percent-encoded in the payload. It has to be decoded to
// match AiSList, which stores handles in their decoded form -- and this real
// tile's handle is Arabic, so it is also the case the old ASCII-only regex
// silently dropped.
check(
    'the canonical url yields a decoded handle',
    handleFromCanonicalUrl('/@%D9%86%D8%AF%D9%8A%D8%B1-%D8%AA%D8%B1%D8%B3'),
    '@\u0646\u062f\u064a\u0631-\u062a\u0631\u0633',
);
check('  ...and this tile carries one', typeof pivot.channel?.handle, 'string');
// A malformed escape yields NO handle, deliberately, and this differs from
// aisListParse.normaliseHandle, which keeps the raw string. The asymmetry is the
// right way round: a list entry that cannot be decoded is inert either way, but
// a TILE is matched against the user's own lists, so letting unvalidated text
// out of a corrupt payload become a matching key is a risk with no upside. The
// tile still yields its UC id, so no identity is lost here.
check('a malformed escape yields no handle', handleFromCanonicalUrl('/@bad%zz'), null);
check(
    '  ...and the id is what carries the tile instead',
    tileIdentity(F.watchPivot).channel?.id,
    'UC8NQC017i8Z0FLoet8G6bvw',
);
check('a url with no handle yields null', handleFromCanonicalUrl('/channel/UCabc'), null);
check('junk yields null', handleFromCanonicalUrl(null), null);

// --- non-ASCII handles ------------------------------------------------------
// 473 of the 20,982 real AiSList entries are non-ASCII once decoded. An
// ASCII-only class rejected every one, so aisListParse's decoding of both sides
// could never be reached for them.
check(
    'a German handle is a handle',
    handleFromSubtitle(
        'Langweilige W\u00e4hrung \u2022 @Langweilige W\u00e4hrung'.replace(
            ' @Langweilige W\u00e4hrung',
            ' @Langweilige'.replace(' ', '') + 'W\u00e4hrung',
        ),
    ),
    '@LangweiligeW\u00e4hrung',
);
check(
    'a Polish handle is a handle',
    handleFromSubtitle('Kana\u0142 Poznawczy \u2022 @Kana\u0142Poznawczy'),
    '@Kana\u0142Poznawczy',
);
check(
    'a Korean handle is a handle',
    handleFromSubtitle(
        '\uc18c\uc18c\ud55c\uc791\uc5c5\uc2e4 \u2022 @\uc18c\uc18c\ud55c\uc791\uc5c5\uc2e4-z8d',
    ),
    '@\uc18c\uc18c\ud55c\uc791\uc5c5\uc2e4-z8d',
);
// The space is what actually separates a handle from a series name, and widening
// the letter class must not have widened that.
check(
    'a series name is still not a handle',
    handleFromSubtitle('Marques Brownlee \u2022 Retro Tech: Flying Cars'),
    null,
);

// --- a channel's own tile ---------------------------------------------------
// channelRound is a real TILE_STYLE_YTLR_ROUND tile: its whole subtitle is the
// bare handle, with no bullet. Requiring the bullet meant AiSList dropped such a
// channel's videos and left the channel itself in the Channels shelf.
check('a bare subtitle is the handle', handleFromSubtitle('@TheStudio'), '@TheStudio');
check('  ...on the real tile too', tileIdentity(F.channelRound).channel?.handle, '@TheStudio');
check(
    '  ...so the AiSList handle path can reach it',
    tileIsHidden(F.channelRound, [], ['@thestudio The Studio']),
    false,
);
check(
    '  ...and an exact handle entry hides it',
    tileIsHidden(F.channelRound, [], ['@TheStudio The Studio']),
    true,
);

// The cheap sources still win when they are present, so an ordinary home tile
// does not pay for the metadata walk.
check(
    'the menu id still wins when there is one',
    tileIdentity(F.withChannelId).channel?.id,
    channelIdFromMenu(menuItems(F.withChannelId)),
);
check('channelFromMetadata on a tile without one', channelFromMetadata(F.noChannelKey), null);

// --- junk -------------------------------------------------------------------
// Every one of these runs inside JSON.parse for every response the app parses;
// a throw is swallowed by adblock.ts's catch and costs the whole payload's pass.
let threw = null;
const JUNK = [null, undefined, 0, '', 'str', [], {}, [null], NaN, true];
for (const fn of [
    menuItems,
    hasFeedbackRow,
    channelIdFromMenu,
    handleFromSubtitle,
    handleFromCanonicalUrl,
    channelFromMetadata,
    tileIdentity,
    channelKey,
    channelEntry,
    isVideoHidden,
]) {
    for (const v of JUNK) {
        try {
            fn(v);
        } catch (e) {
            threw = `${fn.name}(${JSON.stringify(v)}) threw ${e.message}`;
        }
    }
}
for (const v of JUNK) {
    try {
        isChannelHidden(v, v);
        tileIsHidden(v, v, v);
        offeredRows(v, true);
        addEntry(v, v);
        parseEntry(v);
    } catch (e) {
        threw = `${JSON.stringify(v)} threw ${e.message}`;
    }
}
check('no exported function throws on junk', threw, null);

done();
