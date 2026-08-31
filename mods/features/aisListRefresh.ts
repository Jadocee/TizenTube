// Kicks the AiSList revalidation off, once, well after the app has started.
//
// Separated from aisList.ts so that module stays free of side effects at import
// time: adblock.ts imports it on the hot path for every tile, and a module that
// starts a network request merely by being imported would be doing it from
// inside JSON.parse.
//
// Deferred rather than immediate. A television's first seconds are spent
// painting the home screen, and a 358 KB download competing with that is the
// one way this feature could make the app feel slower. Whatever is already
// cached is used from the first shelf regardless; this only refreshes it.

import { configRead } from '../config.js';
import { refresh } from './aisList.js';

const START_DELAY_MS = 15000;

if (configRead('enableAiSList')) {
    setTimeout(() => {
        refresh().catch(() => {
            // refresh() already swallows and warns; this is belt and braces so
            // an unhandled rejection cannot reach the page.
        });
    }, START_DELAY_MS);
}
