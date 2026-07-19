# AGENTS.md

Guidance for AI coding agents working in this repository. For *why* the
system is shaped this way, read [ARCHITECTURE.md](ARCHITECTURE.md) first —
this file is about how to work in it without breaking things that aren't
obvious from reading any single file.

## Build order matters

`public/` is generated, not authored. Always rebuild the web layer before
the native layer, or you'll be testing stale JS against new C++ (or a
missing `public/` entirely on a clean checkout):

```sh
cd web && npm install && npm run build && cd ..
cmake -B build
cmake --build build --target physicalsim -j --config Debug
```

`npm run typecheck` (in `web/`) surfaces one pre-existing type-narrowing
issue inside `avr8js`'s own `adc.ts`, unrelated to this repo's code — it
doesn't affect `npm run build`, which uses esbuild/Vite transpilation, not
`tsc`. Don't try to "fix" it by editing the submodule.

## Never run npm/npx/tsc inside `simulators/*`

`simulators/rp2040js` and `simulators/avr8js` are git submodules (forks).
Running `npm install`, `npx <anything>`, or `tsc` *inside* either of them
can trigger their own `prepare`/`prepublish` scripts, which emit compiled
`.js`/`.d.ts` files alongside the `.ts` sources they ship. If that happens,
those stray `.js` files silently shadow the `.ts` source for Vite/esbuild's
import resolution (both submodules use `.js`-suffixed specifiers in their
own `.ts` files, NodeNext convention) — bypassing the
`useDefineForClassFields: false` fix in `web/shell/vite.config.ts` and
reintroducing a genuine runtime crash (use-before-init in several peripheral
classes), not just a lint nitpick. This bit us once already during
development.

If you ever see `git status` inside a submodule listing untracked `.js`/
`.d.ts` files next to `.ts` ones: `git clean -fdx src` inside that submodule,
then rebuild `web/`.

## Adding or swapping a simulator

Don't touch the shell UI or the bridge protocol for this. The whole point of
the adapter architecture is that it's isolated to:

1. `git submodule add <fork-url> simulators/<name>`
2. Alias it in `web/shell/vite.config.ts` (`resolve.alias`) pointing at
   `simulators/<name>/src/index.ts` — not a prebuilt package.
3. New package `web/adapters/<name>/` implementing `SimulatorAdapter`
   (`web/common/src/adapter-types.ts`) against the library's actual API, plus
   a two-line `worker.ts` calling `hostAdapter(new XAdapter())`.
4. If the new adapter id needs to be selectable in the UI, add it to the
   `AdapterId` union and `createWorker()` switch in
   `web/shell/src/adapter-registry.ts`, and the `<select>` in
   `web/shell/index.html`.

Nothing in `src/main.cpp` needs to change — the bridge is adapter-agnostic
(`/bridge/:adapter/:method` takes the adapter id as a URL segment, not a
compiled-in list).

## Testing the native<->JS bridge

You generally cannot debug this by reading code alone — the two real bugs
found while building it (webview's `bind()` `req` format being the raw
params array, not the `{id,method,params}` envelope; and the stray-`.js`
class-field crash above) were only found by actually running calls and
tracing. When something in the bridge doesn't reply:

- Run headless (`physicalsim --headless`), it prints the bound port.
- `curl -X POST http://127.0.0.1:<port>/bridge/<adapter>/<method>` with a
  JSON body — a hang past ~5s means `dispatch_bridge_call()` timed out.
- If you need to see what's actually happening in the real webview window
  (not a plain browser tab — `window.physicalsimReply` only exists inside
  the actual webview), temporarily add a `server.Post("/debug/...")` route
  that has the page `fetch()` its own diagnostics back to a temp endpoint —
  this bypasses `bind()`/`eval()` entirely and is more reliable than
  guessing. Remove it before committing.
- A plain browser tab pointed at the same port is useful for isolating
  "is this a JS bug" vs "is this a bridge bug" — `window.physicalsimBridge`
  should exist there too (it's registered unconditionally); only
  `window.physicalsimReply` is native-only.

## Conventions already established, don't relitigate

- No framework in `web/shell` — plain DOM/TS, deliberately, per the
  "minimalist" brief. Don't introduce React/Vue/etc. for this UI.
- Black-and-white visual design (`web/shell/src/style.css`), no color
  system to extend — this was an explicit user requirement, not a
  placeholder.
- No firmware loading right now — deliberately. `SimulatorAdapter.start()`/
  `step()` run each adapter's CPU against whatever's already in its (empty)
  flash/program memory. Don't reintroduce firmware loading (Intel HEX or
  otherwise) unless asked; the current focus is the control-flow
  architecture (C++ <-> JS <-> Worker <-> CPU), not simulation output.
- The native shell (webview + httplib + cpp-embedlib) is intentionally
  *not* Ultralight/CEF. Cross-platform JS-engine consistency is a known,
  explicitly deferred tradeoff — don't "fix" it unprompted.
- Don't build a droidcli integration here. This repo exposes the HTTP
  bridge; whatever calls it is out of scope.
