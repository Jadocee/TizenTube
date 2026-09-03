/*global navigate*/
import '../spatial-navigation-polyfill.js';
// We handle key events ourselves. This has to happen at module scope, not in
// execute_once_dom_loaded: the polyfill arms its own arrow handler on `load`
// and defaults to ARROW, while that function waits for a <video> to exist --
// so between the two, every arrow press was handled twice. Guarded because the
// polyfill returns early leaving this undefined when the engine ships spatial
// navigation natively, and an unguarded throw here would abort the bundle.
if (window.__spatialNavigation__) window.__spatialNavigation__.keyMode = 'NONE';
import css from './ui.css';
import { configChangeEmitter, configRead, configWrite } from '../config.js';
import updateStyle from './theme.js';
import { showToast } from './ytUI.js';
import modernUI from './settings.js';
import resolveCommand, { patchResolveCommand } from '../resolveCommand.js';
import { pipToFullscreen } from '../features/pictureInPicture.js';
import getCommandExecutor from './customCommandExecution.js';
import { recordStartupError, clearStartupError } from './startupError.js';
import { setStyleBlock } from './styleSheet.js';
import { startFocusMotion } from '../features/focusMotion.js';
import { notePreviewMove } from './previewIndicator.js';
import { armReselect } from '../features/guideReselectRuntime.js';
import { registerThemePanelCloser } from './themePanelHost.js';
import { t } from 'i18next';

/**
 * Whatever the TV app currently has focused. The panel's own controls are all
 * `<input>`, and the checks below read those fields off anything else too --
 * on a non-input they simply come back undefined, which is what the code
 * relies on.
 */
type FocusedElement = HTMLElement & Partial<HTMLInputElement>;

/**
 * A key event as it reaches the panel.
 *
 * When the app re-dispatches a key, it synthesises a fresh event and hangs the
 * ORIGINAL on a minified field of its own -- so `evt.key` on the clone can be
 * empty while the real key is one level down. Neither name is part of the DOM,
 * and both are minified, so both are optional and read defensively.
 *
 * MEASURED against the shipped bundle: the field is `ge`. THREE sites assign
 * it -- a synthesised swipe, a synthesised MouseEvent, and `_.bo`, which is the
 * app's own KEY-event synthesiser and therefore the one that matters here; all
 * three do `clone.ge = original`.
 *
 * `Uc`, which this interface used to name on its own, is not an event field in
 * this build. (An earlier version of this comment said all 14 of its textual
 * occurrences were html5 player experiment values; that was wrong twice over --
 * six are substrings of `_.Ucb`, `.Uca` and a CSS class, and the eight real
 * accesses are player-internal data of several kinds: two experiment values,
 * two caption ids on videoData, two buffer thresholds, a default width and a
 * thumbnail prop.) None sits on an event object, so the old fallback could
 * never fire. It is kept only because it costs nothing and may have been the
 * name in an earlier bundle; the primary `evt.key` check is what carries this.
 */
interface TvKeyboardEvent extends KeyboardEvent {
    ge?: { key?: string };
    Uc?: { key?: string };
}

/** The original key behind a re-dispatched event, if the app kept one. */
function originalKey(evt: KeyboardEvent): string | undefined {
    const wrapped = evt as TvKeyboardEvent;
    return wrapped.ge?.key ?? wrapped.Uc?.key;
}

/** YouTube's player element. Its state API is the app's own, not the DOM's. */
interface Html5VideoPlayer extends Element {
    getPlayerStateObject?: () => { isPlaying?: boolean };
}

// It just works, okay?
const interval = setInterval(() => {
    const videoElement = document.querySelector('video');
    if (!videoElement) return;

    // Cleared before the body runs, not after. A throw in here used to leave the
    // timer armed, so startup re-ran every 250ms -- firing another
    // SOFT_RELOAD_PAGE, appending another copy of the stylesheet, adding another
    // panel and three more key listeners on each pass, and never patching
    // resolveCommand. The visible result is an app that never finishes painting.
    clearInterval(interval);

    try {
        execute_once_dom_loaded();
        clearStartupError();
    } catch (e) {
        console.error('TizenTube: startup failed', e);
        // Readable afterwards under TizenTube Settings, since a TV has no console.
        recordStartupError(e);
    }

    try {
        patchResolveCommand();
    } catch (e) {
        console.error('TizenTube: could not patch resolveCommand', e);
        // As above: clearStartupError() has just wiped the previous boot's
        // breadcrumb, so without this a run that gets here leaves no trace at all.
        recordStartupError(e);
    }
}, 250);

let keyTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Returns true only when the value is something CSS will actually paint, so a
 * half-typed hex code from the on-screen keyboard can never blank the theme.
 */
function isValidColor(value: string): boolean {
    if (!value) return false;
    const probe = document.createElement('div');
    probe.style.backgroundColor = '';
    probe.style.backgroundColor = value;
    return probe.style.backgroundColor !== '';
}

function setIdleOpacity(value: string): void {
    const container = document.getElementById('container');
    if (container) container.style.setProperty('opacity', value, 'important');
    // The mod's own overlays are siblings of #container, so dimming would
    // otherwise skip exactly the elements that are bright, static and in a fixed
    // position for hours. Found by class rather than by id: this used to look the
    // clock up by name, so the next overlay added -- the preview indicator -- would
    // silently have been the one thing left lit on a dimmed screen.
    const overlays = document.querySelectorAll<HTMLElement>('.tt-dimmable');
    for (const overlay of overlays) overlay.style.setProperty('opacity', value, 'important');
}

function isVideoPlaying(): boolean {
    const videoPlayer = document.querySelector<Html5VideoPlayer>('.html5-video-player');
    if (!videoPlayer || typeof videoPlayer.getPlayerStateObject !== 'function') return false;
    try {
        return !!videoPlayer.getPlayerStateObject().isPlaying;
    } catch (_e) {
        return false;
    }
}

/** Wakes the screen back up and re-arms the idle dimming timer. */
function resetScreenDimming(): void {
    if (keyTimeout) {
        clearTimeout(keyTimeout);
        keyTimeout = null;
    }
    if (!configRead('enableScreenDimming')) return;

    setIdleOpacity('1');
    keyTimeout = setTimeout(() => {
        keyTimeout = null;
        // Re-armed, not dropped: this was the only thing that ever scheduled the
        // timer, so firing once during playback stopped dimming until the next
        // keypress. resetScreenDimming() re-reads both settings, so a mid-video
        // change is still honoured.
        if (isVideoPlaying()) {
            resetScreenDimming();
            return;
        }
        setIdleOpacity((1 - configRead('dimmingOpacity')).toString());
    }, configRead('dimmingTimeout') * 1000);
}

configChangeEmitter.addEventListener('configChange', (evt) => {
    if (evt.detail.key !== 'enableScreenDimming') return;
    if (evt.detail.value) {
        resetScreenDimming();
    } else {
        // Turning dimming off while the screen is dim must not leave it dim.
        if (keyTimeout) {
            clearTimeout(keyTimeout);
            keyTimeout = null;
        }
        setIdleOpacity('1');
    }
});

function execute_once_dom_loaded(): void {
    // Add CSS to head.

    setStyleBlock('ui', css);

    // Fix UI issues.
    //
    // These six switches decide whether the home page glides between tiles or
    // jumps, which is the single most-felt property of the surface on a D-pad.
    // They used to be six statements in one bare try/catch, each dereferencing
    // window.tectonicConfig -- so if the app had not published that object by the
    // time this ran, the first line threw and the other five never happened,
    // silently, on a device with no console. They now apply independently and
    // retry while the object fills in.
    startFocusMotion();

    var ARROW_KEY_CODE: Record<number, 'left' | 'up' | 'right' | 'down'> = {
        37: 'left',
        38: 'up',
        39: 'right',
        40: 'down',
    };

    var uiContainer = document.createElement('div');
    uiContainer.classList.add('ytaf-ui-container');
    // Set inline, not in ui.css: the polyfill's readCssVar reads
    // element.style.getPropertyValue, not the cascade, so a stylesheet
    // declaration was never visible to it.
    uiContainer.style.setProperty('--spatial-navigation-contain', 'contain');
    uiContainer.style.display = 'none';
    uiContainer.setAttribute('tabindex', '0');
    // What had focus before the panel opened, so it can be handed back on close.
    let previouslyFocused: FocusedElement | null = null;

    function firstControl() {
        return uiContainer.querySelector('input');
    }

    function showPanel() {
        const active = document.activeElement as FocusedElement | null;
        previouslyFocused = active && active !== document.body ? active : null;

        // Re-read the stored colours: they can have been changed from the
        // TizenTube settings menu since the panel was last opened.
        const barColor = uiContainer.querySelector<HTMLInputElement>('#__barColor');
        const routeColor = uiContainer.querySelector<HTMLInputElement>('#__routeColor');
        if (barColor) {
            barColor.value = configRead('focusContainerColor');
            uiContainer.querySelector<HTMLElement>('#__barColorSwatch')!.style.backgroundColor =
                configRead('focusContainerColor');
        }
        if (routeColor) {
            routeColor.value = configRead('routeColor');
            uiContainer.querySelector<HTMLElement>('#__routeColorSwatch')!.style.backgroundColor =
                configRead('routeColor');
        }

        // 'flex', not 'block': the panel's row spacing is `gap` on this container,
        // and an inline `display: block` here would beat the stylesheet and make the
        // gap inert, collapsing the rows into one slab. Everything that reads this
        // back only ever compares it against 'none' (hidePanel, the two keydown
        // guards below, and speedUI), so the value itself is free to change.
        uiContainer.style.display = 'flex';
        uiContainer.focus();
        // Land on a real control: the focus style is a descendant selector, so a
        // focused container would leave the panel looking like nothing is selected.
        const control = firstControl();
        if (control) control.focus();
    }

    // speedUI has to close this panel too, and cannot import this file: the graph
    // already runs ui -> resolveCommand -> speedUI, so that import would close a
    // cycle. It registers instead, and gets the real hidePanel rather than a
    // copy of its first two lines.
    function hidePanel() {
        uiContainer.style.display = 'none';
        uiContainer.blur();
        // Give focus back to the app; leaving nothing focused makes the remote
        // look dead until the user guesses their way back into the page.
        if (previouslyFocused && document.body.contains(previouslyFocused)) {
            try {
                previouslyFocused.focus();
            } catch (_e) {}
        }
        previouslyFocused = null;

        // YouTube re-renders its shelves constantly, so the element captured when
        // the panel opened may no longer exist. Hand focus to whatever the app is
        // currently showing rather than leaving it on <body>.
        const active = document.activeElement;
        if (!active || active === document.body) {
            // Tried in order of preference. A selector list hands back the first
            // match in DOCUMENT order, not the first arm that matches, so the old
            // single query almost always returned the earliest focusable element on
            // the page rather than the app's current selection. .zylon-focus is a
            // state class and is not guaranteed focusable, hence the check that
            // focus actually landed before stopping.
            for (const sel of [
                '.zylon-focus[hybridnavfocusable="true"]',
                '.zylon-focus',
                '[hybridnavfocusable="true"]',
            ]) {
                const el = document.querySelector<HTMLElement>(sel);
                if (!el) continue;
                try {
                    el.focus();
                } catch (_e) {}
                if (document.activeElement && document.activeElement !== document.body) break;
            }
        }
    }

    // Registered here rather than exported: speedUI's BLUE handler needs the real
    // close, focus hand-back and all, and cannot import this module without
    // closing the ui -> resolveCommand -> speedUI cycle.
    registerThemePanelCloser(hidePanel);

    uiContainer.addEventListener(
        'keydown',
        (evt) => {
            if (evt.keyCode !== 404 && evt.keyCode !== 172) {
                // Nothing is guaranteed to be focused, so every branch below works off
                // this one nullable lookup instead of dereferencing it blind.
                const focusedElement = document.activeElement as FocusedElement | null;
                const isTextInput = !!focusedElement && focusedElement.type === 'text';

                if (evt.keyCode in ARROW_KEY_CODE) {
                    // Consumed before navigating: navigate() walks the live YouTube DOM,
                    // and a throw in there must not leak the arrow to the page behind the
                    // panel or skip the containment restore below.
                    evt.preventDefault();
                    evt.stopPropagation();
                    try {
                        navigate(ARROW_KEY_CODE[evt.keyCode]);
                    } catch (e) {
                        console.warn('spatial navigation failed:', e);
                    }
                    // navigate() searches the whole page, so focus can walk out of the
                    // panel. The container itself counts as outside: the focus style is a
                    // descendant selector, so resting there highlights no row.
                    const active = document.activeElement;
                    if (!active || active === uiContainer || !uiContainer.contains(active)) {
                        const target =
                            focusedElement &&
                            focusedElement !== uiContainer &&
                            uiContainer.contains(focusedElement)
                                ? focusedElement
                                : firstControl();
                        if (target) target.focus();
                    }
                    return;
                } else if (evt.keyCode === 13 || evt.keyCode === 32) {
                    // "OK" button
                    if (focusedElement && focusedElement.type === 'checkbox') {
                        focusedElement.checked = !focusedElement.checked;
                        focusedElement.dispatchEvent(new Event('change'));
                        evt.preventDefault();
                        evt.stopPropagation();
                        return;
                    }
                    if (!isTextInput) {
                        evt.preventDefault();
                        evt.stopPropagation();
                        return;
                    }
                    // On a text field, OK is what summons the TV's on-screen keyboard,
                    // so its default action has to survive. Keep YouTube out of it, and
                    // fall through to the Enter handling below.
                    evt.stopPropagation();
                } else if (evt.keyCode === 27) {
                    // BACK closes, unconditionally. It used to double as a backspace
                    // whenever a text field had focus -- and every control this panel has
                    // is a text field, so once focus landed on one the panel could not be
                    // closed by the key its own hint names. Text is edited with the TV's
                    // on-screen keyboard, which OK now opens.
                    hidePanel();
                    // Closing the panel must not also navigate YouTube back a page.
                    evt.preventDefault();
                    evt.stopPropagation();
                    return;
                }

                if (evt.key === 'Enter' || originalKey(evt) === 'Enter') {
                    // If the focused element is a text input, emit a change event.
                    if (isTextInput) {
                        focusedElement!.dispatchEvent(new Event('change'));
                    }
                }
            }
        },
        true,
    );

    try {
        uiContainer.innerHTML = `
<h1>${t('themePanel.title')}</h1>
<p class="ytaf-ui-subtitle">${t('themePanel.subtitle')}</p>
<label class="ytaf-ui-row" for="__barColor">
  <span class="ytaf-ui-row-label">${t('themePanel.barColor')}</span>
  <span class="ytaf-ui-row-value">
    <span class="ytaf-ui-swatch" id="__barColorSwatch"></span>
    <input type="text" id="__barColor"/>
  </span>
</label>
<label class="ytaf-ui-row" for="__routeColor">
  <span class="ytaf-ui-row-label">${t('themePanel.routeColor')}</span>
  <span class="ytaf-ui-row-value">
    <span class="ytaf-ui-swatch" id="__routeColorSwatch"></span>
    <input type="text" id="__routeColor"/>
  </span>
</label>
<div class="ytaf-ui-hint">${t('themePanel.hint')}</div>
`;
        document.querySelector('body')!.appendChild(uiContainer);

        const bindColorInput = (
            inputId: string,
            swatchId: string,
            configKey: 'focusContainerColor' | 'routeColor',
        ) => {
            const input = uiContainer.querySelector<HTMLInputElement>(inputId)!;
            const swatch = uiContainer.querySelector<HTMLElement>(swatchId)!;

            input.value = configRead(configKey);
            swatch.style.backgroundColor = configRead(configKey);

            input.addEventListener('change', (evt) => {
                const value = (evt.target as HTMLInputElement).value.trim();
                if (!isValidColor(value)) {
                    // Put the stored colour back rather than writing something the TV
                    // would render as transparent.
                    (evt.target as HTMLInputElement).value = configRead(configKey);
                    return;
                }
                configWrite(configKey, value);
                swatch.style.backgroundColor = value;
                updateStyle();
            });
        };

        bindColorInput('#__barColor', '#__barColorSwatch', 'focusContainerColor');
        bindColorInput('#__routeColor', '#__routeColorSwatch', 'routeColor');
    } catch (_e) {}

    var eventHandler = (evt: KeyboardEvent) => {
        // Deliberately not logging every event here: this handler is registered for
        // keydown, keypress and keyup, and speedUI.js registers three more, so a
        // single press used to produce six logs before any keyCode was even tested.
        // The branches below log when they actually act.

        // A single press arrives as keydown, keypress and keyup; re-arming the idle
        // timer once per press is enough.
        if (evt.type === 'keydown') {
            resetScreenDimming();
            // A real D-pad press, as opposed to the focus move the app makes for
            // itself when it starts a preview. Fed in here rather than from a
            // listener of our own: this handler already sees every keydown, and the
            // file's own comment records that the page is carrying six listeners
            // already.
            notePreviewMove();
            // OK, on the sidebar. The app deliberately dispatches nothing when you
            // select the entry for the page you are already on, so there is no command
            // to intercept -- this arms a check that notices the absence. Same
            // listener as above; nothing new is registered.
            if (evt.keyCode === 13) armReselect();
        }
        if (evt.keyCode === 403) {
            console.info('Taking over!');
            evt.preventDefault();
            evt.stopPropagation();
            if (evt.type === 'keydown') {
                try {
                    if (uiContainer.style.display === 'none') {
                        console.info('Showing and focusing!');
                        showPanel();
                    } else {
                        console.info('Hiding!');
                        hidePanel();
                    }
                } catch (_e) {}
            }
            return false;
        } else if (evt.keyCode === 404 || evt.keyCode === 172) {
            // Consumed the same way as RED above, so YouTube does not act on it too.
            evt.preventDefault();
            evt.stopPropagation();
            if (evt.type === 'keydown') {
                // The panel is not on YouTube's popup stack, so leaving it up would
                // strand it over the settings menu with focus gone from it for good.
                if (uiContainer.style.display !== 'none') hidePanel();
                modernUI();
            }
            return false;
        } else if (evt.keyCode === 39) {
            // Right key, for PiP
            if (evt.type === 'keydown' && uiContainer.style.display === 'none') {
                // Checked first: this runs on every right press, and the flag is far
                // cheaper than a DOM query.
                if (
                    window.isPipPlaying &&
                    document.querySelector('ytlr-search-text-box > .zylon-focus')
                ) {
                    const ytlrPlayer = document.querySelector<HTMLElement>('ytlr-player');
                    if (ytlrPlayer)
                        ytlrPlayer.style.setProperty('background-color', 'rgb(0, 0, 0)');
                    pipToFullscreen();
                    // Only consumed once the branch has decided to act, so an ordinary
                    // right press still moves YouTube's own selection.
                    evt.preventDefault();
                    evt.stopPropagation();
                    return false;
                }
            }
        }
        return true;
    };

    // Colour keys. Red opens the theme panel, Green the settings menu; Blue is
    // handled in speedUI.js. Yellow is deliberately unbound.
    // Red 403 | Green 404 or 172 | Yellow 405 or 170 | Blue 406 or 191
    document.addEventListener('keydown', eventHandler, true);
    document.addEventListener('keypress', eventHandler, true);
    document.addEventListener('keyup', eventHandler, true);

    // Armed here rather than waiting for the first keypress. Placed before the
    // startup-command block below so a throw there cannot skip it; no-ops when
    // the setting is off.
    resetScreenDimming();
    if (configRead('showWelcomeToast')) {
        setTimeout(() => {
            showToast(t('welcomeMsg.title'), t('welcomeMsg.subtitle'));
        }, 2000);
    }

    if (configRead('reloadHomeOnStartup')) {
        if (configRead('launchToOnStartup')) {
            resolveCommand(JSON.parse(configRead('launchToOnStartup')));
        } else {
            resolveCommand({
                signalAction: {
                    signal: 'SOFT_RELOAD_PAGE',
                },
            });
        }
    }

    const commandExecutor = getCommandExecutor();
    if (commandExecutor) {
        commandExecutor.executeFunction(new commandExecutor.commandFunction('reloadGuideAction'));
    }

    // Fix UI issues, again. Love, Googol.

    if (configRead('enableFixedUI')) {
        try {
            const observer = new MutationObserver((_, _2) => {
                const body = document.body;
                if (body.classList.contains('app-quality-root')) {
                    body.classList.remove('app-quality-root');
                }
            });
            observer.observe(document.body, { attributes: true, childList: false, subtree: false });
        } catch (_e) {}
    }
}
