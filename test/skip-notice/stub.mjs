// The two imports the notice's DOM shell makes that are not its own logic.
// whenBodyReady runs immediately here: the harness builds its fake body before
// importing the module, so there is nothing to wait for and deferring would
// mean the element never reached the document.
export const whenBodyReady = (fn) => fn();
export const setStyleBlock = () => {};
