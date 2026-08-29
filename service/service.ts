import * as dial from '@patrickkfkan/peer-dial';
import type { DialApp } from '@patrickkfkan/peer-dial';
import express from 'express';
import cors from 'cors';
import * as uuid from 'uuid';

const app = express();

const corsOptions = {
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
    optionsSuccessStatus: 204
};

app.use(cors(corsOptions));

const PORT = global.isTizenTube ? 8095 : 8085;
const apps: Record<string, DialApp> = {
    "YouTube": {
        name: "YouTube",
        state: "stopped",
        allowStop: true,
        pid: null,
        additionalData: {},
        launch(launchData: string) {
            const tbPackageId = tizen.application.getAppInfo().packageId;
            tizen.application.launchAppControl(
                new tizen.ApplicationControl(
                    "http://tizen.org/appcontrol/operation/view",
                    null,
                    null,
                    null,
                    [
                        new tizen.ApplicationControlData("module", [JSON.stringify(
                            {
                                moduleName: '@foxreis/tizentube',
                                moduleType: 'npm',
                                args: launchData
                            }
                        )])
                    ]
                ), `${tbPackageId}.${global.isTizenTube ? 'TizenTubeStandalone' : 'TizenBrewStandalone'}`);
        }
    }
};

const dialServer = new dial.Server({
    expressApp: app,
    port: PORT,
    prefix: "/dial",
    manufacturer: 'Reis Can',
    modelName: 'TizenBrew',
    friendlyName: `TizenTube (${tizen.systeminfo.getCapability('http://tizen.org/system/model_name')})`,
    uuid: uuid.v5(tizen.systeminfo.getCapability('http://tizen.org/system/tizenid'), '4bcbc514-bdd6-4163-8215-316526fd1d9b'),
    delegate: {
        getApp(appName: string): DialApp | undefined {
            return apps[appName];
        },
        launchApp(appName: string, launchData: string, callback: (pid: string | null) => void) {
            console.log(`Got request to launch ${appName} with launch data: ${launchData}`);
            const app = apps[appName];
            if (app) {
                // peer-dial passes `req.text || null`, and req.text is only set
                // when the body middleware recognises the content type -- so an
                // empty or untyped DIAL body arrives here as null, and the
                // declared `string` type does not stop it.
                const raw = typeof launchData === 'string' ? launchData : '';
                // The platform parser. Splitting on '=' by hand truncated any
                // value containing one, never percent-decoded, and turned a
                // trailing or doubled '&' into an empty-string key.
                const parsedData: Record<string, string> = {};
                new URLSearchParams(raw).forEach((v, k) => {
                    if (k) parsedData[k] = v;
                });
                
                if (parsedData.yumi) {
                    app.additionalData = parsedData;
                    app.state = "running"
                    callback("");
                    return;
                }
                app.pid = "run";
                app.state = "starting";
                app.launch(raw);
                app.state = "running";
            }
            callback(app!.pid);
        },
        stopApp(appName: string, pid: string, callback: (stopped: boolean) => void) {
            console.log(`Got request to stop ${appName} with pid: ${pid}`);
            const app = apps[appName];
            if (app && app.pid === pid) {
                app.pid = null;
                app.state = "stopped";
                callback(true);
            } else {
                callback(false);
            }
        }
    }
});


setInterval(() => {
    tizen.application.getAppsContext((appsContext: any[]) => {
        const tbPackageId = tizen.application.getAppInfo().packageId;
        const app = appsContext.find((entry: any) => entry.appId === `${tbPackageId}.${global.isTizenTube ? 'TizenTubeStandalone' : 'TizenBrewStandalone'}`);
        if (!app) {
            apps["YouTube"].state = "stopped";
            apps["YouTube"].pid = null;
            apps["YouTube"].additionalData = {};
        }
    });
}, 5000);

app.listen(PORT, () => {
    dialServer.start();
});