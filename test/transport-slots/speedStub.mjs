// speedUI's three dependencies. All thin: what is under test is the key handler.
export const store = { videoSpeed: 1, speedSettingsIncrement: 0.25 };
export const configRead = (k) => store[k];
export const t = (k) => k;
export const showModal = () => {};
export const buttonItem = (a) => a;
export const overlayPanelItemListRenderer = (a) => a;
