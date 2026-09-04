# Harnesses

Forty-two regression harnesses. They exist because the things that break TizenTube
mostly cannot be caught by a typechecker or by reading a diff: a renderer shape
that only appears at runtime, a focus trap you only find with a D-pad, a
stylesheet that works until CSP is enforced, a script that behaves differently
depending on whether `<body>` exists yet.

```
pnpm test                      # everything
node test/run.mjs              # the same thing
node test/run.mjs settings     # only harnesses matching a name
```

Exit code is 0 only if every harness that ran passed. Harnesses that cannot run
here (no browser, no built bundle) report as *skipped*, not passed.

## What each one covers

| Harness | What it would catch |
|---|---|
| `settings/drive.mjs` | Walks every settings menu the way a user would, following the real `OPTIONS_SHOW` commands. Reports menu/row counts and any config key read but missing from `defaultConfig`. |
| `settings/stale.mjs` | Menu scenarios end to end: picking a value, the list reopening on that value, clearing it again. |
| `settings/crumb.mjs` | The startup-error breadcrumb, including a non-Error argument and a `localStorage` that throws. |
| `whos-watching/test.mjs` | Every real shape YouTube's `recurring_actions` blob can take. This code runs at module scope, so a throw here aborts every module imported after it. |
| `command-executor/test.mjs` | Resolving YouTube's action router out of the minified registry — the function whose failure produced the original black-screen-on-launch. Covers a module that throws, one that returns nothing, a decoy that only mentions the router in its source, a prototype whose `constructor` matches, and an accessor that must not be invoked. |
| `adblock/test.mjs` | The `_yttv` JSON patch loop against modules that register late, are frozen, or carry no `JSON`. |
| `stylesheet/run.mjs` | Runs the real stylesheet code in Chromium under an enforced nonce-only CSP, and shows the old approach destroying YouTube's CSSOM rules beside the current one preserving them. |
| `injection/proxy.test.mjs` | Where the proxy puts the userscript tag and on which requests, running the real injection block lifted out of `index.ts` — it used to assert against its own copy of that logic, so moving the tag back to the end of the document passed clean. Plus the loader's packaged-copy preference and update check. |
| `injection/docstart.mjs` | Loads the **real built bundle** in Chromium as the first script in `<head>`, before `<body>` exists, and asserts it boots with no uncaught errors. |
| `injection/late.mjs` | The same bundle injected last in `<body>`. |
| `injector/test.mjs` | The standalone injector's attach, against a fake sdbd and a fake CDP endpoint: that `isConnecting` stays true from the attach starting until the page is navigated, across a slow upload, the legacy-register fallback and an empty userscript. Clearing it early is what let the splash exit the app out from under its own attach. |
| `strict-bundle/test.mjs` | Parses the shipped service bundle and fails on any assignment to an undeclared name. The bundle is strict, so each one is a latent ReferenceError -- which is how a dependency's implicit global silently killed debugger injection on every launch. |
| `sponsorblock-channels/test.mjs` | The per-channel SponsorBlock opt-out: recording the channel from a player response, looking it up by video id when the two events race, matching by id so a renamed channel stays disabled, surviving junk payloads, and keeping the map bounded. |
| `panel-style/test.mjs` | The theme panel's stylesheet in Chromium, rendered with the inline `display` `ui.ts` actually sets: that the nesting parsed, that rows stay separated and corners rounded, that text clears 3:1 at 24px, that focus lights the whole row, that the four YouTube override rules still land, and that the panel stays inside the title-safe inset on each axis. |
| `release-gate/cert.test.mjs` | `.github/scripts/prepare-certificate.sh`, which turns the signing secrets into a `.p12`: unset secrets, empty secrets, a key with no password, base64 that decodes to something far too small, invalid base64, and a real generated certificate with both the right password and a wrong one. The first release failed because an unset secret produced a zero-byte file and the packager reported "Too few bytes to parse DER". |
| `json-prune/test.mjs` | The path matcher behind ad filtering, and the rules `adblock.ts` actually ships (lifted, not copied): `*` and `**` matching, replace vs delete, dropping a promoted item from a list while keeping the real ones, and the cases the old hardcoded branches missed — a nested `adPlacements`, and an ad in a grid surface. Also the cheap source-text pre-check, and that a pathological payload stays bounded. |
| `release-gate/npm.test.mjs` | `.github/scripts/npm-gate.sh` and `registry-state.mjs`, which decide whether a run publishes the npm package TizenBrew installs. An npm version cannot be un-taken and cannot meaningfully be unpublished after 72 hours, so a gate that fires when it should not is unrecoverable in a way a bad GitHub release is not. The registry is stubbed on `PATH` rather than reached, answering with a real packument, and the stub records its argv so "which package did the gate ask about" is asserted rather than assumed. Covers an unpublished package publishing even when the version did not change (the case the old version-changed rule could not reach, which is why nothing was ever published), a taken version refusing, a version *behind* the published `latest` refusing so the tag cannot move backwards, semver rather than string comparison — build metadata not hiding a taken version, `1.10.0` not sorting before `1.9.0`, prereleases either side of a release — an unreachable registry falling back to the version diff, a reply that no packument reader can use, no `npm` on `PATH` at all, pull requests, tag pushes, a new branch, a shallow checkout, that a missing or half-built `dist/` fails the run rather than publishing a manifest naming files the tarball does not contain, and that the DIAL service names the same package `package.json` publishes under. |
| `release-gate/workflow.test.mjs` | The release workflow itself. The pull-request version nudge is **extracted from the YAML and run** against throwaway repositories — matching its source for a filename proves it reads a file, not that it warns — covering a change to `mods/`, to shipped `package.json` fields, to `standalone/`, each with and without the matching version bump, a docs-only change that must warn about neither, and an unreachable base. The step guards cannot be run without GitHub, so they are read but compared **whole**: `if:` is a boolean expression, and a check that merely finds the guard text inside it passes for `github.event_name == 'pull_request' || (…)`, which publishes from every pull request. Also asserts every step it reasons about exists before comparing positions (an `indexOf` of an absent step is `-1`, which is less than every real index, so "published after the harnesses" would pass loudest with no harnesses left), and that `setup-node` is given the `registry-url` without which `npm publish` cannot authenticate at all. |
| `release-gate/wgt-docker.test.mjs` | The Docker stack in `docker/tizen/` that builds and signs the `.wgt` with the real Tizen Studio Web CLI. Nothing here builds an image — that needs a daemon, a 401 MB download from Samsung and an amd64 host — so it checks the parts that do not: the two shell helpers, run against synthetic inputs. The signature gate is the one that matters, because `tizen package` **exits 0 while writing an unsigned archive** when its profile is missing, so that gate is all that stands between a wrong password and a widget no television will install; it is driven against a signed archive, an unsigned one, each signature alone, one with no `config.xml`, a non-archive, an empty file and a missing file. The password encoder is checked against Samsung's **own** stored value: the SDK ships a `profiles.xml` holding the public distributor password as DESede ciphertext, so encoding that known plaintext must reproduce that exact string — if it does not, the profile we write is one the CLI cannot read. Also asserts the invariants that are security or correctness rather than style: no certificate in an image layer, no password as a build arg, no published port (sdb's local server binds `0.0.0.0:26099`), the post-install check that exists because the SDK installer always exits 0, and that the entrypoint never deletes from the bind-mounted tree. Comments are stripped before matching, because each of those files explains itself immediately above doing the thing. |
| `release-gate/wgt-compose.test.mjs` | `compose.yaml`, parsed by compose itself and asserted **per service** rather than by regex over the rendered document — so a property claimed for the build service cannot be satisfied by the debug shell. Covers the amd64 pin, `network_mode: none` on the build, the read-only certificate mount, no published ports on either service (sdb's local server binds `0.0.0.0:26099`), the debug shell being behind a profile and absent from the default set, and that compose still works with no certificate password so `build`, `ps` and `down` are not blocked by a secret. Exits 2 when Docker is absent, so the skip is visible to `TT_STRICT_SKIP` instead of printing mid-run and still reporting ALL PASS. |
| `release-gate/test.mjs` | `.github/scripts/release-gate.sh`, which decides whether a CI run publishes a signed `.wgt` and under which tag: a version bump on main, an unchanged version, a bump onto a tag that already exists, a tag push, a pull request, and a branch with no previous commit — each against a throwaway git repo with real history. |
| `splash/test.mjs` | The standalone launch page's state machine over all four service states, its retry path, and that a rejected TV key cannot abort the launch. |
| `preview-indicator/state.mjs` | The mark that says a focused thumbnail is playing: that it is cancelled by the focus move that caused it, cleared when playback ends, never stranded by a missed stop event, and never anchored to anything but the tile it belongs to. Each of those arrives on a television as "the icon is weird" and nothing more. |
| `preview-indicator/style.mjs` | The same mark's stylesheet in Chromium, including a negative control — a rule that never matches must show nothing rather than parking a disc in the corner — and physical rather than logical insets, since `document.body` inherits the app's `direction` and an Arabic account would otherwise get it off the opposite edge. |
| `preview-indicator/runtime.mjs` | The DOM shell around the state machine, on a fake clock and a fake DOM. It exists because of *where* the bugs were: the reducer had a harness from day one and was correct, while every defect a review found was in the dispatcher around it — what gets reset on a restart, which timer is re-armed, what `disable()` tears down. None of that is visible from a pure function's return value. |
| `preview-indicator/hook.mjs` | The wrapper around YouTube's `PlaybackPreviewService`, against a fake service with the *real* prototype's methods — `start` and `end`, and no `stop`. The wrapper hooked `stop` for its whole life, which merely created a property nothing called, so it reported itself hooked and `onPreviewStop` never fired once. A fixture invented to suit the code would have had a `stop` and passed. |
| `transport-slots/test.mjs` | Which transport-control slot gets *previous* and which gets *next*. The app's two skip-button accessors are fixed **slots** whose meaning swaps with layout direction — `isRtl ? skipNextButton : skipPreviousButton` — while `customUI` finds them by matching source text, which carries the whole ternary and reads identically either way. So the mod assigned previous to the first slot always, and on a right-to-left account its two buttons sat the wrong way round. |
| `transport-slots/blue.mjs` | The BLUE key closing the theme panel, driven through the real handler. Separate from the registry's own tests next door because those pass with `speedUI` back to inlining the close and skipping the focus hand-back — which *is* the bug. Proven, not assumed: reverting `speedUI` leaves the registry harness green and fails this one. |
| `skip-filter/test.mjs` | Which SponsorBlock segment gets skipped and where the player lands. Written to settle an argument: a review proposed dropping one conjunct as redundant and split over the guard it was bundled with. Both halves are decided here — the conjunct *is* redundant for well-formed segments and stays anyway, because it is what stops a malformed one seeking the player backwards; and the end-of-video rewind really does re-select a short final segment once, bounded by the caller's repeat guard. |
| `tile-fixes/test.mjs` | The per-tile and per-shelf decisions the home page depends on: picking a thumbnail that actually exists instead of synthesising a 4:3 URL and declaring it fact, deciding a tile is previewable, reading the members-only badge out of the real `lineItemRenderer` path, and recognising an emptied shelf. |
| `tile-fixes/dearrow.mjs` | How many DeArrow requests actually leave the machine, driven with a counting fake `fetch`. Uncached, a first home screen was on the order of a hundred and fifty outbound requests fired at once at a television SoC, again on every continuation. |
| `focus-motion/test.mjs` | That one failing write to `tectonicConfig` costs only its own switch. All six lived in a single bare `try`/`catch` whose first statement dereferenced an object the app may not have published yet, so the two most-felt animation switches were lost silently. |
| `guide-reselect/test.mjs` | Selecting the sidebar entry for the page you are already on, where the app deliberately dispatches nothing. The feature works by noticing an absence, so what is asserted is the set of conditions under which it stands down — a wrong refresh reloads a page the user was navigating away from. |
| `tile-menu/test.mjs` | The long-press menu's suppression rows against tiles lifted verbatim from captured browse responses, including the ones the captures proved are real: a tile from a channel's own page that yields no `UC` id at all, and a subtitle whose tail is a series name rather than a handle. |
| `guide-filter/test.mjs` | Which sidebar entries get removed, against a genuine `/youtubei/v1/guide` response — which is why it exists: the capture shows a guide keeps its entries in `items`, `footer` and `topbar`, and the previous filter walked only the first. |
| `caption-prefs/test.mjs` | The remembered caption preference, asserted against the exact command shapes `CaptionsService` handles: an empty `selectSubtitlesTrackCommand` payload is captions-off and `useDefaultTrack` is captions-on. Those two are the whole interface. |
| `caption-prefs/runtime.mjs` | The caption wiring, on a fake clock and a fake route: that a video whose player response has not landed *waits* instead of inheriting the previous video's channel, in both directions, and that the wait still has a limit. The predicate harness beside it passed the whole time this was resolving against the wrong channel. |
| `aislist/test.mjs` | Parsing and matching the AiSList channel lists against a real slice of the published file, including the trap its own format header does not mention: 498 of the handles are percent-encoded or non-ASCII, and a tile's subtitle carries the decoded form. |
| `aislist/refresh.mjs` | The fetch-and-cache half, driven with a fake fetch and a fake clock — the questions `parseList` cannot answer: that a warnlist 404 does not discard the blocklist that just downloaded, that each list's freshness is its own, and that a captive portal answering `200` with a login page cannot empty a working list or cache the emptiness. |
| `aislist/toggle.mjs` | *When* the fetch is kicked off — the module's side effects are the whole of it, which is why nothing covered it. The gate used to run once at import, so ticking the box left the row reading ON and the feature hiding nothing until the app was relaunched. |
| `css-nesting/test.mjs` | Declarations Chromium M120 quietly *reorders*. CSS nesting works there, but `CSSNestedDeclarations` only shipped in Chrome 130 — so a bare declaration placed *after* a nested rule is hoisted above it instead of keeping its source position. Measured against real Chrome 120: it still applies, but it loses to any nested rule setting the same property, which a modern Chromium resolves the other way. One block, two colours, depending on the engine. Carries its own positive controls, because a scanner nobody has seen fail is indistinguishable from one that returns nothing. |
| `docs/test.mjs` | That the counts this document and `docs/BUILDING.md` quote are the counts `run.mjs` actually has, and that the table above has a row per harness. Prose is not executed, so every feature added a harness and left every number here quietly wrong. |

## Snapshots

Some harnesses run the mod's real code but hold a *copy* of it — a `.mts` with
its imports repointed at stubs, a transpiled module spliced into a test page, a
function lifted out of a larger file. `test/refresh.mjs` re-derives all of those
from source, and `run.mjs` calls it first. That is what makes a failure mean
"the code regressed" rather than "the copy is stale". Generated files are
gitignored; do not edit them.

The `old.html` fixture is deliberately **not** derived. It reproduces the bug
that was fixed, so the harness can show the before and after side by side.

## Requirements

- Node 22+ (`--experimental-strip-types` is used for the `.mts` snapshots).
- `pnpm install` at the repository root — the refresh step uses `mods/`'s TypeScript compiler.
- `dist/userScript.js` built, for the two harnesses that load the real bundle.
- Playwright with Chromium, for the five browser harnesses. Without it they
  skip rather than fail.

Set `TT_STRICT_SKIP=1` to make a skipped harness count as a failure. Skipping is
the right default here — no Chromium on your machine is not a defect in the code
under test — but CI sets it, because there a skip is a hole: a failed browser
install would otherwise leave five harnesses unrun and the whole suite green.

## Adding one

Put it in its own directory, have it print `ok`/`FAIL` lines, and **exit
non-zero when it fails** — a harness that only prints is decoration. Then add a
row to `HARNESSES` in `run.mjs`.
