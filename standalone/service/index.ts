// NOT redundant, and Biome's noRedundantUseStrict says otherwise because it
// reasons about this file rather than the bundle. rolldown emits CJS here, and
// without this directive the emitted bundle is sloppy-mode -- which
// test/strict-bundle asserts against, because an implicit global in sloppy mode
// is a silent typo where in strict mode it is a ReferenceError. Removing it is
// how a dependency's implicit global once killed debugger injection on every
// launch.
'use strict';

// TizenTube Standalone service

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import nodeFetch from 'node-fetch';
import * as URL from 'url';
import * as injector from './injector.js';
import * as userScript from './userScript.js';

const app = express();
const PORT = 8099;

const USERSCRIPT_PATH = '/tizentube/userScript.js';

// Packaged into the build, so the page gets it from localhost instantly and the
// app works with no network at all. A newer published release is picked up in
// the background and takes effect from the next page load.
if (userScript.isPackaged()) {
    console.log('[TizenTube] Serving packaged userScript v' + userScript.currentVersion());
    userScript.refresh();
} else {
    userScript.get();
}

app.get(USERSCRIPT_PATH, (_req: Request, res: Response) => {
    userScript.get().then((body: string | null) => {
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        if (body) return res.send(body);

        // Never fail the request: an empty script tag is invisible, and a
        // session silently running without the mod is the thing being fixed.
        res.send(
            'console.error("[TizenTube] The userscript is unavailable. ' +
                'Reinstall the app or check the TV\'s network connection.");',
        );
    });
});

app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

app.get('/tizentube/getState', (_req: Request, res: Response) => {
    injector.canConnectToDaemon().then((r) => {
        res.json(r);
    });
});

app.get('/tizentube/debugger', (req: Request, res: Response) => {
    const args = req.originalUrl.split('?')[1] || '';
    // Answered immediately: the caller is index.html, which exits the app right
    // after and never reads a body. This route used to leave the request hanging.
    res.status(202).end();

    // getAppsContext is asynchronous and clearInterval only ran inside its
    // callback, so every tick queued in between also saw `!app` and started
    // another debugger attach -- several outstanding at a 50ms period against a
    // platform IPC, each registering the userscript on its own CDP client. The
    // flag is set BEFORE the async call so the extra callbacks are no-ops.
    let started = false;
    let ticks = 0;
    const interval = setInterval(() => {
        if (started) return;
        // ~30s, rather than polling for the life of the service if the app
        // never disappears from the context list.
        if (++ticks > 600) {
            clearInterval(interval);
            return;
        }
        tizen.application.getAppsContext((appsContext: any[]) => {
            if (started) return;
            const packageId = tizen.application.getAppInfo().packageId;
            const app = appsContext.find(
                (entry: any) => entry.appId === `${packageId}.TizenTubeStandalone`,
            );
            if (!app) {
                started = true;
                clearInterval(interval);
                injector.startDebugger(args);
            }
        });
    }, 50);
});

app.all('*', (req: Request, res: Response) => {
    const isCorsBypass = req.path.indexOf('/cors-bypass/') === 0;

    let targetUrl: string;
    if (isCorsBypass) {
        const rawTarget = req.url.substring('/cors-bypass/'.length);
        targetUrl = rawTarget.indexOf('http') === 0 ? rawTarget : `https://${rawTarget}`;
    } else {
        targetUrl = `https://www.youtube.com${req.url}`;
    }

    const headers: Record<string, string> = {};
    for (const key in req.headers) {
        if (Object.prototype.hasOwnProperty.call(req.headers, key)) {
            if (key === 'cookie') {
                headers[key] = String(req.headers[key])
                    .replace(/__LocalSecure-/g, '__Secure-')
                    .replace(/__LocalHost-/g, '__Host-');
                continue;
            }
            headers[key] = String(req.headers[key]);
        }
    }

    try {
        const parsedUrl = URL.parse(targetUrl);
        headers['host'] = parsedUrl.host || 'www.youtube.com';
    } catch (e) {
        // Both arms of the ternary that used to be here were the same literal,
        // so isCorsBypass was never consulted. Collapsed rather than guessed at:
        // on the cors-bypass path the real target is an arbitrary Google host and
        // this default is probably wrong, but deriving it needs a device to test.
        headers['host'] = 'www.youtube.com';
    }

    headers['origin'] = 'https://www.youtube.com';
    if (headers['referer']) {
        headers['referer'] = 'https://www.youtube.com/tv';
    }

    headers['accept-encoding'] = 'gzip, deflate';

    const hasBody = ['POST', 'PUT', 'PATCH'].indexOf(req.method) !== -1;
    const fetchOptions = {
        method: req.method,
        headers: headers,
        body: hasBody ? req : undefined,
        redirect: 'manual' as const,
    };

    nodeFetch(targetUrl, fetchOptions)
        .then((response) => {
            if (req.method === 'OPTIONS') {
                res.status(200);
            } else {
                res.status(response.status);
            }

            const headerKeys = response.headers.raw();
            for (const key in headerKeys) {
                if (Object.prototype.hasOwnProperty.call(headerKeys, key)) {
                    const lowerKey = key.toLowerCase();
                    const skipHeaders = [
                        'content-encoding',
                        'content-length',
                        'transfer-encoding',
                        'content-security-policy',
                        'alt-svc',
                    ];
                    if (isCorsBypass) skipHeaders.push('access-control-allow-origin');

                    if (skipHeaders.indexOf(lowerKey) !== -1) continue;

                    const value = response.headers.get(key);
                    if (value === null) continue;
                    // Every URL in the BODY is rewritten through the proxy, but
                    // this one in the headers was not -- and fetchOptions sets
                    // redirect: 'manual', so a 3xx goes straight back to the page
                    // and navigates it off the proxy origin entirely. A
                    // youtube.com target collapses to a path so the browser stays
                    // on localhost and re-enters this same route; anything else
                    // goes back through /cors-bypass/. Relative values already
                    // resolve against the proxy origin, so they are left alone.
                    if (lowerKey === 'location' && /^https?:\/\//i.test(value)) {
                        const yt = value.match(/^https?:\/\/www\.youtube\.com(\/.*)?$/i);
                        res.setHeader(
                            key,
                            yt ? yt[1] || '/' : `http://localhost:${PORT}/cors-bypass/${value}`,
                        );
                        continue;
                    }
                    if (lowerKey === 'set-cookie') {
                        const rawCookies = headerKeys[key];
                        if (Array.isArray(rawCookies)) {
                            const modifiedCookies = rawCookies.map((cookieStr) => {
                                return cookieStr
                                    .replace(/^__Secure-/i, '__LocalSecure-')
                                    .replace(/^__Host-/i, '__LocalHost-')
                                    .replace(/Domain=[^;]+/i, 'Domain=localhost')
                                    .replace(/;\s*Secure/i, '')
                                    .replace(/;\s*SameSite=None/i, '')
                                    .replace(/;\s*;/g, ';')
                                    .replace(/;\s*$/, '');
                            });
                            res.setHeader('Set-Cookie', modifiedCookies);
                            continue;
                        }
                    }

                    res.setHeader(key, value);
                }
            }

            res.setHeader('Access-Control-Allow-Origin', '*');

            const contentType = response.headers.get('content-type') || '';

            if (
                contentType.indexOf('text/html') !== -1 ||
                contentType.indexOf('application/json') !== -1 ||
                contentType.indexOf('javascript') !== -1 ||
                contentType.indexOf('text/css') !== -1
            ) {
                return response.text().then((text) => {
                    if (req.url.indexOf('/tv') === 0 && req.url.indexOf('/tv_config') === -1) {
                        // Insert the userscript for TizenTube, as the first thing in
                        // <head>. Appending it to the end of the document put it after
                        // every one of YouTube's own scripts, so anything the mod
                        // patches -- JSON.parse above all -- had already been captured
                        // by modules that then kept calling the original.
                        const tag = `<script src="http://localhost:${PORT}${USERSCRIPT_PATH}"></script>`;
                        if (/<head[^>]*>/i.test(text)) {
                            text = text.replace(/<head[^>]*>/i, (match) => match + tag);
                        } else if (/<html[^>]*>/i.test(text)) {
                            text = text.replace(/<html[^>]*>/i, (match) => match + tag);
                        } else {
                            text = tag + text;
                        }
                    }

                    const proxyPrefix = `http://localhost:${PORT}/cors-bypass/`;

                    // Rewrite rules for replacing URLs so CORS and presumably YT is happy.
                    text = text.replace(
                        /https:\/\/([a-zA-Z0-9-.]+)\.googlevideo\.com/g,
                        `${proxyPrefix}https://$1.googlevideo.com`,
                    );
                    text = text.replace(
                        /https:\\\/\\\/([a-zA-Z0-9-.]+)\.googlevideo\.com/g,
                        `http:\\/\\/localhost:${PORT}\\/cors-bypass\\/https:\\/\\/$1.googlevideo.com`,
                    );
                    text = text.replace(
                        /"\/\/([a-zA-Z0-9-.]+)\.googlevideo\.com/g,
                        `"${proxyPrefix}https://$1.googlevideo.com`,
                    );

                    text = text.replace(
                        /https:\/\/www\.gstatic\.com/g,
                        `${proxyPrefix}https://www.gstatic.com`,
                    );
                    text = text.replace(
                        /http:\/\/www\.gstatic\.com/g,
                        `${proxyPrefix}https://www.gstatic.com`,
                    );
                    text = text.replace(
                        /"\/\/www\.gstatic\.com/g,
                        `"${proxyPrefix}https://www.gstatic.com`,
                    );
                    text = text.replace(
                        /\(\/\/www\.gstatic\.com/g,
                        `(${proxyPrefix}https://www.gstatic.com`,
                    );

                    text = text.replace(
                        /https:\/\/yt3\.ggpht\.com/g,
                        `${proxyPrefix}https://yt3.ggpht.com`,
                    );

                    text = text.replace(
                        /https:\/\/clients1\.google\.com/g,
                        `${proxyPrefix}https://clients1.google.com`,
                    );
                    text = text.replace(
                        /http:\/\/clients1\.google\.com/g,
                        `${proxyPrefix}https://clients1.google.com`,
                    );
                    text = text.replace(
                        /"\/\/clients1\.google\.com/g,
                        `"${proxyPrefix}https://clients1.google.com`,
                    );

                    text = text.replace(
                        'Set(["www.youtube.com","accounts.google.com"]);',
                        'Set(["www.youtube.com", "accounts.google.com", "localhost"]);',
                    );
                    text = text.replace(
                        /:document\.location\.toString\(\)/g,
                        ':document.location.toString().replace("http://localhost:8099", "https://www.youtube.com")',
                    );
                    text = text.replace(
                        /euri:[^,]+,/g,
                        'euri:document.location.toString().replace("http://localhost:8099", "https://www.youtube.com"),',
                    );
                    text = text.replace(
                        /https:\/\/s\.youtube\.com/g,
                        `${proxyPrefix}https://s.youtube.com`,
                    );
                    text = text.replace(
                        /redirector.googlevideo.com/g,
                        `${proxyPrefix}https://redirector.googlevideo.com`,
                    );
                    text = text.replace(/this.scheme="https"/, 'this.scheme="http"');
                    text = text.replace(
                        /https:\/\/jnn-pa.googleapis.com/g,
                        `${proxyPrefix}https://jnn-pa.googleapis.com`,
                    );
                    text = text.replace(
                        /https:\/\/yt3\.googleusercontent\.com/g,
                        `${proxyPrefix}https://yt3.googleusercontent.com`,
                    );
                    text = text.replace(
                        /"\/\/yt3\.googleusercontent\.com/g,
                        `"${proxyPrefix}https://yt3.googleusercontent.com`,
                    );

                    // In order to fix history not working
                    text = text.replace(
                        /=window\.location\.href;/,
                        '=window.location.href.replace("http://localhost:8099", "https://www.youtube.com");',
                    );
                    text = text.replace(
                        /=document\.location\.href/,
                        '=document.location.href.replace("http://localhost:8099", "https://www.youtube.com")',
                    );

                    res.send(text);
                });
            } else {
                if (response.body) {
                    response.body.pipe(res);
                } else {
                    res.end();
                }
            }
        })
        .catch((error) => {
            console.error(`Proxy Error for [${targetUrl}]: ${error}`);
            console.error(error.stack);
            if (!res.headersSent) {
                res.status(500).send('Proxy Connection Broken');
            }
        });
});

app.listen(PORT, '127.0.0.1');

// Start the DIAL server
(global as typeof globalThis & { isTizenTube?: boolean }).isTizenTube = true;
require('../../dist/service.js');
