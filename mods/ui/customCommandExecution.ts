/** The pieces of YouTube's action router the mod drives commands through. */
interface CommandExecutor {
    executeFunction: (...args: any[]) => any;
    commandFunction: new (...args: any[]) => any;
}

function getCommandExecutor(): CommandExecutor | undefined {
    let instance;
    let executeFunction;

    for (const key in window._yttv) {
        if (window._yttv[key] && window._yttv[key].getInstance) {
            if (window._yttv[key].toString().includes('ytlrActionRouter')) instance = window._yttv[key].getInstance();
            else {
                let isInstance = false;
                // This probes every registered module that exposes getInstance,
                // so one that returns nothing, or throws, must not abort the
                // search for the rest -- getPrototypeOf(undefined) throws, and
                // nothing above catches.
                let tempInstance;
                try {
                    tempInstance = window._yttv[key].getInstance();
                } catch (e) {
                    continue;
                }
                if (!tempInstance) continue;

                const keys = Object.getOwnPropertyNames(Object.getPrototypeOf(tempInstance));
                for (const key of keys) {
                    if (typeof tempInstance[key] === 'function' && tempInstance[key].toString().includes('ytlrActionRouter')) {
                        executeFunction = tempInstance[key];
                        isInstance = true;
                    }
                }

                // Reuses the instance already in hand rather than calling
                // getInstance() a second time for the same module.
                if (isInstance) instance = tempInstance;
            }
        }
    }

    if (!instance) return;

    if (!executeFunction) {
        const keys = Object.getOwnPropertyNames(Object.getPrototypeOf(instance));
        for (const key of keys) {
            if (typeof instance[key] === 'function' && instance[key].toString().includes('ytlrActionRouter')) {
                executeFunction = instance[key];
            }
        }
    }

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