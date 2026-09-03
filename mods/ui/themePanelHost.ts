// A one-entry registry for closing the theme panel.
//
// NO IMPORTS, deliberately -- both so test/refresh.mjs can lift it verbatim and,
// more importantly, because being import-free is the whole point: it is what
// lets two modules that must not import each other share one function.
//
// THE PROBLEM IT SOLVES. ui.ts owns the theme panel and closes it with
// hidePanel(), which hides it, blurs it, and -- the part that matters -- hands
// focus back to whatever the app had before, falling back to whatever the app
// is showing now. Leaving nothing focused makes the remote look dead until the
// user guesses their way back into the page.
//
// speedUI.ts also has to close that panel: BLUE opens the speed menu, and the
// theme panel is a plain overlay rather than a YouTube popup, so opening a popup
// underneath it would strand it on screen. It was duplicating the first two
// lines of hidePanel and skipping the focus hand-back entirely.
//
// It could not simply import ui.js. The graph already runs
// ui.ts -> resolveCommand.ts -> speedUI.ts, so that import would close a cycle.
// Registration breaks it: ui.ts registers its closer, speedUI asks for one, and
// neither names the other.

type Closer = () => void;

let closer: Closer | null = null;

/** ui.ts calls this once, with its own hidePanel. */
export function registerThemePanelCloser(fn: Closer): void {
    if (typeof fn === 'function') closer = fn;
}

/**
 * Closes the theme panel the way its owner closes it.
 *
 * Returns whether anything was actually registered, so a caller can tell "closed
 * it" from "there was nothing to close" -- which are different, and only the
 * first should suppress whatever the caller was going to do next.
 *
 * Never throws: this runs from a key handler registered in capture phase on the
 * document, and an escape there would take the key with it.
 */
export function closeThemePanel(): boolean {
    if (!closer) return false;
    try {
        closer();
        return true;
    } catch (e) {
        console.warn('[TizenTube] the theme panel closer threw', e);
        return false;
    }
}

/** Test seam. Nothing in the mod calls this. */
export function resetThemePanelCloser(): void {
    closer = null;
}
