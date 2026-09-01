// Arms and resolves the sidebar re-select refresh.
//
// The decisions all live in guideReselect.ts, which a Node harness runs
// directly. What is here is the part that has to touch the page: reading the
// focused element, reading the hash, setting a timer, and emitting the one
// command this feature can ever emit.
//
// It emits SOFT_RELOAD_PAGE and nothing else. There is no branch that can
// navigate the user anywhere, and none that can swallow a navigation the app
// would otherwise have performed -- a dispatched command is precisely the signal
// to stand down.

import { configRead } from '../config.js';
import resolveCommand from '../resolveCommand.js';
import { commandCount } from './commandCounter.js';
import { RESELECT_WINDOW_MS, decide, shouldArm, type Snapshot } from './guideReselect.js';

/** The sidebar's own element names. Both are checked because the guide is
 *  `ytlr-guide-response` in the markup this repo already targets in theme.ts,
 *  and the entry rows sit inside it. A rename costs the feature and nothing
 *  else: shouldArm() returns false and the press behaves as it does today. */
const GUIDE_SELECTORS = ['ytlr-guide-response', 'ytlr-guide', '#guide'];

let pending: ReturnType<typeof setTimeout> | null = null;

/** Whether the sidebar currently contains the focused element. */
function guideFocused(): boolean {
    try {
        const active = document.activeElement;
        if (!active || active === document.body) return false;
        for (const selector of GUIDE_SELECTORS) {
            const guide = document.querySelector(selector);
            if (guide && guide.contains(active)) return true;
        }
        return false;
    } catch (_e) {
        return false;
    }
}

/**
 * A stable identity for the focused sidebar entry.
 *
 * Only used for comparison against itself a moment later, so it does not need to
 * be meaningful -- it needs to CHANGE when focus moves to a different entry.
 * Falls back through a few attributes so a rename of any one of them degrades to
 * a coarser identity rather than to none.
 */
function entryKey(): string | null {
    try {
        const active = document.activeElement as HTMLElement | null;
        if (!active) return null;
        const parts = [
            active.tagName,
            active.getAttribute('idomkey') || '',
            active.getAttribute('aria-label') || '',
            active.id || '',
            // Position among its siblings, which distinguishes two entries that
            // are otherwise identically described.
            String(Array.prototype.indexOf.call(active.parentElement?.children || [], active)),
        ];
        return parts.join('|');
    } catch (_e) {
        return null;
    }
}

function snapshot(): Snapshot {
    return { hash: location.hash, entryKey: entryKey() || '', commands: commandCount() };
}

/**
 * Called on every OK keydown from ui.ts's existing document listener.
 *
 * Arming is cheap and doing nothing is the default: every condition that fails
 * leaves the press exactly as it behaves today.
 */
export function armReselect(): void {
    if (pending !== null) {
        clearTimeout(pending);
        pending = null;
    }

    const before = snapshot();
    if (
        !shouldArm({
            enabled: configRead('refreshOnReselect'),
            guideFocused: guideFocused(),
            hash: before.hash,
            entryKey: before.entryKey,
        })
    )
        return;

    pending = setTimeout(() => {
        pending = null;
        if (decide(before, snapshot()) !== 'refresh') return;
        try {
            // The app's own network-error dialog uses this same signal for its
            // REFRESH button: it pops the current history entry and re-navigates
            // it, rather than pushing a duplicate.
            resolveCommand({ signalAction: { signal: 'SOFT_RELOAD_PAGE' } });
        } catch (e) {
            // The app throws from its reload path when the history entry it
            // finds does not match what it expects. The page is untouched, which
            // is the same outcome as not having tried.
            console.warn('[TizenTube] sidebar refresh could not reload the page', e);
        }
    }, RESELECT_WINDOW_MS);
}
