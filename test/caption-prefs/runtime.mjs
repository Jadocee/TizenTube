// The caption runtime's wiring, driven with a fake clock and a fake route.
//
// This exists because of a bug the predicate harness next door could never see.
// captionPrefs.ts decides what the preference IS; captionRuntime.ts decides
// WHICH CHANNEL to ask about, and it asked videoContext.channelOf(videoId) --
// which falls back to the last channel seen when that video is unknown. From
// the second video of a session onward that fallback is never null, so:
//
//   * the CHANNEL_WAIT_MS poll the file was written around became unreachable
//   * a video whose player response had not landed yet was resolved against the
//     PREVIOUS video's channel, in both directions -- captions forced off on a
//     video that should have had them, and on for one that should not
//
// Every assertion below fails against channelOf and passes against
// channelForVideo, which is the only reason to have written them.
import { checker } from '../lib/repo.mjs';
import { store, commands } from './stub.mjs';

// --- the fakes, installed before the module is imported ---------------------
// captionRuntime reads location.hash and adds a hashchange listener at module
// scope, then calls onRouteChange() immediately.
let hash = '';
globalThis.location = { get hash() { return hash; } };

const hashListeners = [];
globalThis.window = {
    addEventListener: (type, cb) => { if (type === 'hashchange') hashListeners.push(cb); },
};

// A controllable clock: setTimeout queues, and tick() runs what is due.
let clock = 0;
let seq = 0;
const pending = new Map();
globalThis.setTimeout = (fn, ms) => {
    const id = ++seq;
    pending.set(id, { at: clock + (ms || 0), fn });
    return id;
};
globalThis.clearTimeout = (id) => { pending.delete(id); };
/** Advance the clock, running every callback that comes due, in time order. */
function tick(ms) {
    const until = clock + ms;
    for (;;) {
        let next = null;
        for (const [id, t] of pending) if (t.at <= until && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        pending.delete(next[0]);
        clock = next[1].at;
        next[1].fn();
    }
    clock = until;
}

const context = await import('./videoContext.generated.mts');
await import('./runtime.generated.mts');

const { check, done } = checker();

/** Navigate to a watch page, as the app's hashchange does. */
function goTo(videoId) {
    hash = videoId ? `#/watch?v=${videoId}` : '#/browse?c=home';
    hashListeners.forEach((cb) => cb());
}
/** The player response landing, which is where the channel comes from. */
function playerResponse(videoId, channelId, author) {
    context.recordVideoContext({
        videoDetails: { videoId, channelId, author: author || channelId },
    });
}
const lastCommand = () => (commands.length ? commands[commands.length - 1] : null);
const reset = () => { commands.length = 0; };

// --- the case that was broken -----------------------------------------------
// Video A on channel A establishes `latest`. Then video B on a DIFFERENT
// channel, whose player response has not arrived when the first poll fires.
store.captionsDefault = 'on';
store.captionsOffChannels = ['UCaaa Channel A'];

goTo('videoA');
playerResponse('videoA', 'UCaaa');
tick(300);
check('video A takes its channel rule', JSON.stringify(lastCommand()),
      JSON.stringify({ selectSubtitlesTrackCommand: {} }));

reset();
goTo('videoB');
tick(300);   // the first poll fires; B's player response has NOT landed
check('video B waits rather than using the last channel seen', commands.length, 0);

playerResponse('videoB', 'UCbbb');
tick(300);
check('  ...and takes the global default once its own channel lands',
      JSON.stringify(lastCommand()), JSON.stringify({ selectSubtitlesTrackCommand: { useDefaultTrack: true } }));
check('  ...exactly once', commands.length, 1);

// The other direction, which is the one a user notices: captions appearing on a
// channel they had switched off.
reset();
store.captionsDefault = 'off';
store.captionsOnChannels = ['UCccc Channel C'];
store.captionsOffChannels = [];
goTo('videoC');
playerResponse('videoC', 'UCccc');
tick(300);
check('video C is forced on', JSON.stringify(lastCommand()),
      JSON.stringify({ selectSubtitlesTrackCommand: { useDefaultTrack: true } }));

reset();
goTo('videoD');
tick(300);
check('video D does not inherit C’s rule', commands.length, 0);
playerResponse('videoD', 'UCddd');
tick(300);
check('  ...and takes the global default', JSON.stringify(lastCommand()),
      JSON.stringify({ selectSubtitlesTrackCommand: {} }));

// --- the wait has a limit ----------------------------------------------------
// A video whose channel never arrives still gets the global default. Without
// this the fix above would have traded a wrong answer for no answer.
reset();
store.captionsDefault = 'on';
goTo('videoE');
tick(300);
check('an unknown channel waits', commands.length, 0);
tick(4000);
check('  ...but not forever', JSON.stringify(lastCommand()),
      JSON.stringify({ selectSubtitlesTrackCommand: { useDefaultTrack: true } }));
check('  ...and applies once', commands.length, 1);

// --- it never re-asserts ------------------------------------------------------
reset();
playerResponse('videoE', 'UCeee');
tick(10000);
check('a settled video is never revisited', commands.length, 0);

// --- leaving the player -------------------------------------------------------
reset();
goTo(null);
tick(500);
check('a non-watch route dispatches nothing', commands.length, 0);
goTo('videoE');
playerResponse('videoE', 'UCeee');
tick(300);
check('  ...and returning to the same video decides afresh', commands.length, 1);

// --- navigating away mid-wait --------------------------------------------------
reset();
goTo('videoF');
tick(100);          // inside the first poll
goTo('videoG');
playerResponse('videoG', 'UCggg');
tick(600);
check('a route change mid-wait applies only the new video', commands.length, 1);

// --- 'leave' does nothing -------------------------------------------------------
reset();
store.captionsDefault = 'leave';
store.captionsOnChannels = [];
goTo('videoH');
playerResponse('videoH', 'UChhh');
tick(500);
check('the default preference dispatches nothing', commands.length, 0);

// --- the accessor itself ---------------------------------------------------------
check('channelForVideo does not fall back', context.channelForVideo('nothing-seen'), null);
check('  ...while channelOf deliberately does', context.channelOf('nothing-seen')?.id, 'UChhh');
check('  ...and channelOf(null) still answers for the settings row',
      context.channelOf(null)?.id, 'UChhh');

done();
