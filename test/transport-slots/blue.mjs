// The BLUE key closing the theme panel, driven through the real handler.
//
// WHY THIS IS SEPARATE from the registry's own tests next door: those prove the
// registry works, and they go on passing with speedUI back to inlining
// `display = 'none'; blur()` and skipping the focus hand-back -- which IS the
// bug. Proven, not assumed: reverting speedUI to the inline close leaves the
// registry harness green and fails this one.
//
// The panel is a plain overlay rather than a YouTube popup, so BLUE has to close
// it before opening the speed menu or it is stranded on screen. ui.ts owns the
// real close, and speedUI cannot import ui.ts -- ui -> resolveCommand -> speedUI
// is already a chain, so that import would close a cycle.
import { checker } from '../lib/repo.mjs';

// --- fakes, installed before the module is imported -------------------------
let clock = 0;
const timers = new Map();
let seq = 0;
globalThis.setInterval = (fn, ms) => {
    const id = ++seq;
    timers.set(id, { every: ms || 0, fn, next: clock + (ms || 0) });
    return id;
};
globalThis.clearInterval = (id) => timers.delete(id);
globalThis.setTimeout = (fn) => {
    const id = ++seq;
    timers.set(id, { every: 0, fn, next: clock, once: true });
    return id;
};
globalThis.clearTimeout = (id) => timers.delete(id);
function tick(ms) {
    const until = clock + ms;
    for (let guard = 0; guard < 1000; guard++) {
        let next = null;
        for (const [id, t] of timers)
            if (t.next <= until && (!next || t.next < next[1].next)) next = [id, t];
        if (!next) break;
        clock = next[1].next;
        if (next[1].once) timers.delete(next[0]);
        else next[1].next = clock + next[1].every;
        next[1].fn();
    }
    clock = until;
}

const listeners = new Map();
const panel = {
    style: { display: 'flex' },
    blurred: 0,
    blur() {
        this.blurred++;
    },
};
const video = { addEventListener: () => {}, playbackRate: 1 };
globalThis.document = {
    querySelector: (sel) =>
        sel === 'video' ? video : sel.includes('ytaf-ui-container') ? panel : null,
    getElementsByTagName: () => [video],
    addEventListener: (type, fn, capture) => {
        const key = `${type}:${capture ? 'c' : 'b'}`;
        if (!listeners.has(key)) listeners.set(key, new Set());
        listeners.get(key).add(fn);
    },
    removeEventListener: () => {},
};

const host = await import('./panelHost.generated.mts');
await import('./speedUI.generated.mts');

const { check, done } = checker();

// The module polls for a <video> once a second before binding its keys.
check('nothing is bound before the video exists', listeners.size, 0);
tick(1000);
check('the key handlers bind once it does', listeners.has('keydown:c'), true);

/** Press BLUE, the way the app's capture-phase handler would see it. */
function pressBlue(keyCode = 406) {
    let prevented = 0;
    const evt = {
        type: 'keydown',
        keyCode,
        preventDefault: () => prevented++,
        stopPropagation: () => {},
    };
    for (const fn of listeners.get('keydown:c') || []) fn(evt);
    return prevented;
}

// --- the fix ----------------------------------------------------------------
let closed = 0;
host.resetThemePanelCloser();
host.registerThemePanelCloser(() => {
    closed++;
    // What ui.ts's hidePanel really does, including the part speedUI used to
    // skip: hand focus back.
    panel.style.display = 'none';
});

panel.style.display = 'flex';
check('BLUE is handled', pressBlue() > 0, true);
check("  ...through ui.ts's own closer", closed, 1);
check('  ...which actually closed the panel', panel.style.display, 'none');
// The inline version blurred it directly. Going through the registry means the
// owner decides how to close, so speedUI must NOT be blurring it itself.
check('  ...and speedUI did not blur it behind the owner’s back', panel.blurred, 0);

// --- the panel is already closed --------------------------------------------
// hidePanel is not a no-op when the panel is shut: it hands focus somewhere the
// user did not ask for. So the DOM check has to gate the call.
closed = 0;
panel.style.display = 'none';
pressBlue();
check('a closed panel is not closed again', closed, 0);

// --- ui.ts has not initialised ----------------------------------------------
// Then there is no focus to hand back either, so hiding it is the whole job --
// and BLUE must still work rather than doing nothing.
host.resetThemePanelCloser();
panel.style.display = 'flex';
panel.blurred = 0;
check('BLUE still works with no closer registered', pressBlue() > 0, true);
check('  ...falling back to hiding it', panel.style.display, 'none');
check('  ...and blurring it, since nobody else will', panel.blurred, 1);

// The second BLUE keycode the remote can send.
host.resetThemePanelCloser();
closed = 0;
host.registerThemePanelCloser(() => closed++);
panel.style.display = 'flex';
check('191 is BLUE too', pressBlue(191) > 0, true);
check('  ...and closes the same way', closed, 1);

// An unrelated key must not touch the panel.
closed = 0;
panel.style.display = 'flex';
check('an unrelated key is not handled', pressBlue(403), 0);
check('  ...and leaves the panel alone', panel.style.display, 'flex');

done();
