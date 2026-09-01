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

import { configRead, configChangeEmitter } from '../config.js';
import { refresh } from './aisList.js';

const START_DELAY_MS = 15000;

/** refresh() swallows and warns on its own; this only stops an unhandled
 *  rejection reaching the page. */
const kick = (force: boolean) => {
    refresh(force).catch(() => {});
};

if (configRead('enableAiSList')) {
    setTimeout(() => kick(false), START_DELAY_MS);
}

// The gate above runs ONCE, at import. The setting ships off, so on a fresh
// install it is false, no timer is scheduled, and nothing else in the tree ever
// calls refresh() -- which meant ticking the box left the feature reading ON and
// hiding nothing until the TV app was killed and relaunched. The toggle that
// turns the feature on is also what fetches the list it needs.
configChangeEmitter.addEventListener('configChange', (event) => {
    const { key, value } = event.detail;
    if (key === 'enableAiSList' && value) {
        // Forced: the user just asked for this, so the 12-hour TTL is not the
        // right answer to "should I fetch now".
        kick(true);
        return;
    }
    // Turning the warnlist on mid-session needs a fetch of its own -- the
    // blocklist's freshness says nothing about a list that was never downloaded.
    if (key === 'aisListIncludeWarnlist' && value && configRead('enableAiSList')) {
        kick(false);
    }
});
