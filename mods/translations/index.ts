import i18n from 'i18next';
import resources from './i18nResources.js';

function youtubeLanguage(): string | undefined {
    return window?.yt?.config_?.HL;
}

// The tag goes through whole. Stripping the region here sent every
// region-qualified locale we ship -- pt-BR, pt-PT, es-419, zh-TW, sr-Latn --
// to English instead, because i18next does not widen a bare code back out to a
// qualified resource. Its own resolve hierarchy does the narrowing, so de-DE
// still lands on de.
InitI18next(youtubeLanguage() || navigator.language);

// The userscript is injected ahead of YouTube's own bundle, so yt.config_ does
// not exist yet and the line above falls back to the device language. That is
// not always the same as the account language the rest of the interface is in,
// so adopt YouTube's once it publishes one. Menus are built on demand, long
// after this resolves.
if (!youtubeLanguage()) {
    let tries = 0;
    const timer = setInterval(() => {
        const hl = youtubeLanguage();
        if (!hl) {
            if (++tries > 120) clearInterval(timer);
            return;
        }
        clearInterval(timer);
        if (hl !== i18n.language) i18n.changeLanguage(hl);
    }, 250);
}

function InitI18next(lng: string): void {
    i18n.init({
        lng,
        fallbackLng: 'en',
        resources,
        debug: false,
        interpolation: {
            escapeValue: false,
        },
    });
}
export default i18n;
