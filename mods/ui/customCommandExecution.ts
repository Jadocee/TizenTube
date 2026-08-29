/** The pieces of YouTube's action router the mod drives commands through. */
interface CommandExecutor {
    executeFunction: (...args: any[]) => any;
    commandFunction: new (...args: any[]) => any;
}

function getCommandExecutor(): CommandExecutor | undefined {
    let instance;
    let executeFunction;

    /**
     * The router method on an instance's prototype, or undefined.
     *
     * `constructor` is skipped: getOwnPropertyNames on a prototype always
     * returns it, and its source is the whole class -- a superset of every
     * method body -- so it matched whenever the class mentioned the router
     * anywhere at all. Members are read through their descriptors so a getter
     * is not invoked just by looking for it.
     */
    const routerMethodOf = (obj: any): ((...args: any[]) => any) | undefined => {
        const proto = Object.getPrototypeOf(obj);
        if (!proto) return undefined;
        for (const name of Object.getOwnPropertyNames(proto)) {
            if (name === 'constructor') continue;
            const descriptor = Object.getOwnPropertyDescriptor(proto, name);
            if (typeof descriptor?.value !== 'function') continue;
            if (descriptor.value.toString().includes('ytlrActionRouter')) return descriptor.value;
        }
        return undefined;
    };

    for (const key in window._yttv) {
        if (!window._yttv[key] || !window._yttv[key].getInstance) continue;

        // One module that returns nothing, or throws, must not abort the search
        // for the rest -- getPrototypeOf(undefined) throws and nothing above
        // this catches.
        let candidate;
        try {
            candidate = window._yttv[key].getInstance();
        } catch (e) {
            continue;
        }
        if (!candidate) continue;

        // The instance and its router method are taken as a pair. They used to
        // be assigned in separate branches with no break, so a module matching
        // on its own source that was enumerated after a module matching on its
        // prototype replaced the instance and left executeFunction pointing at
        // the earlier, unrelated one.
        const method = routerMethodOf(candidate);
        if (method) {
            instance = candidate;
            executeFunction = method;
            break;
        }
        if (!instance && window._yttv[key].toString().includes('ytlrActionRouter')) {
            instance = candidate;
        }
    }

    if (!instance) return;

    if (!executeFunction) executeFunction = routerMethodOf(instance);

    if (!executeFunction) return;

    let commandFunction;
    for (const key in window._yttv) {
        if (window._yttv[key] && typeof window._yttv[key] === 'function' && window._yttv[key].toString().includes('this.actionName')) {
            commandFunction = window._yttv[key];
        }
    }
    // Guarded like the two above it. Both callers do
    // `new commandExecutor.commandFunction(...)` behind a plain truthiness check
    // on the returned object, so handing back a half-built one throws in the
    // caller. During app boot -- notably while the startup account picker is up
    // -- the router exists before this class is registered.
    if (!commandFunction) return;

    return {
        executeFunction: executeFunction.bind(instance),
        commandFunction
    }
}

export default getCommandExecutor;