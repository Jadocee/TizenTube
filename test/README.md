# Harnesses

Fifteen regression harnesses. They exist because the things that break TizenTube
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
| `splash/test.mjs` | The standalone launch page's state machine over all four service states, its retry path, and that a rejected TV key cannot abort the launch. |

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
- Playwright with Chromium, for the four browser harnesses. Without it they
  skip rather than fail.

Set `TT_STRICT_SKIP=1` to make a skipped harness count as a failure. Skipping is
the right default here — no Chromium on your machine is not a defect in the code
under test — but CI sets it, because there a skip is a hole: a failed browser
install would otherwise leave four harnesses unrun and the whole suite green.

## Adding one

Put it in its own directory, have it print `ok`/`FAIL` lines, and **exit
non-zero when it fails** — a harness that only prints is decoration. Then add a
row to `HARNESSES` in `run.mjs`.
