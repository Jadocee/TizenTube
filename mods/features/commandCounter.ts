// How many commands the app has routed through the mod's resolveCommand wrapper.
//
// Its own module, with no imports, for two reasons. It breaks what would
// otherwise be a cycle -- resolveCommand.ts has to call it, and the sidebar
// runtime that reads it has to call resolveCommand. And it keeps the counter
// reachable from a Node harness without dragging in the whole command router.
//
// The number itself is meaningless; only whether it MOVED between two readings
// matters. That is the sidebar refresh's evidence that a keypress dispatched
// something, and therefore was a real navigation rather than a re-selection of
// the page already open.

let count = 0;

/** Called from the resolveCommand wrapper, before any branch that returns. */
export function noteCommand(): void {
    // Wraps rather than overflowing into imprecision: a session cannot realistically
    // route two billion commands, but a counter that silently stops incrementing
    // would make every press look like a re-selection.
    count = (count + 1) % 0x7fffffff;
}

export function commandCount(): number {
    return count;
}
