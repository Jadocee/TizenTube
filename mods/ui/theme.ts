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

    /* NOT ON THE WATCH PAGE. The app ships
       .WEB_PAGE_TYPE_WATCH #container { background: none } precisely so the
       video plane shows through, and it also sets #container's inline
       backgroundColor to transparent when the player opens. An unscoped
       !important here beats BOTH -- a plain inline style loses to any important
       declaration -- so the container stayed an opaque fill over the video. It
       showed as the picture vanishing behind black whenever the player chrome
       came up, because that is when the app has #container displayed.

       Measured, not reasoned: on a WEB_PAGE_TYPE_WATCH body the unscoped rule
       computes rgb(15, 15, 15) and stays there even after the app's own inline
       write; scoped, it computes rgba(0, 0, 0, 0).

       The !important itself has to stay. It is not there to beat YouTube's
       stylesheet -- this block is inserted after it, so order would already
       decide -- but to beat that same inline write on the surfaces where the
       user's colour SHOULD win.

       A NEGATIVE GATE, deliberately, which is the opposite of what bubbles.css
       argues and does not contradict it. There the question was where a
       decoration may appear, and a new page type arriving with it uninvited is
       a bug. Here the setting means "colour the app", so a new page type
       arriving with the user's chosen colour is the feature working. Watch is
       the one surface the app itself carves out, so it is the one exception
       worth naming. */
    body:not(.WEB_PAGE_TYPE_WATCH) #container {
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
