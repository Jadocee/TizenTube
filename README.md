# ▶️ TizenTube
<p align="center">
    <img width="600px" src=".github/assets/TizenTube Standalone Banner.png">
    <br>
    <sub> TizenTube logo, banner and README by <a href="https://github.com/Zyborg777">@Zyborg777</a> </sub>
</p>

**TizenTube** is a TizenBrew module that enhances your favourite streaming websites viewing experience by removing ads and adding support for Sponsorblock. **Now works as a standalone app!**

** **
🤖 **Looking for an app for Android TVs?** Check out [TizenTube Cobalt](https://github.com/reisxd/TizenTubeCobalt). It offers everything TizenTube has for Android TVs.


<p align="left">
    <a href="https://github.com/reisxd/TizenTubeCobalt/releases/latest">
        <picture>
            <img width="250px"
                src=".github/assets/TizenTube_Cobalt_dl-button.png" />
        </picture>
    </a>
</p>

## 📋 Requirements

**Tizen 9.0 or newer — 2025 TV models and later.**

Tizen 9.0 is the first release whose web engine is Chromium M120, and TizenTube
is built for that engine: the userscript targets it directly and ships no
polyfills, and the standalone app declares `required_version="9.0"`. Both the
TizenBrew module and the standalone app need it.

On an older set the standalone app will refuse to install and the module will
not run correctly. Earlier TizenTube releases still support those TVs.

## ❓ How to install

TizenTube can run two ways. The TizenBrew module is the simpler one; the
standalone app is a normal Tizen app with no TizenBrew dependency.

### As a TizenBrew module

1. Install TizenBrew from [here](https://github.com/reisxd/TizenBrew) and follow the instructions.

2. TizenTube is installed to TizenBrew by default. It should be in the home screen. If not, add `@foxreis/tizentube` as a NPM module in TizenBrew module manager.

### As a standalone app

The standalone app is a signed `.wgt` attached to every
[release](https://github.com/reisxd/TizenTube/releases/latest). Installing it
means sideloading, which needs Developer Mode on the TV and Samsung's `sdb`
tool on a computer (it ships with
[Tizen Studio](https://developer.tizen.org/development/tizen-studio/download)).

**1. Turn on Developer Mode.**

On the TV, open **Apps**, press `1` `2` `3` `4` `5` on the remote, set
**Developer mode** to *On*, and enter a host PC IP.

> ⚠️ **Enter `127.0.0.1`, not your computer's address.**
>
> This is the one step that differs from ordinary Tizen sideloading guides.
> TizenTube attaches a debugger to *itself* to inject its script before
> YouTube's own code runs, so the TV has to accept a debug connection from
> itself. The app checks for exactly `127.0.0.1` (or `1.0.0.127`); with any
> other address the injector path is unavailable.

Restart the TV when prompted.

**2. Install the package.**

Download `TizenTube.wgt` from the latest release, then from your computer:

```sh
sdb connect <TV_IP>          # the TV's address on your network
sdb install TizenTube.wgt
```

`sdb connect` uses port 26101, so the computer and the TV must be on the same
network with nothing between them blocking it. Tizen Studio's **Device
Manager** does the same thing through a GUI if you prefer.

**3. Launch it.** TizenTube appears alongside your other apps.

#### Leave Developer Mode on

Developer Mode is not only needed to install — the app uses it at every launch.
With it on and the host IP set to `127.0.0.1`, TizenTube attaches its debugger
and injects its script before the page's own scripts run, which is what makes
ad blocking reliable from the first frame.

With it off, the app still works: it falls back to serving YouTube through a
local proxy on port 8099 and injecting the script into the page's HTML instead.
That path is a little slower to start and inherently races YouTube's own
bundle, so the injector path is preferred.

#### Building it yourself

CI produces the `.wgt`, but you can build one locally. You need Node 22+, the
packaging tool, and a Tizen author certificate (Tizen Studio's Certificate
Manager can create one):

```sh
npm install -g https://github.com/reisxd/tizen.js/tarball/main

(cd service && npm install && npm run build)             # DIAL service
(cd mods && npm install && npm run build)                # the userscript
(cd standalone/service && npm install && npm run build)  # the app's service
cd standalone
tizenjs build . -t wgt -o release/TizenTube.wgt \
  --author /path/to/author.p12 --authorPwd '<password>' -p public \
  --ignore node_modules,/.*\.wgt$/,/userwidget/,/release/
```

Build the three bundles in that order: the app's service inlines the DIAL
service and the userscript, so both have to exist first. If either is missing
the build exits non-zero rather than producing a package without them.

`npm test` runs the regression harnesses; see [test/README.md](test/README.md).

## ✨ Features
- 📺 **Picture-in-Picture Mode**
- 🛑 **Ad Blocker**: Enjoy your favourite streaming website without interruptions from ads.
- ❗ **SponsorBlock Support**: Automatically skip sponsored segments in videos.
- ⏭️ **Video Speed Control**: Adjust playback speed to your preference.
- 🔺 **[DeArrow](https://dearrow.ajay.app/) Support**: Remove clickbait and misleading video titles.
- ➕ **More to come!** Request features via [issues](https://github.com/reisxd/TizenTube/issues/new).

## 🌐 Community and Support 
| Links |
| ------------- |
| [r/TizenTube Subreddit](https://www.reddit.com/r/TizenTube/)  |
| [Discord Server](https://discord.gg/m2P7v8Y2qR)  | 
| [Telegram](https://t.me/tizentubeofficial)  |
| [Matrix Space](https://matrix.to/#/!BLE5ubNYktI30e8K0j:matrix.6513006.xyz)  |
| [Report Issues / Request Features](https://github.com/reisxd/TizenTube/issues)  |
