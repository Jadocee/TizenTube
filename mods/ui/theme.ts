import { configChangeEmitter, configRead } from '../config.js';
import { setStyleBlock } from './styleSheet.js';
import { whenBodyReady } from '../utils/domReady.js';

function updateStyle(): void {
    setStyleBlock(
        'theme',
        `
    ytlr-guide-response yt-focus-container {
        background-color: ${configRead('focusContainerColor')};
    }

    #container {
        background-color: ${configRead('routeColor')} !important;
    }
`,
    );
}

configChangeEmitter.addEventListener('configChange', (e) => {
    if (e.detail.key === 'focusContainerColor' || e.detail.key === 'routeColor') {
        updateStyle();
    }
});

// Deferred. At module scope this was the program's FIRST setStyleBlock call,
// running while the userscript is still the only element in <head> -- so
// TizenTube's <style> was created before YouTube's nonced one existed, taking
// no nonce and landing ahead of it in the cascade. document.body existing means
// </head> has been parsed, so the nonce is there to copy and our rules sit
// after YouTube's.
whenBodyReady(updateStyle);
export default updateStyle;
