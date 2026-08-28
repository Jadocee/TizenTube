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

const blocks = {};
const order = [];

let ownStyle = null;
let ownStyleUsable;
// What we last wrote into the page's stylesheet, on the fallback path only.
let fallbackCss = '';

function pageStyle() {
    return document.querySelector('style[nonce]');
}

function readNonce(element) {
    if (!element) return '';
    // Chrome stopped exposing the nonce content attribute to getAttribute() in
    // 61 and moved it to the IDL property; Chrome 47, which this build targets,
    // only has the attribute. Try both.
    return element.nonce || element.getAttribute('nonce') || '';
}

function ensureOwnStyle() {
    if (ownStyle) return ownStyle;

    const parent = document.head || document.documentElement;
    // Nothing to attach to yet. Not cached, so the next write retries.
    if (!parent) return null;

    const style = document.createElement('style');

    // A strict CSP only honours a <style> carrying the page's nonce, and it has
    // to be set before the element is inserted.
    const nonce = readNonce(pageStyle());
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

function render() {
    let css = '';
    for (const name of order) css += blocks[name];
    return css;
}

/**
 * Adds or replaces one named block of TizenTube's CSS. Blocks render in the
 * order they were first set.
 */
export function setStyleBlock(name, css) {
    if (!(name in blocks)) order.push(name);
    blocks[name] = css;

    const style = ensureOwnStyle();
    if (style) {
        style.textContent = render();
        // A null sheet means CSP rejected the element. Anything else means our
        // rules took, and YouTube's stylesheet is never touched.
        if (ownStyleUsable === undefined) ownStyleUsable = !!style.sheet;
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
