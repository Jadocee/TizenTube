// Which transport-control slot gets the previous button and which gets the next.
//
// NO IMPORTS, deliberately -- test/refresh.mjs lifts this verbatim so a Node
// harness runs the shipping decision.
//
// The app's own component resolves its two skip buttons like this (chunks/007.js,
// de-minified only by spacing):
//
//     this.F = ... _.B(_.E("isRtl", !1) ? d.skipNextButton : d.skipPreviousButton, _.hA)
//     this.B = ... _.B(_.E("isRtl", !1) ? d.skipPreviousButton : d.skipNextButton, _.hA)
//
// So the SLOTS are fixed and the MEANING is swapped: under a right-to-left
// layout the app deliberately puts the NEXT button in the first slot, because
// the row itself reads right to left and that is where "next" visually belongs.
//
// customUI discovers those two methods by matching their SOURCE TEXT, which
// contains the whole ternary and is therefore identical whichever way isRtl
// resolves at runtime. It then always assigned previous to the first slot -- so
// on an Arabic account the mod's replacements sat the wrong way round, previous
// where next belonged and next where previous belonged.
//
// The same trap previewIndicator.css and clock.css both record, one layer up:
// this app is bidirectional and the mod is not automatically.

export interface SlotNames {
    /** The method whose source reads `isRtl ? skipNextButton : skipPreviousButton`. */
    first?: string;
    /** ...and `isRtl ? skipPreviousButton : skipNextButton`. */
    second?: string;
}

export interface SlotAssignment {
    previous?: string;
    next?: string;
}

/**
 * Maps the two discovered method names onto previous and next.
 *
 * Returns an empty assignment when either name is missing, so the caller's
 * existing "only patch what we found" behaviour is preserved rather than half
 * the row being replaced.
 */
export function transportSlots(names: SlotNames | null | undefined, rtl: boolean): SlotAssignment {
    if (!names || !names.first || !names.second) return {};
    return rtl
        ? { previous: names.second, next: names.first }
        : { previous: names.first, next: names.second };
}

/**
 * Whether the document is laid out right to left.
 *
 * Read off the document rather than off the app's own `isRtl` feature switch:
 * the switch is reachable only through the minified namespace, and the thing
 * that actually decides the row's visual order is the computed direction. A
 * failure to read it falls back to left-to-right, which is the layout the
 * overwhelming majority of sets use.
 */
export function documentIsRtl(doc: any): boolean {
    try {
        const root = doc && doc.documentElement;
        if (!root) return false;
        if (typeof root.dir === 'string' && root.dir.toLowerCase() === 'rtl') return true;
        const view = doc.defaultView;
        if (view && typeof view.getComputedStyle === 'function') {
            return view.getComputedStyle(root).direction === 'rtl';
        }
        return false;
    } catch (_e) {
        // A detached or cross-document node. Left-to-right is the safe answer:
        // guessing rtl would swap the buttons for everyone.
        return false;
    }
}
