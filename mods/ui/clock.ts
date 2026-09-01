import { configChangeEmitter, configRead } from '../config.js';
import { t } from 'i18next';
import { whenBodyReady } from '../utils/domReady.js';
import { setStyleBlock } from './styleSheet.js';
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

let actualClock: HTMLDivElement | null | undefined;
let clockTimeout: ReturnType<typeof setTimeout> | null | undefined;
let lastText: string | null | undefined;

function pad2(value: number): string {
    return String(value).padStart(2, '0');
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
    updateClock();
    scheduleTick();
}

toggleClock(configRead('enableClock'));
