# Building TizenTube 9

Everything here is what CI does, in the same order, with the same commands.
[`.github/workflows/build-release.yaml`](../.github/workflows/build-release.yaml)
is the authority; if the two ever disagree, the workflow is right and this file
is stale.

- [What you are building](#what-you-are-building)
- [Prerequisites](#prerequisites)
- [The short version](#the-short-version)
- [The four package trees](#the-four-package-trees)
- [Build order, and why it is not negotiable](#build-order-and-why-it-is-not-negotiable)
- [Checking your work](#checking-your-work)
- [Packaging the `.wgt`](#packaging-the-wgt)
- [Installing it on a television](#installing-it-on-a-television)
- [Troubleshooting](#troubleshooting)

## What you are building

There are two products in this repository and they are built differently.

| | Built from | Output | Signed? |
| --- | --- | --- | --- |
| **TizenBrew module** | `mods/` | `dist/userScript.js` | no |
| **Standalone app** | all four trees | `standalone/release/TizenTube.wgt` | yes, always |

The TizenBrew module is one JavaScript file that TizenBrew injects into
YouTube's TV app. Building it is a single command and needs no certificate.

The standalone app is a Tizen widget that launches YouTube itself and injects
the same script. It bundles a local proxy, a DIAL service and a debugger
injector, and a `.wgt` cannot exist unsigned — see
[Packaging](#packaging-the-wgt).

## Prerequisites

| | Version | Why |
| --- | --- | --- |
| Node | **22.6 or newer** | twenty-two harnesses run under `--experimental-strip-types`, which lands in 22.6. On Node 20 they fail before a single assertion. CI pins 22. |
| pnpm | 10.33.0 | pinned by `packageManager` in the root `package.json`; `corepack enable` picks it up |
| Chromium | any recent | only for the five browser harnesses. Without it they *skip*, which is fine locally and a failure in CI |
| `tizen.js` | from git `main` | only to package a `.wgt`. Not needed to build, typecheck or test |
| A Tizen author certificate | — | only to package a `.wgt` |

Nothing here needs Tizen Studio installed, except as a convenient way to create
the certificate.

## The short version

```sh
corepack enable
pnpm install                              # all four trees, one lockfile

(cd mods && pnpm run build)               # 1. the userscript
(cd service && pnpm run build)            # 2. the DIAL service
(cd standalone/service && pnpm run build) # 3. the app's service

pnpm test                                 # 35 harnesses
```

Under ten seconds in total on a warm checkout. If you only want the TizenBrew
module, step 1 is the whole build.

`pnpm install` at the root covers every tree: they are one workspace with a
single `pnpm-lock.yaml`. Do not run `npm install` inside a subdirectory — it
will build a second, unrelated `node_modules` beside the workspace's symlinks.

## The four package trees

| Directory | Package | Produces |
| --- | --- | --- |
| `mods/` | `@tizentube/mods` | `dist/userScript.js` — the injected script, IIFE, ~512 KB |
| `service/` | `@tizentube/dial-service` | `dist/service.js` — DIAL, so a phone can cast to the app |
| `standalone/service/` | `@tizentube/standalone-service` | `standalone/service/dist/index.js` — the app's background service, ~3.5 MB |
| *(root)* | `@foxreis/tizentube` | nothing; it holds the harnesses and the lockfile |

`standalone/` itself is not a package. It is the widget: `config.xml`,
`index.html`, two icons, and the service directory.

Both `dist/` directories are gitignored, as is
`standalone/service/userScript.generated.js`. Every build artefact is
reproducible from source, and none of them is committed.

## Build order, and why it is not negotiable

```
mods ──────► dist/userScript.js ──┐
                                  ├──► standalone/service/dist/index.js
service ───► dist/service.js ─────┘
```

The app's service **inlines** both of the others. `embed-userscript.js` reads
`dist/userScript.js` and writes it into `userScript.generated.js` as a string
literal; `index.ts` requires `../../dist/service.js`, which rolldown resolves and
inlines at build time. That is why the finished `index.js` is 3.5 MB and why
nothing at runtime ever goes looking for those files.

Getting the order wrong fails immediately and says so:

```
[embed] Missing the userscript: /path/to/dist/userScript.js
[embed] Build it first:  cd mods && pnpm run build
[embed] Build order is mods -> service -> standalone/service. See docs/BUILDING.md.
```

Both dependencies are checked before the bundler starts, because rolldown's own
failure for a missing one is a stack trace through its internals that names
neither the file nor the command that produces it.

**Rebuild the app's service after touching `mods/` or `service/`.** The inlining
happens at build time, so an app service built earlier still carries the old
copy. This is the one way to get a `.wgt` that is quietly a version behind.

## Checking your work

```sh
pnpm check                                         # Biome: format + lint
pnpm -r --workspace-concurrency=1 run typecheck   # all three TypeScript trees
pnpm test                                          # 35 harnesses
pnpm test settings                                 # just the ones matching "settings"
```

### Formatting and linting

[Biome](https://biomejs.dev) is both the formatter and the linter, configured in
`biome.json` at the root. It handles the whole repository — all four package
trees, the harnesses, JSON and CSS — from a single binary, so there is nothing
per-package to install or configure.

```sh
pnpm check        # report formatting and lint problems
pnpm check:fix    # ...and fix the ones that are safely fixable
pnpm format       # formatting only
pnpm lint         # linting only
```

CI runs `biome ci --error-on-warnings`, and the flag is the point: without it
Biome exits 0 with a screen full of warnings, which is the same as not running
it. The repository is clean at that setting, so anything the step reports is
new.

### Which rules are off, and why

The recommended set reported 494 problems on existing code. Each rule was read
against what this code actually is before being switched off, because a rule
disabled to reach green is worse than no rule. Six are off repository-wide:

| Rule | Why |
| --- | --- |
| `noExplicitAny` | InnerTube payloads are dynamic JSON from a server this mod does not control. `any` at that boundary is the honest type |
| `noNonNullAssertion` | every site is a guard TypeScript's narrower cannot follow across a call, and the rule's own suggested fix changes behaviour at more than half of them |
| `noArguments` | every use is `.apply(this, arguments)` forwarding a call into a function the mod wrapped but does not own. Naming the parameters would change what gets forwarded |
| `noImportantStyles` | `!important` is how a userscript overrides its host page. Every use is on one of YouTube's own selectors; the mod's own panel uses it zero times |
| `noGlobalEval` | three sites, all in harnesses that need a *fresh* evaluation of generated code per scenario, which `import` caches |
| `noImplicitAnyLet` | the message is wrong for TypeScript: `let x;` gets an *evolving* any, narrowed by control flow. `tsc --strict` reports nothing at any of these |

Two are scoped rather than disabled. `useIterableCallbackReturn` keeps its
`checkForEach: false` option, which silences 20 inert `forEach` callbacks while
leaving the half that matters — a `map` or `filter` callback that forgets to
return, which silently drops every element — at error severity.
`noPrototypeBuiltins` is off only for the two service trees, which target ES2018.

Everything else was fixed. Where an idiom is genuinely right in one place, there
is a `biome-ignore` on that line with the reason, not a disabled rule.

Four kinds of file are deliberately outside Biome's reach, listed in
`biome.json`:

| Excluded | Why |
| --- | --- |
| `test/**/*.generated.*` | derived from source by `test/refresh.mjs` on every run; formatting them would fight the generator |
| `test/tile-menu/fixtures.json`, `test/guide-filter/guide.json` | captured verbatim from real InnerTube responses. Reformatting is semantically harmless and still wrong: these files' value is that nothing has touched them |
| `mods/spatial-navigation-polyfill.js` | vendored third-party code |
| `dist/` | build output |

If you are wondering why the repository formatted cleanly in one commit rather
than gradually: that commit is listed in `.git-blame-ignore-revs`, so
`git blame` skips it. Run `git config blame.ignoreRevsFile .git-blame-ignore-revs`
once and blame will read as though the reformat never happened.

`test/run.mjs` re-derives its generated snapshots from the current sources
before every run, so a failure always means the code changed rather than a copy
going stale. See [test/README.md](../test/README.md).

Five harnesses drive real Chromium through Playwright and two of those also need
`dist/userScript.js` to exist. Without Chromium they report `SKIPPED` and the run
still passes — a missing browser is not a defect in the code under test. CI sets
`TT_STRICT_SKIP=1`, which makes a skip count as a failure, because there a
skipped harness is coverage that silently did not run:

```sh
TT_STRICT_SKIP=1 pnpm test    # what CI runs
```

## Packaging the `.wgt`

> Verified: everything above, on a clean checkout. **Not** verified here: the
> two commands in this section, because this environment cannot reach GitHub to
> install `tizen.js`. They are reproduced exactly from the release workflow,
> which is what actually cuts releases.

A Tizen widget carries `author-signature.xml` and `signature1.xml`, and
`tizen.js` reads `--author` unconditionally — there is no unsigned path, and a
television's installer would reject one anyway. Tizen Studio's **Certificate
Manager** creates the `.p12`. The distributor certificate is optional; the
packager falls back to the public `tizen-distributor-signer.p12`.

```sh
# A global CLI, deliberately not a workspace dependency.
npm install -g https://github.com/reisxd/tizen.js/tarball/main

cd standalone
rm -rf service/node_modules            # see below
mkdir -p release
tizenjs build . -t wgt -o release/TizenTube.wgt \
  --author /path/to/author.p12 --authorPwd '<password>' -p public \
  --ignore node_modules,/.*\.wgt$/,/userwidget/,/release/
```

`rm -rf service/node_modules` matters more than it looks. In a pnpm workspace
that directory is a tree of symlinks into the store, and the app ships a bundle
that already contains every dependency — so there is no reason for a dependency
tree to be anywhere near the `.wgt`. It is deleted *and* ignored, belt and
braces.

What ends up inside: `config.xml`, `index.html`, both icons, and
`service/dist/index.js`. `config.xml` points `<content>` at `index.html` and
`<tizen:service>` at `service/dist/index.js`, so if the third build did not run,
you get a widget that installs and does nothing.

CI does all of this for you on a version bump. See
[Cutting a release](../README.md#cutting-a-release).

## Installing it on a television

Developer Mode has to stay on: the app's preferred injection path attaches a
debugger over the local network, and the switch that exposes it is the same one.
Full instructions, including the host IP, are in
[the README](../README.md#as-a-standalone-app).

```sh
sdb connect <tv-ip>
sdb install standalone/release/TizenTube.wgt
```

Installing over an existing copy needs a **higher** `version=` on the `<widget>`
element in `config.xml`. Two packages carrying the same version cannot be
cleanly installed over each other — that field is what the television uses for
upgrade semantics, and it is also what triggers a release in CI.

## Troubleshooting

**`[embed] Missing ...`** — you skipped a build. Run them in order.

**Twenty-two harnesses fail before asserting anything** — Node is older than 22.6.
`node -v`.

**`ERR_PNPM_OUTDATED_LOCKFILE` in CI** — a manifest changed without the lockfile.
Run `pnpm install` locally and commit `pnpm-lock.yaml`.

**Harnesses report `SKIPPED`** — no Chromium. `pnpm exec playwright install --with-deps chromium`.

**Your change does not appear on the TV** — the app's service was not rebuilt.
It inlines the userscript at build time; see
[Build order](#build-order-and-why-it-is-not-negotiable).

**`Error: Too few bytes to parse DER`** from the packager — the `.p12` is empty
or truncated. In CI that means the signing secrets are not set; see
[Signing is opt-in](../README.md#signing-is-opt-in).

**The app installs but shows nothing** — `standalone/service/dist/index.js` is
missing from the package, so the widget has no service. Rebuild step 3 and
repackage.
