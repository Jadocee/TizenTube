// Whether the feed tv.html fetched before the mod existed still gets cleaned.
//
// THE BUG THIS EXISTS FOR. Switching accounts reloads the document with
// `is_account_switch=1`, tv.html's inline pre-bootstrap reads that as "no
// startup screen" and therefore always runs its very-early browse, and that
// browse uses its own XMLHttpRequest and its own JSON.parse -- from inside the
// HTML, before base.js is even requested. The result is published as
// `window.pendingEarlyBrowse`, consumed as already-parsed data, and never
// parsed again. A hook installed a moment too late never saw that feed at all,
// which is why ads came back after switching accounts and stayed back.
//
// So the assertions here are about the two orders the injection can land in and
// about not making the home screen worse when the scrub misbehaves: a mod that
// blanks the feed it was meant to clean is a worse outcome than the ads.
import { adoptEarlyBrowse } from './mod.generated.mts';
import { checker } from '../lib/repo.mjs';

const { check, done } = checker();

// Node reports an unhandled rejection by killing the process on exit, which
// would look like a harness crash rather than the defect it is. Collected so it
// can be asserted on instead.
const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

/** A deferred, so the test drives resolution rather than waiting on a clock. */
function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/** Lets every already-settled microtask run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

// --- nothing to adopt ------------------------------------------------------
// The good order: the mod evaluated before the inline script, so JSON.parse is
// already hooked and there is no pre-parsed feed in existence. Returning true
// here would be a lie the caller cannot check.
check(
    'an empty window is not adopted',
    adoptEarlyBrowse({}, (r) => r),
    false,
);
check(
    '  ...nor an undefined property',
    adoptEarlyBrowse({ pendingEarlyBrowse: undefined }, (r) => r),
    false,
);
// The property is page-controlled. A non-thenable in it must not throw out of
// module evaluation -- that would take down every feature bundled after adblock.
check(
    '  ...nor a non-thenable',
    adoptEarlyBrowse({ pendingEarlyBrowse: { response: {} } }, (r) => r),
    false,
);
check(
    '  ...nor a primitive',
    adoptEarlyBrowse({ pendingEarlyBrowse: 42 }, (r) => r),
    false,
);

// --- the losing order, which is the whole point ----------------------------
{
    const d = deferred();
    const host = { pendingEarlyBrowse: d.promise };
    const seen = [];
    check(
        'a pending early browse is adopted',
        adoptEarlyBrowse(host, (r) => {
            seen.push(r);
            return { cleaned: true };
        }),
        true,
    );
    // Replaced, not merely observed. Attaching a handler to the page's own
    // promise would not order the mod's pass before the app's read; only
    // handing the app a promise that resolves AFTER the pass does.
    check('  ...and the property is replaced', host.pendingEarlyBrowse === d.promise, false);

    const feed = { contents: 'ads and videos' };
    d.resolve({ response: feed, identity: 'user-1' });
    const value = await host.pendingEarlyBrowse;

    check('  ...the scrub sees the response', seen.length === 1 && seen[0] === feed, true);
    check(
        '  ...the consumer sees the cleaned one',
        JSON.stringify(value.response),
        '{"cleaned":true}',
    );
    // xZa reads e.response off the same object the promise resolved to; the app
    // reads identity from it too, on the token-refresh path.
    check('  ...and the rest of the result survives', value.identity, 'user-1');
}

// --- adopting twice --------------------------------------------------------
// base.js has an early-browse path of its own (KBa) that reassigns the same
// property, so a second call is a real possibility rather than a hypothetical.
// Several steps of the response pass are not idempotent.
{
    const d = deferred();
    const host = { pendingEarlyBrowse: d.promise };
    let runs = 0;
    adoptEarlyBrowse(host, (r) => {
        runs++;
        return r;
    });
    const afterFirst = host.pendingEarlyBrowse;
    check(
        'adopting the adopted promise is declined',
        adoptEarlyBrowse(host, (r) => r),
        false,
    );
    check('  ...leaving the property alone', host.pendingEarlyBrowse === afterFirst, true);
    d.resolve({ response: { a: 1 } });
    await host.pendingEarlyBrowse;
    check('  ...and the scrub runs once', runs, 1);
}

// --- a scrub that throws ---------------------------------------------------
// Ads getting through is a bad day. The home screen never arriving is a worse
// one, so the failure must not propagate into the promise the app awaits.
{
    const d = deferred();
    const host = { pendingEarlyBrowse: d.promise };
    adoptEarlyBrowse(host, () => {
        throw new Error('scrub exploded');
    });
    const feed = { contents: 'intact' };
    d.resolve({ response: feed });
    let rejected = false;
    const value = await host.pendingEarlyBrowse.catch(() => {
        rejected = true;
    });
    check('a throwing scrub does not reject the feed', rejected, false);
    check('  ...and the response is left as it was', value.response === feed, true);
}

// --- a scrub that returns nothing ------------------------------------------
// The app calls `_.ek(_.Qo(), e.response)` with no guard, so assigning undefined
// here would hand it an empty home screen.
{
    const d = deferred();
    const host = { pendingEarlyBrowse: d.promise };
    adoptEarlyBrowse(host, () => undefined);
    const feed = { contents: 'intact' };
    d.resolve({ response: feed });
    const value = await host.pendingEarlyBrowse;
    check('a scrub returning nothing does not blank the feed', value.response === feed, true);
}

// --- a result with no response ---------------------------------------------
{
    const d = deferred();
    const host = { pendingEarlyBrowse: d.promise };
    let runs = 0;
    adoptEarlyBrowse(host, (r) => {
        runs++;
        return r;
    });
    d.resolve({ identity: 'user-2' });
    const value = await host.pendingEarlyBrowse;
    check('a result with no response is passed through', value.identity, 'user-2');
    check('  ...without calling the scrub', runs, 0);
}

// --- a failed browse -------------------------------------------------------
// The pre-bootstrap's own handler is `l.catch(function(r){...delete
// a.pendingEarlyBrowse})`, attached to the promise it published -- not to this
// one. So a network failure leaves this derivation with no consumer at all.
{
    const d = deferred();
    const host = { pendingEarlyBrowse: d.promise };
    adoptEarlyBrowse(host, (r) => r);
    const adoptedPromise = host.pendingEarlyBrowse;
    const err = new Error('Network error');
    d.reject(err);
    // What the page does on that path: drops the property without reading it.
    delete host.pendingEarlyBrowse;
    await settle();
    check('a failed browse is not reported as a mod error', unhandled.length, 0);
    // The rejection still has to reach a consumer that does hold on to it,
    // because the app's own veb_aa logging is what makes the failure visible.
    let caught = null;
    await adoptedPromise.catch((e) => {
        caught = e;
    });
    check('  ...but a consumer still sees it', caught === err, true);
}

await settle();
check('no unhandled rejections in the whole run', unhandled.length, 0);

done();
