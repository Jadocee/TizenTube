// The switches that decide whether the home page glides or jumps.
//
// The shape under test is not "do the six values get written" but "does one
// failing write cost the other five". They lived in a single bare try/catch in
// ui.ts whose first statement dereferenced window.tectonicConfig, so an app that
// had not published that object yet lost all six -- silently, on a device with
// no console. The two most-felt ones, enableAnimations and enableListAnimations,
// are fourth and sixth in that list.
//
// The assertion that matters is `a throwing property costs only its own switch`.
// It fails against the previous code and passes against this one, which is the
// only reason to have written it.
import { checker } from '../lib/repo.mjs';
import { applyFocusMotion, SWITCH_COUNT } from './mod.generated.mts';

const { check, done } = checker();

const fresh = () => ({ featureSwitches: {}, clientData: {} });

// --- the ordinary case ------------------------------------------------------
let config = fresh();
check('every switch lands', applyFocusMotion(config, true), SWITCH_COUNT);
check('  ...memory limiting off', config.featureSwitches.isLimitedMemory, false);
check('  ...full animation quality', config.clientData.legacyApplicationQuality, 'full-animation');
check('  ...animations on', config.featureSwitches.enableAnimations, true);
check('  ...scroll animation on', config.featureSwitches.enableOnScrollLinearAnimation, true);
check('  ...list animations on', config.featureSwitches.enableListAnimations, true);
check('  ...long press supported', config.featureSwitches.supportsLongPress, true);

// --- strictly subtractive ---------------------------------------------------
// With the setting off this must write nothing at all, exactly as before.
config = fresh();
check('disabled writes nothing', applyFocusMotion(config, false), 0);
check('  ...leaving the object untouched', config, { featureSwitches: {}, clientData: {} });

// --- one bad property must not cost the rest --------------------------------
// This is the regression. The first switch in the list is the one made to
// throw, because that is exactly where the old code died.
const hostile = {
    featureSwitches: Object.defineProperty({}, 'isLimitedMemory', {
        set() { throw new Error('frozen'); },
        get() { return undefined; },
        configurable: true,
    }),
    clientData: {},
};
check('a throwing property costs only its own switch', applyFocusMotion(hostile, true), SWITCH_COUNT - 1);
check('  ...and the ones after it still land', hostile.featureSwitches.enableAnimations, true);
check('  ...including the last', hostile.featureSwitches.supportsLongPress, true);
check('  ...and the other group', hostile.clientData.legacyApplicationQuality, 'full-animation');

// --- an app that has not filled the object in yet ---------------------------
check('no groups at all writes nothing and does not throw', applyFocusMotion({}, true), 0);
check('only featureSwitches lands the featureSwitches ones',
      applyFocusMotion({ featureSwitches: {} }, true), SWITCH_COUNT - 1);
check('only clientData lands the clientData one',
      applyFocusMotion({ clientData: {} }, true), 1);
check('a null group is skipped rather than throwing',
      applyFocusMotion({ featureSwitches: null, clientData: {} }, true), 1);
check('a primitive group is skipped',
      applyFocusMotion({ featureSwitches: 'nope', clientData: {} }, true), 1);

// --- junk -------------------------------------------------------------------
let threw = null;
for (const junk of [null, undefined, 0, '', 'string', [], true, NaN]) {
    try {
        const applied = applyFocusMotion(junk, true);
        if (applied !== 0) threw = `${JSON.stringify(junk)} claimed ${applied} writes`;
    } catch (e) {
        threw = `${JSON.stringify(junk)} threw ${e.message}`;
    }
}
check('junk returns zero rather than throwing', threw, null);

// An array is an object, so it survives the type check -- but it has no
// featureSwitches, so nothing is written to it.
check('an array writes nothing', applyFocusMotion([], true), 0);

done();
