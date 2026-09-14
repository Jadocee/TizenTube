// Draws the two things that say a thumbnail is previewing: a badge saying what
// kind of playing it is, and a progress bar saying how far through.
//
// One module because they are driven by one state machine, and two copies of
// that machine is two chances for them to disagree about whether a preview is
// running. Two settings because they say different things, and the quietest
// arrangement -- the bar without the badge -- has to be reachable.
//
// Every decision it makes -- when to retire, whether focus has settled, where
// the mark goes -- lives in features/previewState.ts as pure functions that a
// Node harness runs directly. What is left here is the DOM shell: build an
// element, move it, set an attribute. That split is deliberate. The parts that
// could only be debugged by staring at a television are the parts that are
// provable in CI.
//
// It never gates playback. The worst thing that can happen if every assumption
// in here is wrong is that no mark appears and previews behave exactly as they
// do today.

import { configChangeEmitter, configRead } from '../config.js';
import { whenBodyReady } from '../utils/domReady.js';
import { setStyleBlock } from './styleSheet.js';
import { onPreviewStart, onPreviewStop } from '../features/playbackPreview.js';
import { DEFAULT_PREVIEW_DURATION_MS } from '../features/tileFixes.js';
import {
    remainingMs,
    progressFraction,
    formatRemaining,
    barBox,
    IDLE,
    reduce,
    chipOrigin,
    shouldAnchor,
    soundState,
    AUDIO_SETTLE_MS,
    LOADING_TIMEOUT_MS,
    type PreviewState,
    type SoundState,
} from '../features/previewState.js';
import css from './previewIndicator.css';

// Registered on evaluation, the same reasoning as clock.ts: the element must
// never be in the document unstyled, and the block is independent of the
// others, so it can be replaced without disturbing 'ui', 'theme' or 'clock'.
setStyleBlock('previewIndicator', css);

const ELEMENT_ID = 'tizentube-preview-indicator';
const BAR_ID = 'tizentube-preview-progress';

let element: HTMLDivElement | null = null;
let state: PreviewState = IDLE;
let lastMoveAt = 0;
let watchdog: ReturnType<typeof setTimeout> | null = null;

/** The element the preview is actually playing in. Learned from the media event
 *  rather than looked up: the mod never has to know a selector, and a player the
 *  app swaps out is simply the target of the next event. */
let media: HTMLMediaElement | null = null;
let sound: SoundState = 'unknown';
/** One re-check, AUDIO_SETTLE_MS after the first frame. Chromium's decoded-audio
 *  counter is legitimately 0 at that moment for a video that does have sound, so
 *  asking once at `playing` would call every video silent. */
let soundTimer: ReturnType<typeof setTimeout> | null = null;
/** The 1Hz countdown tick. Only alive while a preview is actually playing --
 *  renderRemaining() starts it and every retirement path stops it. */
let countdown: ReturnType<typeof setTimeout> | null = null;
/** The countdown's own node, held rather than looked up. One reference beats a
 *  querySelector on every tick, and the element is built here so there is no
 *  reason to go looking for it. */
let timeElement: HTMLElement | null = null;

/** The progress bar and the element inside it that actually moves. Two nodes
 *  rather than one, because the track has to stay the full width of the tile
 *  while the fill grows -- which is how the app's own PREVIEW bar is built:
 *  `.zIOpyc` is the track and `.OlEbwe` the fill it scales. (Its WATCHED bar,
 *  `.mSnwOd`/`.Y7ta6`, is a different component and sizes its fill with an
 *  inline width percentage, which is the technique this deliberately avoids.) */
let bar: HTMLDivElement | null = null;
let barFill: HTMLElement | null = null;
/**
 * Which preview the bar is currently running for, as that preview's startedAt.
 *
 * render() is called for every state change -- a stall, the speaker appearing --
 * and re-arming on each of those would restart the animation from wherever the
 * bar had got to, so a video that stuttered twice would show a bar that jumped
 * backwards twice. Armed once per preview, and the identity of a preview is the
 * moment it was requested.
 */
let barArmedFor: number | null = null;
/**
 * The media position the preview began at, in seconds.
 *
 * The app's own bar takes this from the endpoint's `startTimeSeconds`; sampling
 * it off the first frame instead gets the same number for an ordinary preview
 * and the RIGHT number for one the app resumed part-way through, which
 * `resumeVideo: true` in the mod's own command asks it to do.
 */
let barOrigin = 0;
/** Which preview barOrigin was sampled for. Kept apart from barArmedFor so that
 *  switching the bar off and on again inside one preview re-arms it at the
 *  position the video has actually reached, rather than measuring a fresh origin
 *  from the middle of a video and claiming the preview just started. */
let barOriginFor: number | null = null;

/** Media events tell us buffering apart from finished, which no timer can, and
 *  -- since `playing` is the first frame -- loading apart from playing. They are
 *  added only while a preview is running, so they cost nothing at rest.
 *
 *  volumechange is here because the sound mark has to be able to go away: the
 *  app mutes and unmutes its own preview player, and a speaker left drawn on a
 *  muted video is exactly the wrong error.
 *
 *  timeupdate is the progress bar's clock. It is the only one of these that
 *  fires repeatedly -- roughly four times a second in Chromium -- and its
 *  handler does one style write and nothing else. */
const MEDIA_EVENTS = ['playing', 'waiting', 'stalled', 'volumechange', 'timeupdate'] as const;

function clearSoundTimer(): void {
    if (soundTimer !== null) {
        clearTimeout(soundTimer);
        soundTimer = null;
    }
}

/** Re-reads the audio signal off the live element and redraws if it moved. */
function refreshSound(): void {
    if (state.phase === 'idle') return;
    const next = media
        ? soundState({
              muted: media.muted,
              volume: media.volume,
              // Non-standard and Chromium-only, which is exactly the target.
              // Absent on another engine, where soundState falls back to
              // "unmuted means audible".
              audioBytes: (media as any).webkitAudioDecodedByteCount,
              playingForMs: state.playingAt ? Date.now() - state.playingAt : 0,
          })
        : 'unknown';
    if (next === sound) return;
    sound = next;
    render();
    // The mark CHANGES SIZE here: an audible one is a pill roughly 1.75x the
    // width of the silent disc. place() measures the node, but it last ran at
    // start(), while this was still a disc -- so the clamp that keeps the mark
    // inside the viewport and the title-safe box was computed for a width the
    // element no longer has, and the speaker end hung outside it. Re-measuring
    // is one getBoundingClientRect, once per preview, on a transition that has
    // already changed the shape.
    place();
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/* Material Icons, verbatim. These are the exact paths @mui/icons-material draws
   for PlayArrow and VolumeUp, on the same 24x24 grid -- taken from the icon set
   rather than redrawn, so they are the shapes people already recognise from
   every other player. Apache 2.0.

   Inlined as path data instead of loaded: this runs on a television, over
   whatever connection it has, and an icon that arrives late or not at all is
   worse than one that was never promised. There is no font to miss and no
   request to fail. */
const MATERIAL_PLAY_ARROW = 'M8 5v14l11-7z';
const MATERIAL_VOLUME_UP =
    'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z';

/** One Material icon as an inline SVG, sized and coloured by the stylesheet. */
function materialIcon(className: string, path: string): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    // currentColor so the mark dims with the rest of the indicator rather than
    // staying the one bright thing on a dimmed screen.
    svg.setAttribute('fill', 'currentColor');
    // The indicator is inert decoration sitting over a tile; a screen reader
    // announcing it would be describing the tile twice.
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    // setAttribute, not classList: SVGElement.classList is fine on this engine,
    // but the attribute is what every other element here is built with.
    svg.setAttribute('class', className);
    const d = document.createElementNS(SVG_NS, 'path');
    d.setAttribute('d', path);
    svg.appendChild(d);
    return svg;
}

function ensureElement(): HTMLDivElement | null {
    if (element) return element;
    // Built on the first real start(), not at module scope: if the stylesheet
    // block were ever refused, an eagerly-built element would sit in the
    // document unstyled forever, whereas this one only appears once something
    // is genuinely playing.
    const node = document.createElement('div');
    node.id = ELEMENT_ID;
    // Dimmed along with everything else by ui.ts's idle timer. Without this the
    // mark would be the one bright thing left on a dimmed screen.
    node.className = 'tt-dimmable';
    // Three marks, and which one shows is decided entirely by CSS from the two
    // data attributes this file sets. Separate elements rather than one that
    // changes shape, so nothing here has to know what a state looks like.
    //
    // The spinner stays a plain span: it is motion, not an icon, and a rotating
    // ring is a border and a keyframe rather than a path.
    const glyph = document.createElement('span');
    glyph.className = 'tt-pi-glyph';
    node.appendChild(glyph);
    node.appendChild(materialIcon('tt-pi-play', MATERIAL_PLAY_ARROW));
    // How much preview is left. A span rather than a third icon: it is the one
    // part of this mark that is a number, and previewState.remainingMs decides
    // whether there is an honest one to show.
    const time = document.createElement('span');
    time.className = 'tt-pi-time';
    node.appendChild(time);
    timeElement = time;
    node.appendChild(materialIcon('tt-pi-sound', MATERIAL_VOLUME_UP));
    element = node;
    whenBodyReady(() => {
        if (element && !element.isConnected) document.body.appendChild(element);
    });
    return element;
}

/**
 * The progress bar, built the same way and for the same reason as the mark: only
 * once something is genuinely playing, so a refused stylesheet cannot leave a
 * bare div parked across a thumbnail.
 */
function ensureBar(): HTMLDivElement | null {
    if (bar) return bar;
    const node = document.createElement('div');
    node.id = BAR_ID;
    node.className = 'tt-dimmable';
    const fill = document.createElement('div');
    fill.className = 'tt-pp-fill';
    node.appendChild(fill);
    bar = node;
    barFill = fill;
    whenBodyReady(() => {
        if (bar && !bar.isConnected) document.body.appendChild(bar);
    });
    return bar;
}

/**
 * The box the preview is actually playing in, in physical viewport pixels.
 *
 * MEASURED FROM THE VIDEO, not from the focused tile, and the difference is the
 * whole reason this function exists. A focused tile's box includes the title and
 * channel underneath the thumbnail, so a bar on its bottom edge would be drawn
 * across the text rather than across the picture. The app positions its player
 * over the thumbnail itself -- `a.Sc=_.bL(b)` in the preview service, where
 * `_.bL` is `getBoundingClientRect` of the element the tile handed it -- so the
 * video's own box IS the thumbnail box, whichever element that turned out to be.
 *
 * It is also the honest gate for a preview that has been adopted into the watch
 * page: that player fills the screen, barBox rejects it, and no bar is drawn
 * rather than one across the bottom of a full-screen video, where it would read
 * as the video's own progress.
 */
function mediaBox(): { x: number; y: number; width: number } | null {
    if (!media || typeof media.getBoundingClientRect !== 'function') return null;
    try {
        const box = media.getBoundingClientRect();
        return barBox(
            { left: box.left, top: box.top, width: box.width, height: box.height },
            { width: window.innerWidth, height: window.innerHeight },
        );
    } catch (_e) {
        // A detached element. No bar is the right answer, not a guessed one.
        return null;
    }
}

/** Moves the bar onto the box it is describing, without disturbing the fill. */
function placeBar(): void {
    // `=== null`, not `!barArmedFor`: barArmedFor holds a startedAt, and a
    // preview requested at timestamp 0 is falsy. advanceBar carries the same
    // note; this function had the bug the note describes.
    if (!bar || barArmedFor === null) return;
    const box = mediaBox();
    if (!box) return;
    bar.style.setProperty('--tt-pp-x', `${box.x}px`);
    bar.style.setProperty('--tt-pp-y', `${box.y}px`);
    bar.style.setProperty('--tt-pp-w', `${box.width}px`);
}

/**
 * Starts the bar for the preview that is playing now.
 *
 * The origin is sampled from the frame that has just arrived -- but only once
 * per preview, so this is also the path that puts the bar back mid-preview after
 * its setting has been switched off and on, at the position the video has
 * actually reached.
 *
 * The fill is SNAPPED, with the transition suppressed for that one write. A
 * preview starting on top of another would otherwise slide its bar backwards
 * across the new tile from wherever the last one had got to.
 */
function armBar(): void {
    // SAMPLED BEFORE ANYTHING CAN FAIL, because the origin belongs to the
    // preview rather than to whether its box could be measured. A preview whose
    // player was full-screen at the first frame -- one adopted from the watch
    // page -- still knows where it began if it later becomes drawable.
    if (barOriginFor !== state.startedAt) {
        barOrigin = media && Number.isFinite(media.currentTime) ? media.currentTime : 0;
        barOriginFor = state.startedAt;
    }

    const box = mediaBox();
    if (!box) {
        // NOT retireBar(): "cannot measure the box" is not "the preview ended",
        // and retiring here would throw away the origin just sampled. Hide the
        // bar and leave the bookkeeping to the retirement that actually happens.
        barArmedFor = null;
        if (bar) bar.removeAttribute('data-state');
        return;
    }
    const node = ensureBar();
    if (!node || !barFill) return;

    const fraction = progressFraction({
        currentTime: media ? media.currentTime : undefined,
        startTime: barOrigin,
        durationMs: state.durationMs,
    });

    node.style.setProperty('--tt-pp-x', `${box.x}px`);
    node.style.setProperty('--tt-pp-y', `${box.y}px`);
    node.style.setProperty('--tt-pp-w', `${box.width}px`);
    node.setAttribute('data-state', state.phase);

    barFill.style.transitionDuration = '0ms';
    barFill.style.transform = `scaleX(${fraction === null ? 0 : fraction})`;

    barArmedFor = state.startedAt;
}

/**
 * Moves the fill to wherever the video has got to.
 *
 * Driven by the media element's own timeupdate, which is the closest thing the
 * mod has to the onProgressChange the app's own bar subscribes to, and fires at
 * about the same rate. The stylesheet carries a 250ms linear transition -- the
 * same one the app's `.OlEbwe` carries -- so those few samples a second are
 * drawn as a continuous crawl by the compositor rather than as visible steps.
 *
 * The transition is handed back on the first advance, because armBar suppressed
 * it to snap the fill to zero.
 */
function advanceBar(): void {
    // `!barArmedFor` would be wrong here and was: a preview requested at
    // timestamp 0 is falsy, and this file already records that trap once, in
    // dispatch's `|| before.phase === 'idle'`. Unreachable on a television,
    // perfectly reachable in a harness with a fake clock -- which is exactly how
    // a bug like this survives for years.
    if (!bar || !barFill || barArmedFor === null) return;
    const fraction = progressFraction({
        currentTime: media ? media.currentTime : undefined,
        startTime: barOrigin,
        durationMs: state.durationMs,
    });
    // Nothing honest to draw: leave the bar where it is rather than sending it
    // back to zero, which would read as the preview restarting.
    if (fraction === null) return;
    barFill.style.transitionDuration = '';
    barFill.style.transform = `scaleX(${fraction})`;
}

/**
 * Hides the bar, keeping the element for the next preview.
 *
 * The fill is left exactly where it stopped. Resetting it here would empty the
 * bar during the 160ms it spends fading out -- a preview rewinding as it ends --
 * and there is nothing to reset it for: every path back to visible goes through
 * armBar, which sets the fill itself.
 */
function retireBar(): void {
    barArmedFor = null;
    barOrigin = 0;
    barOriginFor = null;
    if (bar) bar.removeAttribute('data-state');
}

/** Gives up the element entirely, for the setting going off or a teardown. */
function dropBar(): void {
    barArmedFor = null;
    // barOrigin deliberately survives -- see barOriginFor. It is cleared when
    // the preview ends, which is retireBar, not when the setting goes off.
    if (bar) bar.remove();
    bar = null;
    barFill = null;
}

/** Draws the bar, or does not, for whatever the state now is. */
function syncBar(): void {
    if (!configRead('enablePreviewProgressBar')) {
        dropBar();
        return;
    }
    if (state.phase !== 'playing' && state.phase !== 'stalled') {
        retireBar();
        return;
    }
    if (barArmedFor !== null && barArmedFor === state.startedAt) {
        // Already running for this preview. Stalling changes how it is painted
        // and nothing else -- re-arming here would restart the animation from
        // wherever the bar had reached, so a video that stuttered would show a
        // bar that jumped backwards.
        if (bar) bar.setAttribute('data-state', state.phase);
        return;
    }
    armBar();
}

/**
 * Wakes the reducer at the next deadline that could retire the mark.
 *
 * While loading that is the load timeout, which is much sooner than endsAt --
 * a preview the app asked for and never got has to stop claiming it is coming.
 * Once playing it is endsAt, as before.
 */
function armWatchdog(): void {
    clearWatchdog();
    if (state.phase === 'idle') return;
    const now = Date.now();
    const deadline =
        state.phase === 'loading'
            ? Math.min(state.startedAt + LOADING_TIMEOUT_MS, state.endsAt)
            : state.endsAt;
    watchdog = setTimeout(
        () => dispatch({ type: 'tick', now: Date.now() }),
        Math.max(0, deadline - now),
    );
}

function clearWatchdog(): void {
    if (watchdog !== null) {
        clearTimeout(watchdog);
        watchdog = null;
    }
}

/**
 * Both halves of the overlay, each answering to its own setting.
 *
 * They are drawn by one module because they are driven by one state machine, and
 * two copies of that machine is two chances for the bar and the mark to disagree
 * about whether a preview is running. They are SETTINGS-independent all the
 * same: someone who wants the bar and not the badge -- which is the quieter
 * arrangement, and the point of making the badge quieter -- gets exactly that.
 */
function render(): void {
    syncBar();
    renderChip();
}

function renderChip(): void {
    if (!configRead('enablePreviewIndicator')) {
        dropChip();
        return;
    }
    if (state.phase === 'idle') {
        if (element) element.removeAttribute('data-state');
        // This branch RETURNS, so anything that has to stop when the mark
        // retires has to stop here as well -- renderRemaining() at the bottom of
        // this function is never reached from idle. The countdown's 1Hz timer
        // outlived every ordinary stop until this line existed, which the
        // runtime harness caught by counting live timers after a stop.
        clearCountdown();
        if (element) element.removeAttribute('data-time');
        if (timeElement) timeElement.textContent = '';
        return;
    }
    const node = ensureElement();
    if (!node) return;
    node.setAttribute('data-state', state.phase);
    // Only ever set when the answer is known. 'unknown' removes the attribute,
    // so a video whose audio cannot be established draws no speaker rather than
    // guessing -- sending someone hunting for sound that was never there is a
    // worse failure than saying nothing.
    if (sound === 'audible') node.setAttribute('data-sound', 'on');
    else node.removeAttribute('data-sound');

    renderRemaining(node);
}

/**
 * Draws the countdown, and keeps it ticking only while there is one.
 *
 * The timer is started and stopped from here rather than from the state
 * machine, so it cannot outlive the mark: every path that retires the indicator
 * goes through render(), and every one of them lands in the `null` branch.
 * One setTimeout at 1Hz, alive for the few seconds a preview lasts, is the whole
 * cost -- and it re-arms against the wall clock so the digits change when the
 * second does rather than drifting a little further from it each time.
 */
function renderRemaining(node: HTMLElement): void {
    const readout = timeElement;
    if (!readout) return;

    const left = remainingMs(state, Date.now());
    if (left === null) {
        clearCountdown();
        node.removeAttribute('data-time');
        readout.textContent = '';
        return;
    }

    const text = formatRemaining(left);
    // The same string 59 times a minute otherwise, each one a layout on a TV SoC.
    if (readout.textContent !== text) readout.textContent = text;
    node.setAttribute('data-time', 'on');

    clearCountdown();
    // Re-armed against the wall clock, so the readout changes on the second.
    countdown = setTimeout(
        () => {
            countdown = null;
            if (element) renderRemaining(element);
        },
        Math.max(50, 1000 - (Date.now() % 1000)),
    );
}

function clearCountdown(): void {
    if (countdown !== null) {
        clearTimeout(countdown);
        countdown = null;
    }
}

/** Gives up the badge entirely, for the setting going off or a teardown. */
function dropChip(): void {
    // Explicit, though render()'s idle branch would also stop it: this path does
    // not go through render(), and a timer whose only brake is `if (element)` is
    // one tick of dead work rather than none.
    clearCountdown();
    if (element) element.remove();
    element = null;
    // Held above; a stale reference into a removed tree would keep it alive and
    // would be written to by the next preview's first render.
    timeElement = null;
}

function place(): void {
    // The element that already exists, never one built here. Both callers run
    // render() first, so when the badge is switched on the node is there -- and
    // when it is switched off, building one to position it would put the badge
    // back on screen with its setting off.
    const node = element;
    if (!node) return;

    let rect = null;
    if (state.anchored) {
        try {
            const focused = document.activeElement as HTMLElement | null;
            // getBoundingClientRect is the only DOM read this feature makes, and
            // it happens once per preview rather than per frame.
            if (focused && typeof focused.getBoundingClientRect === 'function') {
                const box = focused.getBoundingClientRect();
                rect = { left: box.left, top: box.top, width: box.width, height: box.height };
            }
        } catch (_e) {
            // A detached or cross-document activeElement. The corner fallback
            // below covers it.
        }
    }

    // chipOrigin validates the rect itself and falls back to the title-safe
    // corner when it is not plausibly a tile, so a wrong guess costs placement
    // and never correctness.
    // Measured, never assumed: the mark is a disc while silent and a wider pill
    // once a speaker is drawn, and the fallback below is only for the frame
    // before it has been laid out at all.
    const size = node.getBoundingClientRect();
    const chip = {
        width: size.width || 64,
        height: size.height || 64,
    };
    const origin = chipOrigin(rect, { width: window.innerWidth, height: window.innerHeight }, chip);
    node.style.setProperty('--tt-pi-x', `${origin.x}px`);
    node.style.setProperty('--tt-pi-y', `${origin.y}px`);
}

function onMediaEvent(event: Event): void {
    const target = event.target as HTMLMediaElement | null;
    // Whatever is producing these events IS the preview player, for as long as
    // a preview is running. Nothing else is playing at that moment.
    if (target && typeof (target as HTMLMediaElement).muted === 'boolean') media = target;

    if (event.type === 'volumechange') {
        refreshSound();
        return;
    }
    // Before the fall-through below, which reads anything it does not recognise
    // as a stall. A timeupdate arriving every 250ms would otherwise report a
    // perfectly healthy preview as buffering, four times a second.
    if (event.type === 'timeupdate') {
        advanceBar();
        return;
    }
    if (event.type === 'playing') {
        dispatch({ type: 'resume', now: Date.now() });
        // The first frame. Read audio now for the common case where the counter
        // is already non-zero, then once more after it has had time to move.
        refreshSound();
        clearSoundTimer();
        soundTimer = setTimeout(() => {
            soundTimer = null;
            refreshSound();
            // One correction of the bar's box, on a timer that already exists.
            // The app moves its player onto the tile, and on the path where that
            // move is animated -- 200ms, ease-in-out -- the box measured at the
            // first frame can be a box the player was still travelling through.
            placeBar();
        }, AUDIO_SETTLE_MS);
        return;
    }
    dispatch({ type: 'stall' });
}

function listenToMedia(on: boolean): void {
    for (const name of MEDIA_EVENTS) {
        // Capture phase: media events do not bubble, so the only way to see one
        // from a <video> we never held a reference to is to catch it on the way
        // down.
        if (on) document.addEventListener(name, onMediaEvent, true);
        else document.removeEventListener(name, onMediaEvent, true);
    }
}

function dispatch(event: Parameters<typeof reduce>[1]): void {
    const before = state;
    state = reduce(state, event);
    if (state === before) return;

    const isIdle = state.phase === 'idle';
    // A NEW preview, whether or not one was already running. Keying this off
    // "was idle" was wrong: the app's teardown is `end`, not `stop`, so for the
    // whole life of this feature no stop ever arrived and every consecutive
    // preview landed here as start-on-top-of-start. That path reset nothing and
    // re-armed nothing, so the previous preview's speaker was drawn over the new
    // one's spinner and the watchdog stayed keyed to a deadline that had already
    // been replaced -- and once that stale timer fired into an unchanged state,
    // dispatch returned early and NOTHING was left scheduled. The spinner then
    // animated in one screen position until the user pressed a key.
    // `|| before.phase === 'idle'` is not redundant: IDLE.startedAt is 0, so a
    // preview that starts at timestamp 0 would compare equal and the media
    // listeners would never attach. A clock reading exactly 0 is unreachable on
    // a television, which is precisely why it is the kind of thing that sits in
    // the code for years -- the invariant wanted here is "a new preview needs
    // initialising", and coming from idle is always that.
    const restarted = before.phase === 'idle' || state.startedAt !== before.startedAt;

    if (isIdle) {
        listenToMedia(false);
        clearWatchdog();
        clearSoundTimer();
        media = null;
        sound = 'unknown';
        render();
        return;
    }

    if (restarted) {
        listenToMedia(true);
        clearSoundTimer();
        media = null;
        sound = 'unknown';
        render();
        place();
        armWatchdog();
        return;
    }

    render();
    // Any state change can move the deadline -- loading resolving into playing
    // re-bases it on the first frame. Re-arming unconditionally is cheaper than
    // enumerating which transitions do, and an enumeration that misses one is
    // how the mark got stranded in the first place.
    armWatchdog();
}

/** A real D-pad move. Called from ui.ts's existing keydown handler rather than
 *  from a fourth document listener of our own. */
export function notePreviewMove(): void {
    lastMoveAt = Date.now();
    dispatch({ type: 'move', now: lastMoveAt });
}

function onFocusIn(): void {
    // Focus moves as a side effect of the app starting a preview, so this is not
    // automatically a user action -- reduce() ignores one that lands inside the
    // grace window after a start.
    const now = Date.now();
    lastMoveAt = now;
    dispatch({ type: 'move', now });
}

function onRouteChange(): void {
    dispatch({ type: 'route' });
}

let started = false;
/** The preview callbacks can only be registered once -- playbackPreview keeps a
 *  list with no way to remove from it -- so re-enabling reuses them and the
 *  `started` gate inside decides whether they do anything. */
let registered = false;

function enable(): void {
    if (started) return;
    started = true;

    document.addEventListener('focusin', onFocusIn, true);
    // A preview that becomes a full-screen watch changes the route without ever
    // calling the teardown.
    window.addEventListener('hashchange', onRouteChange);

    if (registered) return;
    registered = true;

    onPreviewStart(() => {
        // playbackPreview has no unregister, so the gate is here. Without it a
        // disabled indicator still ran its state machine and rebuilt its own
        // element on the next preview.
        if (!started) return;
        const now = Date.now();
        dispatch({
            type: 'start',
            now,
            durationMs: DEFAULT_PREVIEW_DURATION_MS,
            anchored: shouldAnchor(lastMoveAt, now),
        });
    });
    onPreviewStop(() => {
        if (!started) return;
        dispatch({ type: 'stop' });
    });
}

function disable(): void {
    if (!started) return;
    started = false;

    // Actually tear down. This used to dispatch a stop and drop the element,
    // which left the focusin and hashchange listeners attached and the preview
    // callbacks registered -- so the next preview rebuilt the element through
    // ensureElement() and the mark came back with the setting switched off.
    document.removeEventListener('focusin', onFocusIn, true);
    window.removeEventListener('hashchange', onRouteChange);
    listenToMedia(false);
    clearWatchdog();
    clearSoundTimer();

    state = IDLE;
    media = null;
    sound = 'unknown';

    dropChip();
    // Retire before dropping: retireBar owns the per-preview bookkeeping
    // (the armed marker and the sampled origin) that dropBar deliberately
    // leaves alone so a setting toggle can re-arm mid-preview.
    retireBar();
    dropBar();
}

/** Whether either half of the overlay wants the state machine running. */
function anyEnabled(): boolean {
    return !!configRead('enablePreviewIndicator') || !!configRead('enablePreviewProgressBar');
}

configChangeEmitter.addEventListener('configChange', (e) => {
    const key = e.detail.key;
    if (key !== 'enablePreviewIndicator' && key !== 'enablePreviewProgressBar') return;
    if (!anyEnabled()) {
        disable();
        return;
    }
    enable();

    // The half that just went off has to let go of its element even though the
    // module keeps running for the other one.
    if (!e.detail.value) {
        if (key === 'enablePreviewIndicator') dropChip();
        else dropBar();
        return;
    }

    // ONLY THE BAR REJOINS A PREVIEW ALREADY IN PROGRESS, and the asymmetry is
    // about anchors rather than taste. armBar measures the video's own box, so
    // the bar can put itself in the right place at any moment. The badge
    // anchors to whatever has focus -- and by the time someone has reached the
    // settings panel to switch it on, what has focus IS the settings panel. A
    // render() here drew it with its position variables never written, which
    // the stylesheet resolves to a hard translate3d(0px, 0px): the badge in the
    // extreme corner of the screen, for the rest of the preview. So it waits
    // for the next one, where dispatch's restarted branch places it properly.
    if (key === 'enablePreviewProgressBar') syncBar();
});

if (anyEnabled()) enable();
