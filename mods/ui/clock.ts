import { configChangeEmitter, configRead } from '../config.js';
import { t } from 'i18next';
import { whenBodyReady } from '../utils/domReady.js';
import { setStyleBlock } from './styleSheet.js';
import { onPreviewStart, onPreviewStop } from '../features/playbackPreview.js';
import {
    HIDDEN,
    clockVisible,
    isWatchRoute,
    reduce,
    type PlaybackSignal,
    type PlaybackState,
} from '../features/clockVisibility.js';
import clockCss from './clock.css';

// Registered on evaluation, not from ui.ts's startup path: that one waits for a
// <video> to exist, and the clock can be in the document from DOMContentLoaded
// -- which would show it unstyled until the video arrived.
setStyleBlock('clock', clockCss);

configChangeEmitter.addEventListener('configChange', (e) => {
    if (e.detail.key === 'enableClock') {
        toggleClock(e.detail.value);
    } else if (e.detail.key === 'clockPosition') {
        // Re-place the existing clock without restarting its ticker.
        placeClock();
    }
});

// The offsets themselves live in clock.css; this only names the corner.
const POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
const DEFAULT_POSITION = 'top-right';
// `tt-dimmable` rides along because placeClock() assigns className WHOLESALE,
// so anything not in this string is dropped the moment the position changes --
// and ui.ts's idle dimming now finds its overlays by that class rather than by
// this element's id.
const positionClass = (position: string): string =>
    `tt-dimmable tt-clock-${(POSITIONS as readonly string[]).includes(position) ? position : DEFAULT_POSITION}`;

const CLOCK_ID = 'tizentube-clock';

// Presence, not a value: clock.css hides #tizentube-clock outright and this
// attribute is what un-hides it. DISPLAY rather than opacity, deliberately --
// ui.ts's idle dimming writes `opacity` with `!important` across every
// `.tt-dimmable` element, and the clock is one of them, so an opacity-based
// hide would be overwritten by whichever of the two ran last.
const WATCHING_ATTRIBUTE = 'data-watching';

/** The media events that mean the player started or stopped, and what each one
 *  says. `emptied` is in here because leaving a video tears the source down
 *  without necessarily pausing first. */
const MEDIA_SIGNALS: ReadonlyArray<readonly [string, PlaybackSignal]> = [
    ['playing', 'play'],
    ['pause', 'stop'],
    ['ended', 'stop'],
    ['emptied', 'stop'],
];

let actualClock: HTMLDivElement | null | undefined;
let clockTimeout: ReturnType<typeof setTimeout> | null | undefined;
let lastText: string | null | undefined;
let playback: PlaybackState = HIDDEN;
let listening = false;

function pad2(value: number): string {
    return String(value).padStart(2, '0');
}

/** Whether the shared <video> is actually running right now. Used only to seed
 *  the state, so that turning the clock on from the settings panel -- which is
 *  open OVER a playing video -- shows it immediately rather than at the next
 *  media event, which on a paused-free playthrough may never come. */
function videoIsPlaying(): boolean {
    const video = document.querySelector('video');
    return !!video && !video.paused && !video.ended && video.readyState > 2;
}

function placeClock(): void {
    if (!actualClock) return;
    // One class swap, rather than clearing four properties and re-setting two.
    actualClock.className = positionClass(configRead('clockPosition'));
}

function updateClock(): void {
    if (!actualClock) return;
    const now = new Date();
    const is12HourFormat = configRead('isClock12HourFormat');
    const secondsEnabled = configRead('clockShowSeconds');

    const hours = now.getHours();
    let hoursText;
    if (is12HourFormat) {
        hoursText = `${hours % 12 || 12}`;
    } else {
        hoursText = pad2(hours);
    }

    const minutes = pad2(now.getMinutes());
    const seconds = secondsEnabled ? `:${pad2(now.getSeconds())}` : '';
    const suffix = is12HourFormat
        ? ` ${t(hours >= 12 ? 'settings.options.uiSettings.options.clock.pm' : 'settings.options.uiSettings.options.clock.am')}`
        : '';

    const text = `${hoursText}:${minutes}${seconds}${suffix}`;

    // With seconds hidden this is the same string 59 times a minute; skipping
    // the write skips a layout and a repaint over the video on a slow TV SoC.
    if (text === lastText) return;
    lastText = text;
    actualClock.textContent = text;
}

function scheduleTick(): void {
    // Re-armed against the wall clock rather than a fixed 1000ms period, so a
    // busy TV CPU cannot make the displayed minute drift behind the real one.
    clockTimeout = setTimeout(
        () => {
            updateClock();
            scheduleTick();
        },
        1000 - (Date.now() % 1000),
    );
}

function stopClock(): void {
    if (clockTimeout) {
        clearTimeout(clockTimeout);
        clockTimeout = null;
    }
}

/**
 * Shows or hides the clock, and starts or stops the ticker with it.
 *
 * The ticker is tied to visibility rather than left running: a hidden clock
 * ticking once a second is a timer, a Date and a string comparison every second
 * for as long as the app is open, on a CPU that has a video to decode. Stopping
 * it is the point of the feature as much as the hiding is.
 */
function applyVisibility(): void {
    if (!actualClock) return;

    if (!clockVisible(playback)) {
        actualClock.removeAttribute(WATCHING_ATTRIBUTE);
        stopClock();
        // updateClock() skips the write when the text has not changed, so the
        // next show would otherwise paint whatever minute it was hidden in.
        lastText = null;
        return;
    }

    actualClock.setAttribute(WATCHING_ATTRIBUTE, '');
    // Re-showing must not stack a second ticker on the one already running.
    if (clockTimeout) return;
    updateClock();
    scheduleTick();
}

function signal(name: PlaybackSignal): void {
    const next = reduce(playback, name);
    // reduce() returns the same object when nothing moved. Media events repeat
    // -- `playing` fires again after every buffer stall -- and this is what
    // keeps those from touching the DOM.
    if (next === playback) return;
    playback = next;
    applyVisibility();
}

/** Re-reads the two signals that can be observed rather than waited for. The
 *  third, `previewing`, has no getter to poll, so it is left as it stands. */
function resyncPlayback(): void {
    playback = {
        ...playback,
        watching: isWatchRoute(location.hash),
        playing: videoIsPlaying(),
    };
}

function listen(): void {
    if (listening) return;
    listening = true;

    for (const [type, name] of MEDIA_SIGNALS) {
        // Capture phase, on the document. Media events do not bubble, and the
        // app creates and replaces its <video> on its own schedule, so a
        // listener bound to the element would have to be rebound every time the
        // element changed -- which is precisely when these events matter most.
        // Capture reaches a non-bubbling event on any descendant, whenever it
        // was created.
        document.addEventListener(
            type,
            (e: Event) => {
                if ((e.target as HTMLElement | null)?.tagName === 'VIDEO') signal(name);
            },
            true,
        );
    }

    window.addEventListener('hashchange', () => {
        signal(isWatchRoute(location.hash) ? 'enterWatch' : 'leaveWatch');
    });

    // Neither of these can be unregistered -- playbackPreview keeps a plain list
    // -- which is why they are registered once and gated by state rather than
    // added and removed with the setting.
    onPreviewStart(() => signal('previewStart'));
    onPreviewStop(() => signal('previewStop'));
}

function toggleClock(value: unknown): void {
    const existingClock = document.getElementById(CLOCK_ID);
    // Both states are already what was asked for; nothing to do.
    if (Boolean(value) === Boolean(existingClock)) return;

    if (!value) {
        stopClock();
        existingClock!.remove();
        actualClock = null;
        lastText = null;
        return;
    }

    // Belt and braces: a timer from an earlier enable must never outlive it.
    stopClock();

    actualClock = document.createElement('div');
    actualClock.id = CLOCK_ID;

    // Everything static is in clock.css under #tizentube-clock.
    placeClock();
    // Deferred: at injection time the parser has not reached <body> yet.
    whenBodyReady(() => {
        if (actualClock) document.body.appendChild(actualClock);
    });

    lastText = null;
    // Seeded before the first paint decision, so enabling the clock during a
    // video shows it now rather than at the next media event.
    resyncPlayback();
    listen();
    applyVisibility();
}

toggleClock(configRead('enableClock'));
