// Selecting the sidebar entry for the page you are already on.
//
// The app deliberately does nothing there. Its guide select handler computes
// `f = selectedIndex === c` -- "is this already the selected entry?" -- and then
// guards the whole dispatch with `if (!f || _.KA)` and again with `if (!f || g)`
// where g is true only for a searchEndpoint. `_.KA` is a build bit
// (`!!(_.Mt[3]>>17&1)`), not something a userscript sets. So re-selecting an
// already-active BROWSE entry -- Home, Subscriptions, a topic -- reaches neither
// dispatch and emits no command at all.
//
// That is why this works by observing an ABSENCE rather than by intercepting a
// command: there is no command to intercept, and nothing in the payload to
// rewrite. A press is armed, and if nothing was dispatched, the hash did not
// move and focus did not move, then the press produced nothing and we supply the
// refresh ourselves.
//
// NO IMPORTS, deliberately: test/refresh.mjs lifts this file verbatim and a Node
// harness runs it as-is, so the timing and the stand-down conditions -- the parts
// that decide whether a press refreshes the page or is ignored -- are assertions
// rather than something only a television could reveal.

/**
 * How long to wait before concluding that a press dispatched nothing.
 *
 * The guide debounces its own dispatch by 150ms before calling resolveCommand,
 * so anything shorter than that would read a real navigation as an absence and
 * fire a reload into a page that is on its way out.
 */
export const RESELECT_WINDOW_MS = 400;

/** The guide's own debounce, which the window above has to clear. */
export const GUIDE_DEBOUNCE_MS = 150;

/** What was true at the moment the key went down. */
export interface Snapshot {
    /** location.hash, so a navigation that lands elsewhere is visible. */
    hash: string;
    /** Identifies the focused sidebar entry, so moving focus stands us down. */
    entryKey: string;
    /** How many commands the mod's resolveCommand wrapper had seen. */
    commands: number;
}

export type Decision = 'refresh' | 'none';

/**
 * Is this hash a surface a refresh makes sense on?
 *
 * Home is the empty hash or a bare slash -- the app's hash writer special-cases
 * `default` and `FEtopics` and writes no `c=` for them, so the live TV home is
 * simply `#/`. Everything else worth refreshing is `#/browse?c=<id>`.
 *
 * A watch or search route is deliberately excluded: the sidebar is not what put
 * you there, so a press that dispatches nothing on one of those is not a
 * re-selection and must not reload the player out from under a video.
 */
export function isRefreshableRoute(rawHash: string | null | undefined): boolean {
    if (typeof rawHash !== 'string') return false;
    const hash = rawHash.startsWith('#') ? rawHash.substring(1) : rawHash;
    if (hash === '' || hash === '/') return true;
    return hash.startsWith('/browse');
}

export interface ArmInput {
    enabled: boolean;
    /** Whether the sidebar currently holds DOM focus. */
    guideFocused: boolean;
    hash: string | null | undefined;
    /** Null when no sidebar entry could be identified. */
    entryKey: string | null | undefined;
}

/**
 * Whether a press is even a candidate.
 *
 * Every condition here is a reason NOT to arm, and failing to arm is exactly
 * today's behaviour -- so the whole function is biased towards doing nothing.
 */
export function shouldArm(input: ArmInput | null | undefined): boolean {
    if (!input) return false;
    if (!input.enabled) return false;
    if (!input.guideFocused) return false;
    if (typeof input.entryKey !== 'string' || input.entryKey === '') return false;
    return isRefreshableRoute(input.hash);
}

/**
 * What to do once the window has elapsed.
 *
 * The asymmetry this encodes: a wrong 'none' costs a refresh the user did not
 * have yesterday, and a wrong 'refresh' would reload a page they were navigating
 * away from. So every signal that anything at all happened -- a command reaching
 * the wrapper, the route moving, focus moving -- stands us down.
 */
export function decide(
    before: Snapshot | null | undefined,
    after: Snapshot | null | undefined,
): Decision {
    if (!before || !after) return 'none';
    // A dispatched command is the strongest possible evidence that the press was
    // a real navigation. It is checked first because it is the one signal that
    // is true even when the destination happens to share our hash.
    if (!Number.isFinite(before.commands) || !Number.isFinite(after.commands)) return 'none';
    if (after.commands !== before.commands) return 'none';
    if (after.hash !== before.hash) return 'none';
    if (after.entryKey !== before.entryKey) return 'none';
    // Re-checked rather than trusted from arm time: the route can have become a
    // watch page within the window without the hash comparison catching it, if
    // it also came back.
    if (!isRefreshableRoute(after.hash)) return 'none';
    return 'refresh';
}
