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
compiled-in list) — **unless** the target architecture has no JS/TS
library (ARM Cortex-M, MSP430, ESP32 Xtensa all currently don't). In that
case it's a native-backed adapter instead — see `cortex-m` in
`src/qemu_adapter.{hpp,cpp}` as the reference pattern: spawn a real
process from C++, add a branch for its id in the `POST
/bridge/:adapter/:method` handler in `src/main.cpp` routing to a C++
handler instead of `dispatch_bridge_call()`, write into the same
`g_bridge_latest_state` map so `GET /bridge/:adapter/state` needs no
change, and give it a `NativeAdapterClient`-style entry (fetch + poll, see
`web/shell/src/native-adapter-client.ts`) in `adapter-registry.ts`'s
`NATIVE_ADAPTER_IDS` set instead of a Worker.

## Working with the QEMU-backed (`cortex-m`) adapter

- **A real vector table is required to boot at all.** Real ARM Cortex-M
  silicon reads SP/PC from address 0 on reset — leave flash empty (as
  the JS adapters can get away with) and QEMU immediately exits with
  `qemu: fatal: Lockup: can't escalate 3 to HardFault`. `qemu_adapter.cpp`
  always loads a tiny built-in stub (`minimal_vector_table_stub()`) via
  `-kernel`, not user firmware — don't remove this thinking it's
  optional scaffolding.
- **`-nographic` needs somewhere valid to redirect to.** Spawning QEMU
  with no console and no inherited handles makes it exit almost
  immediately (it looked like a working spawn during development — the
  QMP handshake and one register read completed in the brief window
  before it was gone). stdout/stderr are redirected to a log file in the
  temp dir (`physicalsim-qemu-<pid>.log`) specifically so this doesn't
  regress silently — if you touch the spawn code, keep that redirection.
- **On Windows, process cleanup relies on a Job Object, not just the
  destructor.** `~Impl()` calling `kill_process()` only covers the
  normal-exit path. The Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
  is what actually guarantees `qemu-system-arm` doesn't get orphaned when
  physicalsim is force-killed or crashes — verified directly during
  development (`taskkill /F` on physicalsim without it left
  `qemu-system-arm.exe` running).
- **Don't add Docker.** Explicitly decided against for this adapter —
  spawn the native binary directly, no container.
- **Packaged builds bundle their own QEMU** (`BUNDLE_QEMU_ARM` in
  `CMakeLists.txt`, wired up in `package_release.bat`) — copied from
  wherever it's installed on the *build* machine into the output's
  `qemu/` folder, never committed to git, same mechanism as
  `BUNDLE_WEBVIEW2_FIXED_RUNTIME`. `find_qemu_system_arm()` in
  `qemu_adapter.cpp` checks that folder first, before PATH or system
  install locations. If you change what DLLs QEMU needs (e.g. after a
  QEMU version bump changes its dependency graph), re-run `dumpbin
  /dependents qemu-system-arm.exe` rather than guessing a minimal set —
  the DLLs are implicitly linked, not lazily loaded, so a missing one
  fails the whole process at load time, not at some specific feature
  path.
- **Debugging a stuck `start`/`step`/`reset` call**: check the QEMU log
  file in the OS temp dir first — most failures (missing binary, boot
  fault, port conflict) show up there, not as a C++ exception with a
  useful message. `find_qemu_system_arm()` returning `nullopt` (binary
  not found on PATH or in well-known install dirs) is the other common
  failure mode; the thrown error message says so explicitly.

## UI: dropdown selection requires clicking Apply

`web/shell/index.html`'s `<select id="adapter-select">` does not switch
what Start/Stop/Step/Reset act on by itself — `main.ts` only calls
`apply()` (which updates `activeAdapterId` and re-subscribes) when
`#apply-btn` is clicked. This was an explicit user requirement, not an
oversight — don't wire the `change` event back up to auto-apply.

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
