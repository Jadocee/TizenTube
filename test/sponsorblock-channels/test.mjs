// The per-channel SponsorBlock opt-out, and where the channel's NAME comes from.
//
// THE BUG THIS EXISTS FOR, second edition. The settings list showed "letters and
// numbers" where a channel name belongs -- a raw UC id. The cause was that this
// module read the display name from videoDetails.author and fell back to the
// channel id when it was missing, and on tvhtml5 it is ALWAYS missing: a
// captured TVHTML5 /player response carries channelId and no author, while the
// same request body as WEB carries author. So every entry was named after its
// own id, and nothing could tell "no name known" from "the name is UC...".
//
// The name is in the WATCH-NEXT response instead, which is where the shipped TV
// app reads it. So the assertions below are about the two payloads carrying
// different halves of the answer and arriving in either order.
//
// The channel is also only visible asynchronously relative to the hashchange
// that starts a SponsorBlock handler, so ordering and stale entries matter more
// than the happy path.
import { checker } from '../lib/repo.mjs';
import * as stub from './stub.mjs';
import {
    recordVideoContext,
    channelOf,
    isChannelDisabled,
    channelEntry,
    parseChannelEntry,
    displayName,
    nameForChannel,
} from './mod.generated.mts';

const { check, done } = checker();
const response = (videoId, channelId, author) => ({ videoDetails: { videoId, channelId, author } });

/** The shape the real /next payload uses, at the path the app itself reads. */
const watchNext = (videoId, channelId, name, { depth = 0 } = {}) => ({
    contents: {
        singleColumnWatchNextResults: {
            results: {
                results: {
                    contents: [
                        // A section in front, so indexing [0] rather than
                        // looping cannot pass. The app's own extractor loops.
                        ...Array.from({ length: depth }, () => ({
                            itemSectionRenderer: { contents: [{ somethingElse: {} }] },
                        })),
                        {
                            itemSectionRenderer: {
                                contents: [
                                    {
                                        videoMetadataRenderer: {
                                            videoId,
                                            owner: {
                                                videoOwnerRenderer: {
                                                    title: { simpleText: name },
                                                    navigationEndpoint: {
                                                        browseEndpoint: { browseId: channelId },
                                                    },
                                                },
                                            },
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                },
            },
        },
    },
});

/** A Shorts body: the player response is nested and the channel is in the header. */
const reel = (videoId, channelId, handle) => ({
    playerResponse: { videoDetails: { videoId, channelId } },
    overlay: {
        reelPlayerOverlayRenderer: {
            reelPlayerHeaderSupportedRenderers: {
                reelPlayerHeaderRenderer: {
                    videoId,
                    channelTitleText: { runs: [{ text: handle }] },
                    channelNavigationEndpoint: { browseEndpoint: { browseId: channelId } },
                },
            },
        },
    },
});

// --- parsing the stored form ------------------------------------------------
// Ids never contain a space, so the first one splits id from name -- and names
// very often do contain spaces.
check(
    'a name with spaces round-trips',
    parseChannelEntry(channelEntry({ id: 'UC123', name: 'Some Channel Name' })).name,
    'Some Channel Name',
);
check('the id survives a spaced name', parseChannelEntry('UC123 Some Channel Name').id, 'UC123');
check('an entry with no name at all still yields an id', parseChannelEntry('UC123').id, 'UC123');
// ...and says it has no NAME, rather than answering with the id. A caller
// cannot repair a name it has been told it already has.
check('  ...and reports no name rather than the id', parseChannelEntry('UC123').name, '');

// --- recording --------------------------------------------------------------
recordVideoContext(response('vid1', 'UCaaa', 'Channel A'));
check('the current channel is recorded', channelOf('vid1').name, 'Channel A');
check('an unknown video falls back to the last seen', channelOf('vid-unknown').name, 'Channel A');

recordVideoContext(response('vid2', 'UCbbb', 'Channel B'));
check('a second video is recorded separately', channelOf('vid2').name, 'Channel B');
// The reason this is keyed by id rather than "the last one": the hashchange for
// one video can arrive after the player response for the next.
check('the earlier video keeps its own channel', channelOf('vid1').name, 'Channel A');

// --- junk that must not throw or poison the map -----------------------------
// This runs inside the JSON.parse hook, for every parse the page does.
const before = channelOf('vid2').id;
for (const junk of [
    null,
    undefined,
    0,
    'string',
    [],
    {},
    { videoDetails: null },
    { videoDetails: {} },
    { videoDetails: { channelId: 42 } },
    { videoDetails: { channelId: '' } },
]) {
    recordVideoContext(junk);
}
check('junk payloads leave the last good channel intact', channelOf('vid2').id, before);
for (const junk of [
    { contents: null },
    { contents: { singleColumnWatchNextResults: {} } },
    { contents: { singleColumnWatchNextResults: { results: { results: { contents: 'no' } } } } },
    { overlay: null },
    { overlay: { reelPlayerOverlayRenderer: {} } },
    { playerResponse: null },
    { playerResponse: {} },
]) {
    recordVideoContext(junk);
}
check('  ...and so do half-formed watch-next and reel bodies', channelOf('vid2').id, before);
// THE ONE THAT USED TO ASSERT THE BUG. This harness previously fed an `author`
// field the tvhtml5 client never sends and asserted that its absence fell back
// to the id -- locking in the behaviour that put a UC id on screen.
recordVideoContext(response('vid3', 'UCccc', undefined));
check('a player response with no author records no name', channelOf('vid3').name, '');
check('  ...but still records the channel', channelOf('vid3').id, 'UCccc');

// --- the watch-next response, which is where the name really is -------------
recordVideoContext(watchNext('vid4', 'UCddd', 'Channel D'));
check('the watch-next owner supplies the name', channelOf('vid4').name, 'Channel D');
check('  ...and the id with it', channelOf('vid4').id, 'UCddd');
// Indexing [0] instead of looping passes on a capture and fails on the first
// payload with a different section in front, so the fixture puts two there.
recordVideoContext(watchNext('vid5', 'UCeee', 'Channel E', { depth: 2 }));
check('a section in front does not hide it', channelOf('vid5').name, 'Channel E');

// --- the two halves, in either order ----------------------------------------
// /player carries the id and no name; /next carries both. Whichever lands
// second must not blank what the other supplied.
recordVideoContext(watchNext('vid6', 'UCfff', 'Channel F'));
recordVideoContext(response('vid6', 'UCfff', undefined));
check('a later player response does not blank the name', channelOf('vid6').name, 'Channel F');

recordVideoContext(response('vid7', 'UCggg', undefined));
check('a nameless sighting is nameless at first', channelOf('vid7').name, '');
recordVideoContext(watchNext('vid7', 'UCggg', 'Channel G'));
check('  ...and is named once the name arrives', channelOf('vid7').name, 'Channel G');
// Learned per CHANNEL, not per video: the next video from a known channel is
// named before its own watch-next response lands.
recordVideoContext(response('vid8', 'UCggg', undefined));
check('a later video inherits the learned name', channelOf('vid8').name, 'Channel G');

// --- Shorts, which recorded nothing at all ----------------------------------
// A reel body has no root videoDetails, so the old recorder returned on its
// first line and both the per-channel opt-out and the caption preference were
// inert on every Short.
recordVideoContext(reel('short1', 'UChhh', '@someone'));
check('a Short records its channel', channelOf('short1').id, 'UChhh');
check('  ...with the handle as its name', channelOf('short1').name, '@someone');

// --- what the settings row puts on screen -----------------------------------
check(
    'a real name is shown as it is',
    displayName({ id: 'UCddd', name: 'Channel D' }),
    'Channel D',
);
// The repair. Entries stored before any of the above read "<id> <id>", and that
// id is exactly what the user reported seeing.
check(
    'an id stored as a name is replaced once the name is known',
    displayName({ id: 'UCggg', name: 'UCggg' }),
    'Channel G',
);
check(
    '  ...and falls back to the id when nothing better is known',
    displayName({ id: 'UCnothing', name: 'UCnothing' }),
    'UCnothing',
);
check(
    '  ...never to an empty row, which a D-pad cannot select',
    displayName({ id: 'UCnothing', name: '' }),
    'UCnothing',
);
check('a name is learned for later reads', nameForChannel('UCggg'), 'Channel G');
check('  ...and unknown channels report none', nameForChannel('UCnothing'), '');

// --- the disabled check -----------------------------------------------------
stub.store.sponsorBlockDisabledChannels = [];
check('nothing is disabled by default', isChannelDisabled(channelOf('vid1')), false);
check('a null channel is not disabled', isChannelDisabled(null), false);

stub.store.sponsorBlockDisabledChannels = ['UCaaa Channel A'];
check('a listed channel is disabled', isChannelDisabled(channelOf('vid1')), true);
check('an unlisted channel is not', isChannelDisabled(channelOf('vid2')), false);

// Matched by id, not by the whole entry: a channel that renamed itself since it
// was added must stay disabled, or the setting silently lapses.
stub.store.sponsorBlockDisabledChannels = ['UCaaa An Old Name'];
check('a renamed channel stays disabled', isChannelDisabled(channelOf('vid1')), true);

// A name that happens to contain another id must not match it.
stub.store.sponsorBlockDisabledChannels = ['UCzzz Talking about UCaaa'];
check('an id mentioned inside a name does not match', isChannelDisabled(channelOf('vid1')), false);

stub.store.sponsorBlockDisabledChannels = 'not an array';
check('a corrupt setting does not throw', isChannelDisabled(channelOf('vid1')), false);

// --- the map is bounded -----------------------------------------------------
stub.store.sponsorBlockDisabledChannels = [];
for (let i = 0; i < 200; i++) recordVideoContext(response(`v${i}`, `UC${i}`, `Ch ${i}`));
check('the newest video is still known', channelOf('v199').name, 'Ch 199');
check('the oldest was evicted rather than accumulating', channelOf('v0').name, 'Ch 199');

done();
