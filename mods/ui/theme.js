import { configChangeEmitter, configRead } from '../config.js';

const style = document.createElement('style');

// The block we last wrote into the page's own stylesheet. Kept so an update can
// swap it out instead of stacking another copy of the same rules every time.
let appendedCss = '';

function updateStyle() {
    const css = `
    ytlr-guide-response yt-focus-container {
        background-color: ${configRead('focusContainerColor')};
    }

    #container {
        background-color: ${configRead('routeColor')} !important;
    }
`;
    // The page ships a strict CSP, so a <style> of our own is only honoured
    // while the page has no nonced stylesheet to write into.
    const existingStyle = document.querySelector('style[nonce]');
    if (existingStyle) {
        existingStyle.textContent = appendedCss
            ? existingStyle.textContent.replace(appendedCss, css)
            : existingStyle.textContent + css;
        appendedCss = css;
    } else {
        style.textContent = css;
    }
};

configChangeEmitter.addEventListener('configChange', (e) => {
    if (e.detail.key === 'focusContainerColor' || e.detail.key === 'routeColor') {
        updateStyle();
    }
});

document.head.appendChild(style);
updateStyle();
export default updateStyle;
