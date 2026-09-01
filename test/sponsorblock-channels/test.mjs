// The per-channel SponsorBlock opt-out.
//
// The channel is only visible in the player response, which arrives on its own
// schedule relative to the hashchange that starts a SponsorBlock handler. So the
// interesting cases are all about ordering and about entries that have gone
// stale, not about the happy path.
import { checker } from '../lib/repo.mjs';
import * as stub from './stub.mjs';
import {
    recordVideoContext,
    channelOf,
    isChannelDisabled,
    channelEntry,
    parseChannelEntry,
} from './mod.generated.mts';

const { check, done } = checker();
const response = (videoId, channelId, author) => ({ videoDetails: { videoId, channelId, author } });

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
check(
    'a response with no author falls back to the id',
    // Record then read, in the order the runtime does it: the assertion is about
    // what the second call returns after the first has run.
    // biome-ignore lint/complexity/noCommaOperator: sequenced on purpose
    (recordVideoContext(response('vid3', 'UCccc', undefined)), channelOf('vid3').name),
    'UCccc',
);

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
