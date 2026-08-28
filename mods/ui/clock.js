import { configChangeEmitter, configRead } from '../config.js';
import { t } from 'i18next';

configChangeEmitter.addEventListener('configChange', (e) => {
    if (e.detail.key === 'enableClock') {
        toggleClock(e.detail.value);
    } else if (e.detail.key === 'clockPosition') {
        // Re-place the existing clock without restarting its ticker.
        placeClock();
    }
});

// YouTube's TV app sizes its root font at a fixed fraction of the viewport
// (its own progress bar spans 4rem + 72rem + 4rem), so rem offsets land in the
// same place whatever resolution the set reports. 3rem/4rem clears the 5%
// title-safe line on TVs that still overscan.
const POSITIONS = {
    'top-left': { top: '3rem', left: '4rem' },
    'top-right': { top: '3rem', right: '4rem' },
    'bottom-left': { bottom: '3rem', left: '4rem' },
    'bottom-right': { bottom: '3rem', right: '4rem' }
};

const CLOCK_ID = 'tizentube-clock';

let actualClock;
let clockTimeout;
let lastText;

// String.prototype.padStart only landed in Chrome 57 and nothing polyfills it
// here, so the build's Chrome 47 target has to pad by hand.
function pad2(value) {
    return value < 10 ? `0${value}` : `${value}`;
}

function placeClock() {
    if (!actualClock) return;
    const position = POSITIONS[configRead('clockPosition')] || POSITIONS['top-right'];
    actualClock.style.top = '';
    actualClock.style.right = '';
    actualClock.style.bottom = '';
    actualClock.style.left = '';
    for (const side in position) {
        actualClock.style[side] = position[side];
    }
}

function updateClock() {
    if (!actualClock) return;
    const now = new Date();
    const is12HourFormat = configRead('isClock12HourFormat');
    const secondsEnabled = configRead('clockShowSeconds');

    let hours = now.getHours();
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

function scheduleTick() {
    // Re-armed against the wall clock rather than a fixed 1000ms period, so a
    // busy TV CPU cannot make the displayed minute drift behind the real one.
    clockTimeout = setTimeout(() => {
        updateClock();
        scheduleTick();
    }, 1000 - (Date.now() % 1000));
}

function stopClock() {
    if (clockTimeout) {
        clearTimeout(clockTimeout);
        clockTimeout = null;
    }
}

function toggleClock(value) {
    const existingClock = document.getElementById(CLOCK_ID);
    // Both states are already what was asked for; nothing to do.
    if (Boolean(value) === Boolean(existingClock)) return;

    if (!value) {
        stopClock();
        existingClock.remove();
        actualClock = null;
        lastText = null;
        return;
    }

    // Belt and braces: a timer from an earlier enable must never outlive it.
    stopClock();

    actualClock = document.createElement('div');
    actualClock.id = CLOCK_ID;

    actualClock.style.position = 'fixed';
    // Below .ytaf-ui-container (1000) so TizenTube's own panels are never
    // stamped over, but composited so the video plane cannot occlude it.
    actualClock.style.zIndex = '900';
    actualClock.style.transform = 'translateZ(0)';
    actualClock.style.fontSize = '2rem';
    actualClock.style.fontWeight = '500';
    actualClock.style.lineHeight = '1';
    actualClock.style.color = '#fff';
    actualClock.style.padding = '0.25rem 0.75rem';
    actualClock.style.borderRadius = '0.5rem';
    // A dark scrim plus a shadow: white text alone disappears over a snowy or
    // daylight frame, and TV gamma blooms the highlights on top of that.
    // 0.6 puts white-on-scrim at 5.7:1 over a white frame; 0.45 measured only
    // 3.4:1, which is the large-text floor with nothing left for TV gamma. A
    // darker scrim costs nothing over dark content, where it is invisible.
    actualClock.style.backgroundColor = 'rgba(0, 0, 0, 0.6)';
    actualClock.style.textShadow = '0 2px 6px rgba(0, 0, 0, 0.9), 0 0 2px rgba(0, 0, 0, 0.9)';
    actualClock.style.pointerEvents = 'none';

    placeClock();
    document.body.appendChild(actualClock);

    lastText = null;
    updateClock();
    scheduleTick();
}

toggleClock(configRead('enableClock'));
