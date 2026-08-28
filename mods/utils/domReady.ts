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

    // ~10 seconds, which is far longer than the parser needs to reach <body>.
    let tries = 0;
    const timer = setInterval(() => {
        if (!document.body) {
            if (++tries > 200) clearInterval(timer);
            return;
        }
        clearInterval(timer);
        callback();
    }, 50);
}
