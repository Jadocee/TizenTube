# ▶️ TizenTube 9
<p align="center">
    <img width="600px" src=".github/assets/TizenTube Standalone Banner.png">
    <br>
    <sub> Logo, banner and original README by <a href="https://github.com/Zyborg777">@Zyborg777</a> </sub>
</p>

**TizenTube 9** removes ads and sponsored segments from YouTube on Samsung TVs.
It runs either as a [TizenBrew](https://github.com/reisxd/TizenBrew) module or as
a standalone app.

## 🍴 About this fork

TizenTube 9 is a fork of [reisxd/TizenTube](https://github.com/reisxd/TizenTube),
which is where this project comes from and where the great majority of its code
and design were written. If you are looking for the original — particularly if
you have a TV older than 2025 — go there.

The fork exists to make one trade-off the original cannot: **it supports only
Tizen 9.0 and newer.**

Upstream supports Samsung TVs going back to Tizen 3.0, whose browser engine is
Chromium M47 from 2015. Supporting that engine sets the ceiling for everything
else. Every modern API has to be polyfilled or avoided, the build has to
transpile down to ES5, and code that would be straightforward has to be written
around a decade-old runtime. That is the right call for a project that wants to
reach as many TVs as possible, and it is why the original works on hardware
nothing else supports.

This fork gives up that reach deliberately. Tizen 9.0 ships Chromium M120, so
targeting it alone means:

- **No polyfills.** `fetch`, `DOMRect`, `Object.entries`, `Array.prototype.flat`
  and the rest are simply there. The userscript got smaller by dropping them.
- **The compiler enforces the target.** `lib` is pinned to ES2023 — the newest
  edition M120 implements in full — so reaching for an API the TV does not have
  is a build error rather than a black screen in someone's living room.
- **A modern toolchain.** TypeScript 7 and Rolldown, replacing TypeScript 5,
  Rollup, Babel, Terser and `ncc`.

Retargeting also brought back code that had been silently dead for years,
because it was written against APIs Chromium M47 did not have — the
"add my language to the subtitle menu" feature, for one, had never once run.
Finding those led to a broad correctness pass over the rest of the codebase, and
to a suite of regression harnesses that CI now runs on every release. The commit
history has the detail.

None of this is a criticism of the original. It is the same project with the
compatibility floor moved, and the work only exists because upstream wrote
everything underneath it.

## 📋 Requirements

**Tizen 9.0 or newer — 2025 TV models and later.**

Tizen 9.0 is the first release whose web engine is Chromium M120, and TizenTube 9
is built for that engine: the userscript targets it directly and ships no
polyfills, and the standalone app declares `required_version="9.0"`. Both the
TizenBrew module and the standalone app need it.

On an older set the standalone app will refuse to install and the module will not
run correctly. Use [the original TizenTube](https://github.com/reisxd/TizenTube)
on those TVs — it supports Tizen 3.0 and newer.

## ❓ How to install

TizenTube 9 can run two ways. The TizenBrew module is the simpler one; the
standalone app is a normal Tizen app with no TizenBrew dependency.

> ⚠️ **This fork does not publish builds yet.** The npm package and the release
> `.wgt` linked below are the *upstream* project's, so following either section
> as written installs upstream TizenTube, not TizenTube 9. Until this fork
> publishes its own, build from source — see
> [Building it yourself](#building-it-yourself) — and read the two sections
> below for the install mechanics, which are the same either way.

### As a TizenBrew module

1. Install TizenBrew from [here](https://github.com/reisxd/TizenBrew) and follow the instructions.

2. Add `@foxreis/tizentube` as an NPM module in the TizenBrew module manager. Note that this is upstream's package — TizenBrew has no published module for this fork, and `@foxreis/tizentube` is kept as the module name only because the running code sends it to TizenBrew and the update check fetches it.

### As a standalone app

The standalone app is a signed `.wgt`. Upstream attaches one to every
[release](https://github.com/reisxd/TizenTube/releases/latest); this fork has
cut none yet, so build your own. Installing it
means sideloading, which needs Developer Mode on the TV and Samsung's `sdb`
tool on a computer (it ships with
[Tizen Studio](https://developer.tizen.org/development/tizen-studio/download)).

**1. Turn on Developer Mode.**

On the TV, open **Apps**, press `1` `2` `3` `4` `5` on the remote, set
**Developer mode** to *On*, and enter a host PC IP.

> ⚠️ **Enter `127.0.0.1`, not your computer's address.**
>
> This is the one step that differs from ordinary Tizen sideloading guides.
> TizenTube 9 attaches a debugger to *itself* to inject its script before
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

**3. Launch it.** TizenTube 9 appears alongside your other apps.

#### Leave Developer Mode on

Developer Mode is not only needed to install — the app uses it at every launch.
With it on and the host IP set to `127.0.0.1`, TizenTube 9 attaches its debugger
and injects its script before the page's own scripts run, which is what makes
ad blocking reliable from the first frame.

With it off, the app still works: it falls back to serving YouTube through a
local proxy on port 8099 and injecting the script into the page's HTML instead.
That path is a little slower to start and inherently races YouTube's own
bundle, so the injector path is preferred.

#### Building it yourself

CI produces the `.wgt`, but you can build one locally. You need Node 22+, pnpm,
the packaging tool, and a Tizen author certificate (Tizen Studio's Certificate
Manager can create one).

The four package trees are one pnpm workspace with a single `pnpm-lock.yaml`, so
one `pnpm install` at the root covers all of them. `corepack enable` will pick up
the version pinned in `package.json`:

```sh
npm install -g https://github.com/reisxd/tizen.js/tarball/main   # a global CLI

pnpm install                              # all four trees, one lockfile
(cd service && pnpm run build)            # DIAL service
(cd mods && pnpm run build)               # the userscript
(cd standalone/service && pnpm run build) # the app's service
cd standalone
tizenjs build . -t wgt -o release/TizenTube.wgt \
  --author /path/to/author.p12 --authorPwd '<password>' -p public \
  --ignore node_modules,/.*\.wgt$/,/userwidget/,/release/
```

Build the three bundles in that order: the app's service inlines the DIAL
service and the userscript, so both have to exist first. If either is missing
the build exits non-zero rather than producing a package without them.

`pnpm test` runs the regression harnesses; see [test/README.md](test/README.md).

#### Cutting a release

Releases come from the widget version. Bump `version=` on the `<widget>` element
in [standalone/config.xml](standalone/config.xml) in your PR, and merging it
builds, signs and publishes a `.wgt` under that version — if signing is
configured; see below. A merge that leaves the version alone builds and verifies
only — CI warns on a PR that changes shipped
code without bumping it.

That version is the one a television uses for install and upgrade semantics, so
two packages carrying the same one cannot be cleanly installed over each other.
Pushing a `v*.*.*` tag by hand still publishes, and CI will not move a tag that
already exists.

##### Signing is opt-in

A `.wgt` is a signed Tizen widget and there is no unsigned form of one, so
publishing needs a certificate. Two repository secrets supply it:

| Secret | Value |
| --- | --- |
| `TIZEN_AUTHOR_KEY` | `base64 -w0 author.p12` — the whole output on one line |
| `TIZEN_AUTHOR_KEY_PW` | the password for that `.p12` |

**Neither is needed to install TizenTube 9 as a TizenBrew module**, which is the
route most people use — nothing on that path is packaged or signed. With both
secrets absent, a version bump builds and verifies, then warns that it cannot
sign and skips packaging; the run stays green and no release is cut. Set them
and the same bump publishes.

Setting only one of the pair fails instead, as does a value that is not a usable
`.p12`: that is half-finished setup rather than a decision not to publish, and
it is worth hearing about at the step that is meant to produce the certificate.

## ✨ Features
- 📺 **Picture-in-Picture Mode**
- 🛑 **Ad Blocker**: Enjoy your favourite streaming website without interruptions from ads.
- ❗ **SponsorBlock Support**: Automatically skip sponsored segments in videos.
- ⏭️ **Video Speed Control**: Adjust playback speed to your preference.
- 🔺 **[DeArrow](https://dearrow.ajay.app/) Support**: Remove clickbait and misleading video titles.
- ➕ **More to come!** Request features via [issues](https://github.com/reisxd/TizenTube/issues/new).

## 🌐 Community and Support

Bugs in **this fork** belong here:

| Links |
| ------------- |
| [Report Issues / Request Features](https://github.com/Jadocee/TizenTube/issues)  |

The community below belongs to the original project. It is the right place for
questions about TizenTube generally, and the wrong place to report something
this fork broke:

| Links |
| ------------- |
| [r/TizenTube Subreddit](https://www.reddit.com/r/TizenTube/)  |
| [Discord Server](https://discord.gg/m2P7v8Y2qR)  |
| [Telegram](https://t.me/tizentubeofficial)  |
| [Matrix Space](https://matrix.to/#/!BLE5ubNYktI30e8K0j:matrix.6513006.xyz)  |
