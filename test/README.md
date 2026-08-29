# Harnesses

Eleven regression harnesses. They exist because the things that break TizenTube
mostly cannot be caught by a typechecker or by reading a diff: a renderer shape
that only appears at runtime, a focus trap you only find with a D-pad, a
stylesheet that works until CSP is enforced, a script that behaves differently
depending on whether `<body>` exists yet.

```
node test/run.mjs              # everything
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
| `injection/proxy.test.mjs` | Where the proxy injects the userscript tag, and that the loader prefers the packaged copy. |
| `injection/docstart.mjs` | Loads the **real built bundle** in Chromium as the first script in `<head>`, before `<body>` exists, and asserts it boots with no uncaught errors. |
| `injection/late.mjs` | The same bundle injected last in `<body>`. |
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
- `npm install` in `mods/` — the refresh step uses that TypeScript compiler.
- `dist/userScript.js` built, for the two harnesses that load the real bundle.
- Playwright with Chromium, for the three browser harnesses. Without it they
  skip rather than fail.

## Adding one

Put it in its own directory, have it print `ok`/`FAIL` lines, and **exit
non-zero when it fails** — a harness that only prints is decoration. Then add a
row to `HARNESSES` in `run.mjs`.
