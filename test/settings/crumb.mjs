import {
    recordStartupError,
    clearStartupError,
    readStartupError,
} from './startupError.generated.mts';
let fail = 0;
const check = (d, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) fail++;
    console.log(
        `${ok ? '  ok  ' : 'FAIL  '}${d}  ${JSON.stringify(got)}${ok ? '' : `  want ${JSON.stringify(want)}`}`,
    );
};

globalThis.localStorage = {};
check('clean start reads nothing', readStartupError(), null);

recordStartupError(new TypeError('commandExecutor.commandFunction is not a constructor'));
const e = readStartupError();
check(
    'records the message',
    e.message.startsWith('TypeError: commandExecutor.commandFunction'),
    true,
);
check('counts once', e.count, 1);
check('has a timestamp', typeof e.at === 'string' && e.at.length > 10, true);

recordStartupError(new TypeError('again'));
check('counts repeats', readStartupError().count, 2);

clearStartupError();
check('cleared on a clean start', readStartupError(), null);

// Must never become a second failure.
recordStartupError(undefined);
check('survives a non-Error', typeof readStartupError().message, 'string');
globalThis.localStorage = {
    get 'tizentube.startupError'() {
        throw new Error('storage blocked');
    },
    set 'tizentube.startupError'(_v) {
        throw new Error('storage blocked');
    },
};
let threw = false;
try {
    recordStartupError(new Error('x'));
    readStartupError();
    clearStartupError();
} catch (_err) {
    threw = true;
}
check('survives storage that throws', threw, false);
console.log(fail ? `\n${fail} FAILURES` : '\nBREADCRUMB OK');
process.exit(fail ? 1 : 0);
