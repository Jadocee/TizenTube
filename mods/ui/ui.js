/*global navigate*/
import '../spatial-navigation-polyfill.js';
import css from './ui.css';
import { configChangeEmitter, configRead, configWrite } from '../config.js';
import updateStyle from './theme.js';
import { showToast } from './ytUI.js';
import modernUI from './settings.js';
import resolveCommand, { patchResolveCommand } from '../resolveCommand.js';
import { pipToFullscreen } from '../features/pictureInPicture.js';
import getCommandExecutor from './customCommandExecution.js';
import { t } from 'i18next';

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
  } catch (e) {
    console.error('TizenTube: startup failed', e);
  }

  try {
    patchResolveCommand();
  } catch (e) {
    console.error('TizenTube: could not patch resolveCommand', e);
  }
}, 250);

let keyTimeout = null;

/**
 * Returns true only when the value is something CSS will actually paint, so a
 * half-typed hex code from the on-screen keyboard can never blank the theme.
 */
function isValidColor(value) {
  if (!value) return false;
  const probe = document.createElement('div');
  probe.style.backgroundColor = '';
  probe.style.backgroundColor = value;
  return probe.style.backgroundColor !== '';
}

function setIdleOpacity(value) {
  const container = document.getElementById('container');
  if (container) container.style.setProperty('opacity', value, 'important');
  // The clock is a sibling of #container, so dimming would otherwise skip the
  // one element that is bright, static and in a fixed position for hours.
  const clock = document.getElementById('tizentube-clock');
  if (clock) clock.style.setProperty('opacity', value, 'important');
}

function isVideoPlaying() {
  const videoPlayer = document.querySelector('.html5-video-player');
  if (!videoPlayer || typeof videoPlayer.getPlayerStateObject !== 'function') return false;
  try {
    return !!videoPlayer.getPlayerStateObject().isPlaying;
  } catch (e) {
    return false;
  }
}

/** Wakes the screen back up and re-arms the idle dimming timer. */
function resetScreenDimming() {
  if (keyTimeout) {
    clearTimeout(keyTimeout);
    keyTimeout = null;
  }
  if (!configRead('enableScreenDimming')) return;

  setIdleOpacity('1');
  keyTimeout = setTimeout(() => {
    keyTimeout = null;
    if (isVideoPlaying()) return;
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

function execute_once_dom_loaded() {

  // Add CSS to head.

  const existingStyle = document.querySelector('style[nonce]');
  if (existingStyle) {
    existingStyle.textContent += css;
  } else {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  // Fix UI issues.
  const ui = configRead('enableFixedUI');
  if (ui) {
    try {
      window.tectonicConfig.featureSwitches.isLimitedMemory = false;
      window.tectonicConfig.clientData.legacyApplicationQuality = 'full-animation';
      window.tectonicConfig.featureSwitches.enableAnimations = true;
      window.tectonicConfig.featureSwitches.enableOnScrollLinearAnimation = true;
      window.tectonicConfig.featureSwitches.enableListAnimations = true;
      window.tectonicConfig.featureSwitches.supportsLongPress = true;
    } catch (e) { }
  }

  // We handle key events ourselves.
  window.__spatialNavigation__.keyMode = 'NONE';

  var ARROW_KEY_CODE = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' };

  var uiContainer = document.createElement('div');
  uiContainer.classList.add('ytaf-ui-container');
  uiContainer.style['display'] = 'none';
  uiContainer.setAttribute('tabindex', 0);
  // What had focus before the panel opened, so it can be handed back on close.
  let previouslyFocused = null;

  function firstControl() {
    return uiContainer.querySelector('input');
  }

  function showPanel() {
    const active = document.activeElement;
    previouslyFocused = active && active !== document.body ? active : null;

    // Re-read the stored colours: they can have been changed from the
    // TizenTube settings menu since the panel was last opened.
    const barColor = uiContainer.querySelector('#__barColor');
    const routeColor = uiContainer.querySelector('#__routeColor');
    if (barColor) {
      barColor.value = configRead('focusContainerColor');
      uiContainer.querySelector('#__barColorSwatch').style.backgroundColor = configRead('focusContainerColor');
    }
    if (routeColor) {
      routeColor.value = configRead('routeColor');
      uiContainer.querySelector('#__routeColorSwatch').style.backgroundColor = configRead('routeColor');
    }

    uiContainer.style.display = 'block';
    uiContainer.focus();
    // Land on a real control: the focus style is a descendant selector, so a
    // focused container would leave the panel looking like nothing is selected.
    const control = firstControl();
    if (control) control.focus();
  }

  function hidePanel() {
    uiContainer.style.display = 'none';
    uiContainer.blur();
    // Give focus back to the app; leaving nothing focused makes the remote
    // look dead until the user guesses their way back into the page.
    if (previouslyFocused && document.body.contains(previouslyFocused)) {
      try {
        previouslyFocused.focus();
      } catch (e) { }
    }
    previouslyFocused = null;

    // YouTube re-renders its shelves constantly, so the element captured when
    // the panel opened may no longer exist. Hand focus to whatever the app is
    // currently showing rather than leaving it on <body>.
    const active = document.activeElement;
    if (!active || active === document.body) {
      const fallback = document.querySelector('[hybridnavfocusable="true"], .zylon-focus');
      if (fallback) {
        try {
          fallback.focus();
        } catch (e) { }
      }
    }
  }

  uiContainer.addEventListener(
    'keydown',
    (evt) => {
      if (evt.keyCode !== 404 && evt.keyCode !== 172) {
        // Nothing is guaranteed to be focused, so every branch below works off
        // this one nullable lookup instead of dereferencing it blind.
        const focusedElement = document.activeElement;
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
            const target = focusedElement && focusedElement !== uiContainer && uiContainer.contains(focusedElement)
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


        if (evt.key === 'Enter' || evt.Uc?.key === 'Enter') {
          // If the focused element is a text input, emit a change event.
          if (isTextInput) {
            focusedElement.dispatchEvent(new Event('change'));
          }
        }
      }
    },
    true
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
    document.querySelector('body').appendChild(uiContainer);

    const bindColorInput = (inputId, swatchId, configKey) => {
      const input = uiContainer.querySelector(inputId);
      const swatch = uiContainer.querySelector(swatchId);

      input.value = configRead(configKey);
      swatch.style.backgroundColor = configRead(configKey);

      input.addEventListener('change', (evt) => {
        const value = evt.target.value.trim();
        if (!isValidColor(value)) {
          // Put the stored colour back rather than writing something the TV
          // would render as transparent.
          evt.target.value = configRead(configKey);
          return;
        }
        configWrite(configKey, value);
        swatch.style.backgroundColor = value;
        updateStyle();
      });
    };

    bindColorInput('#__barColor', '#__barColorSwatch', 'focusContainerColor');
    bindColorInput('#__routeColor', '#__routeColorSwatch', 'routeColor');
  } catch (e) { }

  var eventHandler = (evt) => {
    // Deliberately not logging every event here: this handler is registered for
    // keydown, keypress and keyup, and speedUI.js registers three more, so a
    // single press used to produce six logs before any keyCode was even tested.
    // The branches below log when they actually act.

    // A single press arrives as keydown, keypress and keyup; re-arming the idle
    // timer once per press is enough.
    if (evt.type === 'keydown') {
      resetScreenDimming();
    }
    if (evt.keyCode == 403) {
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
        } catch (e) { }
      }
      return false;
    } else if (evt.keyCode == 404 || evt.keyCode == 172) {
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
    } else if (evt.keyCode == 39) {
      // Right key, for PiP
      if (evt.type === 'keydown' && uiContainer.style.display === 'none') {
        // Checked first: this runs on every right press, and the flag is far
        // cheaper than a DOM query.
        if (window.isPipPlaying && document.querySelector('ytlr-search-text-box > .zylon-focus')) {
          const ytlrPlayer = document.querySelector('ytlr-player');
          if (ytlrPlayer) ytlrPlayer.style.setProperty('background-color', 'rgb(0, 0, 0)');
          pipToFullscreen();
          // Only consumed once the branch has decided to act, so an ordinary
          // right press still moves YouTube's own selection.
          evt.preventDefault();
          evt.stopPropagation();
          return false;
        }
      }
    };
    return true;
  }

  // Colour keys. Red opens the theme panel, Green the settings menu; Blue is
  // handled in speedUI.js. Yellow is deliberately unbound.
  // Red 403 | Green 404 or 172 | Yellow 405 or 170 | Blue 406 or 191
  document.addEventListener('keydown', eventHandler, true);
  document.addEventListener('keypress', eventHandler, true);
  document.addEventListener('keyup', eventHandler, true);
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
          signal: 'SOFT_RELOAD_PAGE'
        }
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
    } catch (e) { }
  }
}
