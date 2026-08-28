// A URL that needs no rewriting is handed straight back, so a string in gives
// a string out and callers that go on to do string work still typecheck.
function redirectUrl(originalUrl: string): string;
function redirectUrl(originalUrl: string | URL): string | URL;
function redirectUrl(originalUrl: string | URL): string | URL {
    if (!originalUrl) return originalUrl;

    try {
        if (typeof originalUrl === 'string' && originalUrl.startsWith('//')) originalUrl = originalUrl.replace('//', 'https://')
        const url = new URL(originalUrl, window.location.origin);
        const hostname = url.hostname;

        if (hostname === 'youtube.com' || hostname === 'www.youtube.com') {
            url.protocol = 'http:';
            url.host = 'localhost:8099';
            return url.toString();
        }

        if (hostname.endsWith('googlevideo.com') || hostname.endsWith('youtube.com')
            || hostname.endsWith('gstatic.com') || hostname.endsWith('.google.com')
            || hostname.endsWith('.googleapis.com') || hostname.endsWith('googleusercontent.com')
            || hostname.endsWith('.ggpht.com')) {
            return 'http://localhost:8099/cors-bypass/' + url.toString();
        }
    } catch (e) {
        console.error('Failed to parse URL during interception:', e);
    }

    return originalUrl;
}

export default function (): void {
    const originalFetch = window.fetch;
    if (originalFetch) {
        window.fetch = function (input, init) {
            let targetUrl = '';
            let isRequestObject = false;

            if (typeof input === 'string') {
                targetUrl = redirectUrl(input);
            } else if (input instanceof URL) {
                targetUrl = redirectUrl(input.toString());
                input = new URL(targetUrl);
            } else if (input instanceof Request) {
                isRequestObject = true;
                targetUrl = redirectUrl(input.url);
            }

            // The flag is only ever set on the `instanceof Request` branch
            // above, which is a narrowing the compiler cannot follow through a
            // boolean, hence the casts.
            if (isRequestObject) {
                if ((input as Request).method === 'POST' && targetUrl.indexOf('localhost') !== -1) {
                    const modifiedOptions: RequestInit = {
                        method: (input as Request).method,
                        headers: new Headers((input as Request).headers),
                        mode: (input as Request).mode,
                        credentials: (input as Request).credentials,
                    };

                    if ((input as Request).body && !(input as Request).bodyUsed) {
                        // One clone, not two: each clone() tees the body stream,
                        // and the second was never read.
                        return (input as Request).clone().arrayBuffer().then(function (buffer) {
                            modifiedOptions.body = buffer;

                            return originalFetch(targetUrl, modifiedOptions);
                        });
                    }

                    return originalFetch(targetUrl, modifiedOptions);
                }

                input = new Request(targetUrl, input as Request);
            }

            return originalFetch.apply(this, [targetUrl, init]);
        };
    }

    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method: string, url: string | URL, async?: boolean, user?: string | null, password?: string | null) {
        const redirectedUrl = redirectUrl(url);
        if (redirectedUrl !== url) {
            async = true;
        }

        if (async === undefined) {
            async = true;
        }

        return originalOpen.apply(this, [method, redirectedUrl, async, user, password]);
    };

    if (navigator.sendBeacon) {
        const originalSendBeacon = navigator.sendBeacon;
        navigator.sendBeacon = function (url, data) {
            console.log("Beacon data:", data);
            return originalSendBeacon.apply(this, [redirectUrl(url), data]);
        };
    }

    Object.defineProperty(HTMLImageElement.prototype, 'src', {
        set: function(value) {
            const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'setAttribute');
            descriptor!.value.call(this, 'src', redirectUrl(value));
        }
    });
    Object.defineProperty(HTMLScriptElement.prototype, 'src', {
        set: function(value) {
            const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'setAttribute');
            descriptor!.value.call(this, 'src', redirectUrl(value));
        }
    });
}