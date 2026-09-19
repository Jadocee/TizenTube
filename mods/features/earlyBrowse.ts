// The home feed tv.html has already fetched by the time the mod exists.
//
// THE BUG THIS EXISTS FOR. Ads came back after switching accounts and stayed
// back for the whole session, with no setting having moved. Switching accounts
// does not navigate inside the app -- it reloads the DOCUMENT, and the URL it
// reloads to carries `is_account_switch=1`. tv.html's inline pre-bootstrap
// reads exactly that:
//
//     Ib = ["is_account_switch=1"];
//     L  = Ib.some(function(r){return c.indexOf(r)>-1});
//     var v = f ? "STARTUP_SCREEN_UNKNOWN" : sb(a,c,l,L);
//
// and sb's second line is
//
//     function sb(a,b,c,e){var g=rb(b);if(g!==void 0)return g;
//       if(e)return w(a,"essn_non"),"STARTUP_SCREEN_NONE"; ...
//
// so an account switch reports "no startup screen" before it consults the
// who's-watching state, the recurring-actions store, or anything else. The gate
// underneath skips the very-early browse only when a screen IS up:
//
//     if(f||e||v!=="STARTUP_SCREEN_NONE"){H(a);return}   // H sets vebSkipped
//
// Which makes the launch that follows an account switch precisely the launch on
// which the pre-bundle home fetch always runs. And it runs on its own stack:
//
//     function Ba(a,b){return new Promise(function(c,e){var g=new XMLHttpRequest;
//       g.addEventListener("load",function(){try{g.status!==200&&e(za(g,a)),
//         c(JSON.parse(g.response))}catch(h){e(h)}}); ... })}
//
// a raw XMLHttpRequest and a bare JSON.parse, from a script inlined in the HTML
// before base.js has even been requested. The result is published as
// `window.pendingEarlyBrowse` and consumed much later as data that is already
// parsed and is never parsed again:
//
//     xZa = function(a,b,c){var d=window.pendingEarlyBrowse;
//       if(d&&!_.HC.has(c)&&(delete window.pendingEarlyBrowse,
//         d.then(function(e){_.ek(_.Qo(),e.response)}).catch(function(){}), ...
//
// NOT "the mod was not injected". TizenBrew re-injects on every document
// (`client.on('Runtime.executionContextCreated', ...)`). What it cannot do is
// inject synchronously: the service fetches the module over the network on the
// first launch of a session and from an in-memory cache afterwards, while the
// page's own inline script is not waiting for anybody. When the browse response
// beats the hook, that feed keeps its ads -- and because nothing re-parses it,
// nothing downstream ever gets a second chance at it.
//
// WHY THIS PLACE HAS NO RACE LEFT IN IT. A script cannot be injected into the
// middle of another script, so there are only two orders, and both are covered:
//
//   * the mod evaluated first -- JSON.parse is hooked before the browse
//     response lands, and the feed is cleaned on the way in; or
//   * the inline script evaluated first -- then it has already assigned
//     `window.pendingEarlyBrowse` (`a.pendingEarlyBrowse=l` sits at the top
//     level of that script, so it is done before the script yields), and this
//     adopts it.
//
// The deadline for adopting is late, too: the app reads the PROPERTY lazily,
// when it resolves the first navigation, which is after base.js and main.js
// have both loaded and run.

/** What tv.html's pre-bootstrap resolves `window.pendingEarlyBrowse` to. */
export interface EarlyBrowseResult {
    response?: unknown;
}

/** Just enough of `window` to drive this from a harness. */
export interface EarlyBrowseHost {
    pendingEarlyBrowse?: unknown;
}

/**
 * Promises this has already wrapped.
 *
 * base.js has a second early-browse path of its own (`KBa`, which assigns
 * `window.pendingEarlyBrowse` from `_.G.get(_.ft).fetch(...)`), so the property
 * can be reassigned after this runs. Adopting the same promise twice would run
 * the response pass twice, and several steps in it are not idempotent.
 */
const adopted = new WeakSet<object>();

/**
 * Routes an already-fetched early browse through `scrub` before the app sees it.
 *
 * Returns whether there was anything to adopt, which is also the only way a
 * caller can tell which of the two orders above happened.
 */
export function adoptEarlyBrowse(
    host: EarlyBrowseHost,
    scrub: (response: unknown) => unknown,
): boolean {
    const pending = host.pendingEarlyBrowse as PromiseLike<EarlyBrowseResult> | null | undefined;
    // Thenable rather than `instanceof Promise`: the value comes from the page,
    // and the page is free to hand back whatever its own polyfills produce.
    if (!pending || typeof (pending as { then?: unknown }).then !== 'function') return false;
    if (adopted.has(pending as unknown as object)) return false;

    const wrapped = pending.then((value: EarlyBrowseResult) => {
        try {
            if (value && typeof value === 'object' && value.response !== undefined) {
                const cleaned = scrub(value.response);
                // Assigned only when the scrub produced something. The app has no
                // fallback for a resolved early browse whose response is missing
                // -- `_.ek(_.Qo(), e.response)` is called unconditionally -- so a
                // scrub that returned nothing would blank the home screen rather
                // than merely failing to clean it.
                if (cleaned !== undefined) value.response = cleaned;
            }
        } catch (e) {
            // A failed scrub means ads get through, which is a bad day. Letting
            // the failure reject means the home feed never arrives at all, which
            // is a worse one.
            console.error('An error occured while processing the early browse:', e);
        }
        return value;
    });

    adopted.add(wrapped as unknown as object);
    host.pendingEarlyBrowse = wrapped;

    // The page attaches its own handlers to the promise it published, not to
    // this one, and on some paths it deletes the property before ever reading it
    // (the pre-bootstrap's own `l.catch(...)` does exactly that). A veb that
    // fails would then leave this derivation rejected with nothing attached, so
    // the failure would surface as an unhandled rejection from the mod rather
    // than as the network error it is. Consumers still see the rejection: they
    // chain off `wrapped`, and this handler does not replace theirs.
    wrapped.then(undefined, () => {});

    return true;
}
