// Draws the "this thumbnail is playing" mark, and nothing else.
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

/** Media events tell us buffering apart from finished, which no timer can, and
 *  -- since `playing` is the first frame -- loading apart from playing. They are
 *  added only while a preview is running, so they cost nothing at rest.
 *
 *  volumechange is here because the sound mark has to be able to go away: the
 *  app mutes and unmutes its own preview player, and a speaker left drawn on a
 *  muted video is exactly the wrong error. */
const MEDIA_EVENTS = ['playing', 'waiting', 'stalled', 'volumechange'] as const;

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
    // Two glyphs, both CSS: the state mark (triangle or spinner) and the sound
    // mark. Separate elements rather than one that changes class, so the CSS
    // decides what each state shows and this file only ever sets attributes.
    const glyph = document.createElement('span');
    glyph.className = 'tt-pi-glyph';
    node.appendChild(glyph);
    const speaker = document.createElement('span');
    speaker.className = 'tt-pi-sound';
    node.appendChild(speaker);
    element = node;
    whenBodyReady(() => {
        if (element && !element.isConnected) document.body.appendChild(element);
    });
    return element;
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

function render(): void {
    if (state.phase === 'idle') {
        if (element) element.removeAttribute('data-state');
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
}

function place(): void {
    const node = ensureElement();
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
    if (event.type === 'playing') {
        dispatch({ type: 'resume', now: Date.now() });
        // The first frame. Read audio now for the common case where the counter
        // is already non-zero, then once more after it has had time to move.
        refreshSound();
        clearSoundTimer();
        soundTimer = setTimeout(() => {
            soundTimer = null;
            refreshSound();
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

    if (element) {
        element.remove();
        element = null;
    }
}

configChangeEmitter.addEventListener('configChange', (e) => {
    if (e.detail.key !== 'enablePreviewIndicator') return;
    if (e.detail.value) enable();
    else disable();
});

if (configRead('enablePreviewIndicator')) enable();
