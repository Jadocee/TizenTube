// The one place that wraps YouTube's PlaybackPreviewService.
//
// This is the mod's only class-name-free handle on inline preview playback: the
// service is looked up by name out of the app's own module registry rather than
// by any DOM selector, so it survives the CSS class churn that makes every other
// approach to "is this tile playing" fragile. Picture-in-picture has wrapped it
// since long before this file existed, and its suppression of previews while PiP
// is up is the production evidence that the hook works.
//
// Two things wanting to wrap the same two methods is a race whose outcome
// depends on module order, so there is one wrapper and everything else
// registers with it:
//
//   addPreviewVeto(fn)   -- return true to suppress start() and the teardown
//                           outright. This is picture-in-picture's behaviour.
//   onPreviewStart(fn)   -- called after a start() that was actually forwarded.
//   onPreviewStop(fn)    -- likewise for the teardown.
//
// Registration order does not matter: callers may register before the service
// exists, and the wrap picks them up when it installs.
//
// THE TEARDOWN IS NOT CALLED stop(). This file wrapped `service.stop` for its
// whole life, and the shipped service has no such method: its prototype carries
// start, end, isActive, pause, reset, select and togglePlaying. So the wrapper
// assigned a brand-new property nothing ever called, and onPreviewStop had
// never once fired -- every consecutive preview arrived as a start with no
// intervening stop, which is exactly the case the indicator's state machine
// handled worst. `end` is the real teardown (it cancels the timer, clears the
// active flags and runs the fade), and it is what the app calls.
//
// Both names are wrapped, and only the ones that exist. `stop` is kept because
// wrapping a method that is absent costs nothing and YouTube renames things;
// what is NOT kept is the assumption that one particular name is there.

type Veto = () => boolean;
type Listener = () => void;

const vetoes: Veto[] = [];
const startListeners: Listener[] = [];
const stopListeners: Listener[] = [];

export type HookStatus = 'pending' | 'hooked' | 'missing';

/** The teardown, in the order this build is likely to name it. `end` is what the
 *  shipped service has; `stop` is what this file used to assume it had. */
const TEARDOWN_METHODS = ['end', 'stop'] as const;

let status: HookStatus = 'pending';
let attempts = 0;
let teardownHooked = false;

/** Whether a teardown was found to wrap. False means onPreviewStop cannot fire
 *  and anything relying on it has to survive on its own -- which is worth
 *  knowing rather than discovering as a mark that never goes away. */
export function previewStopHooked(): boolean {
    return teardownHooked;
}

/** What happened when we went looking for the service. The settings panel shows
 *  this, because a television has no console and "the icon never appears" is
 *  otherwise indistinguishable from "the icon is broken". */
export function previewHookStatus(): HookStatus {
    return status;
}

export function addPreviewVeto(veto: Veto): void {
    if (typeof veto === 'function') vetoes.push(veto);
}

export function onPreviewStart(listener: Listener): void {
    if (typeof listener === 'function') startListeners.push(listener);
}

export function onPreviewStop(listener: Listener): void {
    if (typeof listener === 'function') stopListeners.push(listener);
}

function vetoed(): boolean {
    for (const veto of vetoes) {
        try {
            if (veto()) return true;
        } catch (_e) {
            // A broken veto must not be able to suppress playback, so it counts
            // as "no objection".
        }
    }
    return false;
}

function notify(listeners: Listener[]): void {
    for (const listener of listeners) {
        try {
            listener();
        } catch (_e) {
            // These run inside YouTube's own call stack. A listener that throws
            // would otherwise take the preview with it.
        }
    }
}

function install(): void {
    try {
        const mappings =
            window._yttv && Object.values(window._yttv).find((a: any) => a && a.mappings);
        // Having a `mappings` property does not make an entry the registry, and
        // the registry appears progressively as the app boots.
        if (!mappings || typeof mappings.get !== 'function') {
            if (++attempts <= 240) {
                setTimeout(install, 250);
            } else {
                status = 'missing';
            }
            return;
        }

        const service = mappings.get('PlaybackPreviewService');
        // Present registry, absent service. Keep retrying rather than giving up
        // here: the registry fills in over time, and returning at this point is
        // precisely the bug this file was factored out to fix -- it discarded
        // the retry the lines above had just established.
        if (!service) {
            if (++attempts <= 240) {
                setTimeout(install, 250);
            } else {
                status = 'missing';
            }
            return;
        }

        if (typeof service.start !== 'function') {
            // No start to wrap means this is not the service we think it is.
            // Retrying would be worse than saying so: the settings screen shows
            // this, and "missing" is a diagnosis where a silent no-op is not.
            status = 'missing';
            return;
        }

        const originalStart = service.start;
        service.start = function (this: any, ...args: any[]) {
            if (vetoed()) return;
            const result = originalStart.apply(this, args);
            notify(startListeners);
            return result;
        };

        // Whichever teardown names this build actually has. Wrapping an absent
        // one used to create it, which is worse than not wrapping: it looks
        // hooked and can never fire.
        for (const name of TEARDOWN_METHODS) {
            const original = service[name];
            if (typeof original !== 'function') continue;
            service[name] = function (this: any, ...args: any[]) {
                if (vetoed()) return;
                const result = original.apply(this, args);
                notify(stopListeners);
                return result;
            };
            teardownHooked = true;
        }

        status = 'hooked';
    } catch (err) {
        status = 'missing';
        console.warn('[TizenTube] could not hook the preview service:', err);
    }
}

// Same trigger as picture-in-picture used: the registry is a product of
// YouTube's own bundle, which has not run when the userscript is injected at
// document-start.
if (document.readyState === 'complete') {
    install();
} else {
    window.addEventListener('load', install);
}
