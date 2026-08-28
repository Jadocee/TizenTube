// Dependencies that ship no types, plus the platform globals.
// Deliberately not a module: an import or export here would make every
// declaration below module-scoped instead of global.

declare module '@patrickkfkan/peer-dial' {
    export interface DialApp {
        name: string;
        state: string;
        allowStop: boolean;
        pid: string | null;
        additionalData: Record<string, string>;
        launch(launchData: string): void;
    }
    export interface DialServerOptions {
        expressApp: unknown;
        port: number;
        prefix: string;
        manufacturer: string;
        modelName: string;
        friendlyName: string;
        uuid: string;
        delegate: {
            getApp(appName: string): DialApp | undefined;
            launchApp(appName: string, launchData: string, callback: (pid: string | null) => void): void;
            stopApp(appName: string, pid: string, callback: (stopped: boolean) => void): void;
        };
    }
    export class Server {
        constructor(options: DialServerOptions);
        start(): void;
    }
}

/** Tizen platform API, available inside the TV service runtime. */
declare const tizen: any;

/** Set by the standalone service before it requires this one. */
declare var isTizenTube: boolean | undefined;
