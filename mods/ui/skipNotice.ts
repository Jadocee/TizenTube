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
/* Material's Block, for the message that says a segment was NOT skipped. A
   fast-forward glyph on that sentence asserts the opposite of the words beside
   it, and that message is the one a user is least likely to already understand,
   so it is the one that can least afford a contradictory mark. */
const MATERIAL_BLOCK =
    'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM4 12c0-4.42 3.58-8 8-8 1.85 0 3.55.63 4.9 1.69L5.69 16.9C4.63 15.55 4 13.85 4 12zm8 8c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1C19.37 8.45 20 10.15 20 12c0 4.42-3.58 8-8 8z';

let element: HTMLDivElement | null = null;
let label: HTMLSpanElement | null = null;
let iconPath: SVGPathElement | null = null;
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
    iconPath = path;

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

/**
 * Takes the pill down, and DELIBERATELY KEEPS the coalesce record.
 *
 * It used to reset `state` here, which quietly made the coalesce window the
 * same length as the notice: the record died with the pill, so the same text
 * arriving in the 400ms between NOTICE_DURATION_MS and COALESCE_WINDOW_MS found
 * no history and drew again -- the notice blinking straight back in, which is
 * the one thing the window exists to prevent. skipNotice.ts's own constants say
 * the window is deliberately wider than the notice; this is what makes that
 * true rather than decorative.
 *
 * The record is cleared only by forget(), below, because leaving the player is
 * the one event that genuinely makes the history irrelevant.
 */
function hide(): void {
    clearHide();
    if (element) element.removeAttribute('data-shown');
}

/**
 * Shows one line over the player.
 *
 * Re-showing the same text inside the coalesce window is a no-op rather than a
 * re-arm: chained segments fire in quick succession and a notice that keeps
 * extending its own life outlives the thing it is describing.
 */
export function showSkipNotice(text: string, skipped = true): void {
    const now = Date.now();
    if (!shouldShow(state, text, now)) return;

    const node = ensureElement();
    if (!node || !label) return;

    if (label.textContent !== text) label.textContent = text;
    // The glyph has to agree with the sentence: "Not skipping ..." under a
    // fast-forward arrow says two opposite things at once.
    const glyph = skipped ? MATERIAL_FAST_FORWARD : MATERIAL_BLOCK;
    if (iconPath && iconPath.getAttribute('d') !== glyph) iconPath.setAttribute('d', glyph);
    state = { text, shownAt: now };
    node.setAttribute('data-shown', '');

    // Restarted from THIS moment, not extended: remainingMs is computed from
    // the new shownAt, so a replacing notice gets a full duration rather than
    // the remainder of the one it replaced.
    clearHide();
    hideTimer = setTimeout(hide, remainingMs(state.shownAt, now));
}

/**
 * Tears the notice down and forgets what was on it.
 *
 * Used when the player goes away, so a skip announced on the last second of a
 * video does not follow the user back to the home page -- and so the NEXT
 * video's first skip is never swallowed as a repeat of the previous video's
 * last one, which is what keeping the record across a teardown would do.
 */
export function hideSkipNotice(): void {
    hide();
    state = NONE;
}
