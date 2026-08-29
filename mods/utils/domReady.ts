/**
 * Runs the callback once document.body exists.
 *
 * The userscript is injected as the first script in <head> so that it wins the
 * race against YouTube's own bundle, which means modules are evaluated before
 * the parser has reached <body>. Anything that touches document.body at module
 * scope has to wait for it rather than assume it.
 */
export function whenBodyReady(callback: () => void): void {
    if (document.body) {
        callback();
        return;
    }

    // Keyed to the document, not to a stopwatch. This used to poll and give up
    // after ~10s "which is far longer than the parser needs to reach <body>" --
    // but the wait here is not parser speed. Running first in <head> means
    // YouTube's own multi-megabyte blocking head scripts have to download and
    // execute before <body> is reached, which on a cold TV can take longer than
    // that. Giving up silently left the clock and the PiP button simply absent.
    document.addEventListener('DOMContentLoaded', () => callback(), { once: true });
}
