// The config the refresh harness drives, plus the two browser globals aisList.ts
// touches. Deliberately real enough to be wrong in the same ways a television
// is: localStorage here is a plain object that CAN be made to throw, because
// "the write failed" is one of the states the cache logic has to survive.
export const store = { enableAiSList: true, aisListIncludeWarnlist: false };
export const configRead = (k) => store[k];
