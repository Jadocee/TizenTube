// TizenTube's own stylesheet.
//
// ui.css and the theme rules used to be written into the page's own nonced
// <style> element by assigning to its textContent. That works, but assigning
// textContent rebuilds YouTube's stylesheet from its text -- and any rule the
// app inserted through the CSSOM (insertRule) lives only in the parsed sheet,
// not in that text, so it is silently destroyed. It also re-parses YouTube's
// entire stylesheet on every theme change.
//
// Our rules go in an element of our own instead, held as named blocks so a
// block can be replaced without disturbing the others.

const blocks: Record<string, string> = {};
const order: string[] = [];

let ownStyle: HTMLStyleElement | null = null;
let ownStyleUsable: boolean | undefined;
// What we last wrote into the page's stylesheet, on the fallback path only.
let fallbackCss = '';

function pageStyle(): HTMLStyleElement | null {
    return document.querySelector('style[nonce]');
}

function readNonce(element: HTMLStyleElement | null): string {
    if (!element) return '';
    // Chrome stopped exposing the nonce content attribute to getAttribute() in
    // 61 and moved it to the IDL property; Chrome 47, which this build targets,
    // only has the attribute. Try both.
    return element.nonce || element.getAttribute('nonce') || '';
}

function ensureOwnStyle(): HTMLStyleElement | null {
    if (ownStyle) return ownStyle;

    const parent = document.head || document.documentElement;
    // Nothing to attach to yet. Not cached, so the next write retries.
    if (!parent) return null;

    const style = document.createElement('style');

    // A strict CSP only honours a <style> carrying the page's nonce, and it has
    // to be set before the element is inserted.
    const nonce = readNonce(pageStyle());
    // No nonce and no page stylesheet, while the document is still parsing its
    // head, means YouTube's may still be coming -- and the nonce has to be set
    // before insertion to count, so an element created now would be permanently
    // nonce-less. Leave ownStyle null and let the next write build it properly.
    // Once <body> exists the head is complete: absent then means absent, and a
    // page with no CSP at all still gets our element.
    if (!nonce && !pageStyle() && !document.body) return null;
    if (nonce) {
        style.setAttribute('nonce', nonce);
        try {
            style.nonce = nonce;
        } catch (e) { }
    }

    parent.appendChild(style);
    ownStyle = style;
    return ownStyle;
}

function render(): string {
    let css = '';
    for (const name of order) css += blocks[name];
    return css;
}

/**
 * Adds or replaces one named block of TizenTube's CSS. Blocks render in the
 * order they were first set.
 */
export function setStyleBlock(name: string, css: string): void {
    if (!(name in blocks)) order.push(name);
    blocks[name] = css;

    const style = ensureOwnStyle();
    if (style) {
        style.textContent = render();
        // A null sheet means CSP rejected the element. Anything else means our
        // rules took, and YouTube's stylesheet is never touched.
        // Re-tested until it succeeds once. Latching on the first call recorded
        // a verdict from before there was a nonce to copy, and then never
        // revisited it -- so one early write condemned every later one to the
        // destructive fallback below.
        if (ownStyleUsable !== true) ownStyleUsable = !!style.sheet;
        if (ownStyleUsable) return;
    }

    // Last resort, and only when our own element was refused: write into the
    // page's stylesheet, swapping out whatever we put there last so the rules
    // cannot stack up. This is the destructive path described above, taken
    // because losing the styling entirely is worse.
    const existingStyle = pageStyle();
    if (!existingStyle) return;

    const css2 = render();
    existingStyle.textContent = fallbackCss
        // A function replacement, so a '$' in a stored colour cannot be read as
        // a replacement pattern.
        ? existingStyle.textContent.replace(fallbackCss, () => css2)
        : existingStyle.textContent + css2;
    fallbackCss = css2;
}
