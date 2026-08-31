// focusMotion.ts only reads enableFixedUI, and the harness drives
// applyFocusMotion() directly rather than through the retry, so the stub only
// has to exist.
export const configRead = () => false;
