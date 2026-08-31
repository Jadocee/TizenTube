// The remembered caption preference.
//
// The commands asserted here are the app's own, read out of the shipped bundle.
// CaptionsService handles selectSubtitlesTrackCommand with three named arms and
// falls through to a fourth:
//
//   if (subtitlesTrackMetadata) ... else if (useDefaultTrack) ...
//   else if (translationLanguage) ... else a.sl({}), a.IB(!1)
//
// So an EMPTY payload is captions-off and `useDefaultTrack` is captions-on.
// Those two shapes are the whole interface, which is why they are asserted
// exactly rather than loosely.
import { checker } from '../lib/repo.mjs';
import {
    commandFor, captionsOnCommand, captionsOffCommand,
    preferenceFor, listHasChannel, parseEntry, shouldApply,
} from './captionPrefs.generated.mts';

const { check, done } = checker();

// --- the two commands -------------------------------------------------------
check('on uses the default track',
      JSON.stringify(captionsOnCommand()), '{"selectSubtitlesTrackCommand":{"useDefaultTrack":true}}');
// The off case is an empty payload, NOT a null track or a toggle signal. A
// payload carrying any of the three named fields would take a different arm.
check('off is an empty payload',
      JSON.stringify(captionsOffCommand()), '{"selectSubtitlesTrackCommand":{}}');
check('  ...carrying none of the named arms',
      Object.keys(captionsOffCommand().selectSubtitlesTrackCommand).length, 0);
check('leave issues nothing at all', commandFor('leave'), null);
check('junk issues nothing', commandFor('nonsense'), null);
check('on maps to the on command', JSON.stringify(commandFor('on')), JSON.stringify(captionsOnCommand()));
check('off maps to the off command', JSON.stringify(commandFor('off')), JSON.stringify(captionsOffCommand()));

// --- precedence -------------------------------------------------------------
const chan = { id: 'UC1', handle: '@a' };
check('no entry falls back to the global default',
      preferenceFor({ globalDefault: 'on', channel: chan }), 'on');
check('  ...including leave', preferenceFor({ globalDefault: 'leave', channel: chan }), 'leave');
check('a per-channel ON beats a global off',
      preferenceFor({ globalDefault: 'off', onChannels: ['UC1 A'], channel: chan }), 'on');
check('a per-channel OFF beats a global on',
      preferenceFor({ globalDefault: 'on', offChannels: ['UC1 A'], channel: chan }), 'off');
// Two independent arrays; nothing stops a determined user putting a channel in
// both, so the tie needs a deterministic answer rather than read order.
check('a channel in both lists resolves to on',
      preferenceFor({ globalDefault: 'off', onChannels: ['UC1 A'], offChannels: ['UC1 A'], channel: chan }), 'on');
check('an unknown channel uses the default',
      preferenceFor({ globalDefault: 'off', onChannels: ['UC9 Other'], channel: chan }), 'off');
check('no channel at all uses the default',
      preferenceFor({ globalDefault: 'on', onChannels: ['UC1 A'], channel: null }), 'on');
check('a junk default degrades to leave',
      preferenceFor({ globalDefault: 'banana', channel: chan }), 'leave');
check('null input is leave', preferenceFor(null), 'leave');

// --- matching ---------------------------------------------------------------
check('matches on id', listHasChannel(['UC1 A'], { id: 'UC1' }), true);
check('matches on handle', listHasChannel(['@a A'], { handle: '@a' }), true);
// YouTube treats handles case-insensitively, and a stored entry can have been
// captured with different casing from the tile that later has to match it.
check('  ...case-insensitively', listHasChannel(['@Chan A'], { handle: '@chan' }), true);
check('a display name is never a key', listHasChannel(['News Other'], { id: 'UC1', name: 'News' }), false);
check('an empty list matches nothing', listHasChannel([], { id: 'UC1' }), false);
check('junk entries are skipped', listHasChannel([null, 7, 'UC1 A'], { id: 'UC1' }), true);
check('a name with spaces round-trips', parseEntry('UC1 A Long Name').name, 'A Long Name');

// --- applied once per video -------------------------------------------------
// A preference that re-asserted itself would fight someone who turns captions
// off ten seconds in, and on a TV that is a fight the user loses.
check('a new video is applied', shouldApply('abc', null), true);
check('the same video is not applied twice', shouldApply('abc', 'abc'), false);
check('a different video is', shouldApply('def', 'abc'), true);
check('no video id is never applied', shouldApply('', null), false);
check('a non-string id is never applied', shouldApply(null, null), false);

// --- junk -------------------------------------------------------------------
let threw = null;
for (const v of [null, undefined, 0, '', 'str', [], {}, NaN, true]) {
    try { preferenceFor(v); listHasChannel(v, v); parseEntry(v); shouldApply(v, v); commandFor(v); }
    catch (e) { threw = `${JSON.stringify(v)} threw ${e.message}`; }
}
check('junk never throws', threw, null);

done();
