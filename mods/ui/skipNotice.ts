import { whenBodyReady } from '../utils/domReady.js';
import { setStyleBlock } from './styleSheet.js';
import { NONE, remainingMs, shouldShow, type NoticeState } from '../features/skipNotice.js';
import css from './skipNotice.css';

// The DOM shell around features/skipNotice.ts. Everything that decides WHETHER
// and FOR HOW LONG lives there and is asserted in Node; this file only owns the
// element and the timer.

setStyleBlock('skip-notice', css);

const ELEMENT_ID = 'tizentube-skip-notice';
const SVG_NS = 'http://www.w3.org/2000/svg';

/* Material's FastForward, verbatim, on the same 24x24 grid the preview
   indicator's icons use. Inlined as path data rather than loaded: this runs on
   a television over whatever connection it has, and an icon that arrives late
   is worse than one that was never promised. */
const MATERIAL_FAST_FORWARD = 'M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z';

let element: HTMLDivElement | null = null;
let label: HTMLSpanElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let state: NoticeState = NONE;

function ensureElement(): HTMLDivElement | null {
    if (element) return element;
    // Built on the first real skip rather than at module scope: if the
    // stylesheet block were ever refused, an eagerly-built element would sit in
    // the document unstyled forever.
    const node = document.createElement('div');
    node.id = ELEMENT_ID;

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'currentColor');
    // Inert decoration beside text that already says what happened; a screen
    // reader announcing it would read the message twice.
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('class', 'tt-sn-icon');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', MATERIAL_FAST_FORWARD);
    svg.appendChild(path);
    node.appendChild(svg);

    const text = document.createElement('span');
    text.className = 'tt-sn-text';
    node.appendChild(text);

    element = node;
    label = text;
    whenBodyReady(() => {
        if (element && !element.isConnected) document.body.appendChild(element);
    });
    return element;
}

function clearHide(): void {
    if (hideTimer !== null) {
        clearTimeout(hideTimer);
        hideTimer = null;
    }
}

function hide(): void {
    clearHide();
    state = NONE;
    if (element) element.removeAttribute('data-shown');
}

/**
 * Shows one line over the player.
 *
 * Re-showing the same text inside the coalesce window is a no-op rather than a
 * re-arm: chained segments fire in quick succession and a notice that keeps
 * extending its own life outlives the thing it is describing.
 */
export function showSkipNotice(text: string): void {
    const now = Date.now();
    if (!shouldShow(state, text, now)) return;

    const node = ensureElement();
    if (!node || !label) return;

    if (label.textContent !== text) label.textContent = text;
    state = { text, shownAt: now };
    node.setAttribute('data-shown', '');

    // Restarted from THIS moment, not extended: remainingMs is computed from
    // the new shownAt, so a replacing notice gets a full duration rather than
    // the remainder of the one it replaced.
    clearHide();
    hideTimer = setTimeout(hide, remainingMs(state.shownAt, now));
}

/** Tears the notice down. Used when the player goes away, so a skip announced
 *  on the last second of a video does not follow the user back to the home
 *  page. */
export function hideSkipNotice(): void {
    hide();
}
