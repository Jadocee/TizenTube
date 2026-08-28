export const store = { permanentlyEnableWhoIsWatchingMenu: false };
export const configRead = (k) => store[k];
export const configChangeEmitter = { addEventListener(){}, dispatchEvent(){} };
