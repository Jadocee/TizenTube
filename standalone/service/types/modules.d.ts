// Dependencies that ship no types.

/** The slice of the Chrome DevTools Protocol the injector uses. */
interface CDPClient {
    Runtime: {
        enable(): Promise<unknown>;
        evaluate(params: { expression: string; contextId?: number }): Promise<unknown>;
    };
    Page: {
        enable(): Promise<unknown>;
        navigate(params: { url: string }): Promise<unknown>;
        setBypassCSP(params: { enabled: boolean }): Promise<unknown>;
        addScriptToEvaluateOnNewDocument(params: { source: string }): Promise<unknown>;
        addScriptToEvaluateOnLoad(params: { scriptSource: string }): Promise<unknown>;
    };
    on(
        event: 'Runtime.executionContextCreated',
        handler: (message: { context: { id: number } }) => void,
    ): void;
}

declare module 'chrome-remote-interface' {
    function CDP(
        options: { host: string; port: number; local?: boolean },
        callback: (client: CDPClient) => void,
    ): { on(event: 'error', handler: (err: Error) => void): void };
    export = CDP;
}

declare module 'adbhost' {
    interface AdbStream {
        on(event: string, handler: (data: Buffer) => void): void;
        end(): void;
    }
    export interface AdbConnection {
        _stream: {
            on(event: 'connect', handler: () => void): void;
            on(event: 'error', handler: (err: Error) => void): void;
            end(): void;
        };
        createStream(command: string): AdbStream;
    }
    export function createConnection(options: { host: string; port: number }): AdbConnection;
}

declare module '*/userScript.generated.js' {
    const generated: { version: string; source: string };
    export = generated;
}

/** Tizen platform API, available inside the TV service runtime. */
declare const tizen: any;
