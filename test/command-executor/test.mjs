// getCommandExecutor() resolves YouTube's action router out of the minified
// module registry. It is the function whose failure produced the original
// black-screen-on-launch: ui.ts calls it during startup, and anything it gets
// wrong surfaces as an app that never finishes painting.
import getCommandExecutor from './mod.generated.mts';

let fail = 0;
const check = (d, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) fail++;
    console.log(
        `${ok ? '  ok  ' : 'FAIL  '}${d.padEnd(58)} ${JSON.stringify(got)}${ok ? '' : '  want ' + JSON.stringify(want)}`,
    );
};

// A module whose prototype carries the router method -- the normal shape.
function routerModule(tag) {
    class Router {
        constructor(t) {
            this.tag = t;
        }
        // Reads `this` on purpose: a method bound to the wrong instance has to be
        // detectable, and a closure over `tag` would hide exactly that.
        route() {
            return 'ytlrActionRouter:' + this.tag;
        }
        unrelated() {
            return 1;
        }
    }
    const singleton = new Router(tag);
    const mod = () => {};
    mod.getInstance = () => singleton;
    mod.toString = () => 'function(){/* nothing interesting */}';
    return { mod, singleton };
}

// A module that only mentions the router in its own source, with no such method.
function sourceOnlyModule() {
    class Other {
        constructor() {
            this.tag = 'DECOY';
        }
        helper() {
            return 2;
        }
    }
    const singleton = new Other();
    const mod = () => {};
    mod.getInstance = () => singleton;
    mod.toString = () => 'function(){ ytlrActionRouter }';
    return { mod, singleton };
}

const commandFunction = function () {
    this.actionName = 'x';
};

const withRegistry = (entries) => {
    globalThis.window = { _yttv: entries };
    return getCommandExecutor();
};

console.log('The normal case:');
{
    const { mod, singleton } = routerModule('a');
    const r = withRegistry({ a: mod, cmd: commandFunction });
    check('returns an executor', !!r, true);
    check(
        'executeFunction is bound to its own instance',
        r.executeFunction(),
        'ytlrActionRouter:a',
    );
    // Identity, not JSON: stringifying a function gives undefined on both sides,
    // which would make this assertion unfailable.
    check('finds the command constructor', r.commandFunction === commandFunction, true);
    check(
        'executeFunction is a bound method, not the raw one',
        r.executeFunction === singleton.route,
        false,
    );
}

console.log('\nA module that misbehaves must not abort the search:');
{
    const { mod } = routerModule('b');
    const thrower = () => {};
    thrower.getInstance = () => {
        throw new Error('not ready');
    };
    const empty = () => {};
    empty.getInstance = () => undefined;
    const r = withRegistry({ bad: thrower, none: empty, good: mod, cmd: commandFunction });
    check(
        'still resolves past a throwing getInstance',
        r && r.executeFunction(),
        'ytlrActionRouter:b',
    );
}

console.log('\nThe instance and the method must come from the SAME module:');
{
    const real = routerModule('real');
    const decoy = sourceOnlyModule();
    // Enumeration order puts the real router first and the decoy second, which is
    // the order that used to leave executeFunction bound to the wrong instance.
    const r = withRegistry({ real: real.mod, decoy: decoy.mod, cmd: commandFunction });
    check(
        'method still belongs to the instance it was found on',
        r && r.executeFunction(),
        'ytlrActionRouter:real',
    );
}

console.log('\nThe prototype scan must not pick constructor, or invoke accessors:');
{
    let getterCalls = 0;
    class Sneaky {
        // The class source mentions the router, but no method implements it.
        static tag = 'ytlrActionRouter';
        get trap() {
            getterCalls++;
            return () => 'invoked';
        }
        plain() {
            return 'nope';
        }
    }
    const singleton = new Sneaky();
    const mod = () => {};
    mod.getInstance = () => singleton;
    mod.toString = () => 'class Sneaky { ytlrActionRouter }';
    const good = routerModule('good');
    const r = withRegistry({ sneaky: mod, good: good.mod, cmd: commandFunction });
    check(
        'did not bind constructor as the router',
        r && r.executeFunction(),
        'ytlrActionRouter:good',
    );
    check('did not invoke the accessor while scanning', getterCalls, 0);
}

console.log('\nAn incomplete registry must yield undefined, not a half-built object:');
{
    const { mod } = routerModule('c');
    check('no command constructor -> undefined', withRegistry({ a: mod }), undefined);
    check('no router at all -> undefined', withRegistry({ cmd: commandFunction }), undefined);
    check('empty registry -> undefined', withRegistry({}), undefined);
}
console.log('  (ui.ts constructs commandFunction with `new`, so a half-built');
console.log('   object here threw inside the startup poll and blanked the app.)');

console.log(`\n${fail ? fail + ' FAILURES' : 'ALL PASS'}`);
process.exit(fail ? 1 : 0);
