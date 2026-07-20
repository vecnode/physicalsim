# Architecture

physicalsim has two layers with a hard boundary between them: a native C++
shell that owns the window and the HTTP server, and a JS/TS layer that owns
every simulator. The native layer never simulates anything itself — it hosts
the browser engine the simulators run inside of, and exposes what happens
there over HTTP.

```
┌─────────────────────────────── native shell (src/main.cpp) ───────────────────────────────┐
│                                                                                              │
│   httplib::Server ── serves embedded public/ (Vite build output)                            │
│        │                                                                                     │
│        ├── GET  /health, /api/hello                                                          │
│        └── POST /bridge/:adapter/:method, GET /bridge/:adapter/state  (native<->JS bridge)   │
│                                                                                              │
│   webview::webview  ── embedded browser engine (WebView2 / WebKitGTK), hidden if --headless  │
│        │  bind("physicalsimReply", ...)   JS -> C++ replies/events                          │
│        └  eval("window.physicalsimBridge.dispatch(...)")   C++ -> JS commands               │
└──────────────────────────────────────────┬───────────────────────────────────────────────────┘
                                             │ same page, same origin
┌────────────────────────────────────────────▼──────────────────────────── web/shell ─────────┐
│  index.html + main.ts (control UI)        native-bridge.ts (native<->JS bridge, JS side)     │
│         │                                          │                                          │
│         └──────────────────┬───────────────────────┘                                          │
│                    adapter-registry.ts                                                        │
│                (one AdapterClient per adapter id, shared by UI and bridge)                    │
│                             │ postMessage RPC (worker-rpc.ts / worker-host.ts)                │
│              ┌──────────────┴───────────────┐                                                 │
│      Worker: adapters/rp2040/worker.ts   Worker: adapters/avr8/worker.ts                      │
│              │ wraps                        │ wraps                                           │
│      simulators/rp2040js (submodule)     simulators/avr8js (submodule)                        │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

Not shown above: a third adapter kind, `cortex-m`, has no JS/TS side at
all — see "Two adapter kinds" below.

## Why it's split this way

The native shell ([webview](https://github.com/webview/webview) +
[cpp-httplib](https://github.com/yhirose/cpp-httplib) +
[cpp-embedlib](https://github.com/yhirose/cpp-embedlib)) is a thin,
deliberately dumb host: open a window (or don't), serve some embedded static
files, get out of the way. It doesn't know what a simulator is. Every actual
simulator — rp2040, avr8, and whatever gets added later — is a JS/TS library
running inside the webview's browser engine, because that's the only runtime
both simulator projects (rp2040js, avr8js) actually target, and because it
lets the exact same build serve identically to a plain browser tab pointed at
`localhost:<port>` or to the native window. See [README.md](README.md) for
the reasoning behind keeping the native shell as-is instead of moving to
Ultralight/CEF — this is an intentionally deferred tradeoff, not an
oversight.

## The three JS/TS layers

**`web/common`** — the contract everything else is built against
(`web/common/src/adapter-types.ts`):

```ts
interface SimulatorAdapter {
  readonly id: string;
  init(config: unknown): Promise<void>;
  start(): void;
  stop(): void;
  step(n: number): void;
  reset(): void;
  onStateChange(cb: (state: SimState) => void): () => void;
}
```

No firmware loading yet — deliberately. Right now `start`/`step` just runs
each adapter's CPU against whatever's already in its (empty) flash/program
memory; this stage is about the control-flow architecture working end to
end (C++ <-> JS <-> Worker <-> CPU), not real simulation output. Loading
(and exporting) firmware is a later addition to `SimulatorAdapter`.

Also home to `worker-host.ts` (`hostAdapter()`, wires any `SimulatorAdapter`
to the postMessage RPC protocol — every adapter's `worker.ts` is a two-line
file that just calls this).

**`web/adapters/{rp2040,avr8}`** — one package per simulator. Each
`adapter.ts` implements `SimulatorAdapter` against its library; each
`worker.ts` is the Worker entry point (`hostAdapter(new XAdapter())`). The
libraries themselves aren't npm dependencies — `rp2040js`/`avr8js` are
resolved via a Vite/tsconfig alias straight to
`simulators/<name>/src/index.ts` in the git submodule (see
`web/shell/vite.config.ts`). Adding a third simulator means: add a
submodule, add its alias, add an adapter package. Nothing else changes.

**`web/shell`** — the only page that actually gets served. Three files do
the coordinating:

- `adapter-registry.ts` — one `AdapterClient` (Worker + RPC client) per
  adapter id, created lazily and never torn down. This is the shared state:
  the UI and the native bridge both call `getAdapterClient(id)` and get the
  *same* running instance, so driving an adapter from one side is visible
  from the other.
- `main.ts` — the black/white control UI (adapter picker,
  start/stop/step/reset, live state readout).
- `native-bridge.ts` + `native-notify.ts` — the JS half of the native<->JS
  bridge (next section). Imported into `main.ts` for its side effect
  (registers `window.physicalsimBridge`); harmless in a plain browser tab,
  where `window.physicalsimReply` simply doesn't exist and calls no-op.

Each running adapter is isolated in its own Web Worker so one misbehaving
simulator can't freeze the shell UI, and communicates over a small
JSON-RPC-shaped `postMessage` protocol (`{id, method, params}` in,
`{id, result|error}` or an unsolicited `{event: "stateChange", state}` out —
see `web/common/src/adapter-types.ts`).

## The native <-> JS bridge

This exists so an external caller (droidcli) can drive a simulator by
talking to the C++ process over HTTP, without going through the browser UI
at all. droidcli -> C++ -> JS/TS is the whole point; the UI is one client of
the adapters, not a required intermediary.

Protocol, concretely:

1. `POST /bridge/rp2040/start` arrives on an httplib worker thread
   (`src/main.cpp`).
2. `dispatch_bridge_call()` registers a pending request under a fresh id,
   then calls `w.dispatch([&]{ w.eval(js); })` — `dispatch()` is the only
   webview call that's safe to invoke off the UI thread; it posts the
   `eval()` onto the UI thread's queue.
3. On the UI thread, `eval()` runs
   `window.physicalsimBridge.dispatch({id, adapter, method, params})` in the
   page. `native-bridge.ts` looks up the adapter via the shared registry,
   calls the matching `SimulatorAdapter` method, and reports the outcome
   back through `window.physicalsimReply(...)` — a webview `bind()`
   (`install_bridge()` in `main.cpp`), called once before `w.navigate()` so
   it's available from the very first page load.
4. The `physicalsimReply` C++ callback parses the JSON, matches it to the
   pending request by id, and notifies a condition variable.
5. Back on the httplib thread, `dispatch_bridge_call()` was blocked on that
   condition variable (5s timeout) and returns the result as the HTTP
   response.

`stateChange` events use the same `physicalsimReply` channel but
unsolicited (no pending request to match) — they update
`g_bridge_latest_state[adapter]`, which `GET /bridge/:adapter/state` reads.

**Why `--headless` still creates a webview window.** The adapters only run
inside the webview's embedded browser engine — there's nowhere else for
them to execute. `--headless` therefore still constructs and navigates a
real `webview::webview`, still calls `w.run()` (the message loop has to
pump for the browser engine to do anything), and just hides the window
(`ShowWindow(SW_HIDE)` / `gtk_widget_hide`) instead of skipping it. Shutdown
is a small dedicated thread that waits on `SIGINT`/`SIGTERM` and calls
`w.dispatch([&]{ w.terminate(); })` to stop `run()` from a safe thread.

**Why state-change forwarding is throttled.** A running adapter emits a
`stateChange` roughly every tick (every `STEPS_PER_TICK` cycles, effectively
continuously). Forwarding every single one to native means every one
round-trips through `eval()`/`bind()` on the UI thread — enough traffic to
starve a freshly-dispatched command long enough to hit the 5s timeout.
`adapter-registry.ts` throttles the *native* forwarding to 5/s per adapter;
the UI's own `onStateChange` subscribers still get every event, since only
the native round trip is expensive. See the README's "Known limitation" for
what this doesn't yet cover (multiple adapters running simultaneously under
heavy concurrent bridge traffic).

## Two adapter kinds: Worker-backed and native-backed

`avr8`/`rp2040` are **Worker-backed**: pure JS/TS running in a Web Worker,
reached by the UI via `postMessage` and by external callers via the bridge
above. `cortex-m` is **native-backed**: no JS/TS library exists for ARM
Cortex-M the way `avr8js`/`rp2040js` exist for AVR8/RP2040 (confirmed by
research — the real, mature option for that architecture is QEMU, a
native process, not a browser library), so `src/qemu_adapter.{hpp,cpp}`
spawns and controls a real `qemu-system-arm` process directly from C++.
There is nothing running in JS for this adapter at all — it's reached
*only* through the same `/bridge/:adapter/:method` HTTP surface external
callers already use, including by the shell UI itself
(`web/shell/src/native-adapter-client.ts`, a `fetch()`-based client
structurally matching the Worker-backed `AdapterClient` so
`adapter-registry.ts`'s `getAdapterClient()` can hand either one back to
`main.ts` without it needing to know which kind it got — see the
`SimClient` interface in `adapter-registry.ts`).

Concretely, for `cortex-m`:

- `POST /bridge/:adapter/:method` branches in `src/main.cpp`: `cortex-m`
  routes to `handle_qemu_bridge_call()` instead of `dispatch_bridge_call()`
  (the JS-eval path), but both write into the same
  `g_bridge_latest_state` map, so `GET /bridge/:adapter/state` needs no
  adapter-kind-specific code at all.
- `start`/`stop`/`reset` go over **QMP** (QEMU Machine Protocol,
  JSON-over-TCP) — `cont`/`stop`/`system_reset`.
- `step` goes over a **minimal GDB Remote Serial Protocol client**
  (`$packet#checksum` framing, just enough for `s` single-step and `g`
  register read) — QMP has no clean single-instruction-step command,
  that's what the GDB stub exists for.
- Because register reads require the target halted, `state()` while
  `running` reports the last known PC/cycles *frozen* rather than live —
  documented in `qemu_adapter.hpp`, not a bug. Polling from the UI
  (`native-adapter-client.ts`, 200ms interval) reflects this honestly:
  cycles/PC only move again once something actually stops/steps the CPU.
- `cycles` in `state()` is not a real cycle count — QEMU doesn't expose
  one over QMP/GDB for this target — it's the number of `step()` calls
  issued, which is what it actually is, not silently relabeled.

**Why a real vector table stub is baked in.** Unlike `avr8js`/`rp2040js`'s
simplified CPU models (which happily execute whatever's in empty
flash/bootrom as inert instructions), real ARM Cortex-M silicon requires
a valid vector table at address 0 to boot at all — word 0 is the initial
SP, word 1 is the initial PC. Left at all-zero, the CPU immediately
double-faults trying to execute from (and then handle a fault from)
address 0, and QEMU exits with `qemu: fatal: Lockup: can't escalate 3 to
HardFault`. `minimal_vector_table_stub()` in `qemu_adapter.cpp` writes a
10-byte image (SP + PC + one `b .` Thumb instruction, an infinite
self-branch) to a temp file and loads it via `-kernel` — not firmware,
just enough for the CPU to boot into a real, inert, steppable state,
matching the other adapters' "runs, executes nothing meaningful yet"
posture until real firmware loading exists for this adapter too.

**Process lifecycle.** `-nographic` redirects QEMU's "display" to
stdio/console — spawned with no console and no inherited handles (as a
GUI-subsystem app would naturally want), it has nowhere valid to
redirect to and exits almost immediately (this looked like a working
spawn during development — the QMP handshake and one GDB register read
completed in the brief window before the process was gone). Fixed by
redirecting QEMU's stdout/stderr to a log file via `STARTUPINFOA`. On
Windows, the child is also assigned to a Job Object with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` — this, not the `Impl` destructor,
is what actually guarantees `qemu-system-arm` doesn't outlive
physicalsim: destructors only run on the normal-exit path, but Windows
closes every handle a process owns when it terminates for *any* reason
(crash, or an external `taskkill /F`), and closing the job's last handle
kills every process assigned to it.

**Distribution: bundled vs. system QEMU.** `find_qemu_system_arm()`
checks three places in order: a `qemu/` folder next to physicalsim's own
executable, then PATH, then well-known system install locations. The
first one exists specifically so packaged builds don't require QEMU
installed on the machine they run on — `CMakeLists.txt`'s
`BUNDLE_QEMU_ARM` option (mirroring the pre-existing
`BUNDLE_WEBVIEW2_FIXED_RUNTIME` pattern) copies `qemu-system-arm.exe` +
its DLLs into the build output at package time, from wherever it's
installed on the *build* machine — nothing is committed to git, same as
the WebView2 runtime. `package_release.bat` auto-detects a local install
and enables this automatically; it's a warning, not a build failure,
when QEMU isn't found there, since `avr8`/`rp2040` don't need it.
Verified directly during development: with both a bundled and a system
copy present, `Get-Process qemu-system-arm | Select Path` resolved to
the bundled one.

The DLL set (114 files, ~140 MB) was determined with `dumpbin
/dependents` rather than guessed — `qemu-system-arm.exe` implicitly
(not lazily) links GTK/SDL/etc. even though `-nographic` never uses
them, so the whole top-level DLL set has to travel with it. QEMU's
`share/` directory (~355 MB of BIOS/UEFI blobs for *other*
architectures) is not bundled — confirmed unnecessary by actually
booting `netduinoplus2` with no `-bios` flag.

## Build pipeline

`public/` is never authored by hand — it's Vite's build output
(`web/shell/vite.config.ts` sets `build.outDir` to `../../public`,
`emptyOutDir: true`), embedded into the binary by `cpp-embedlib`
(`cpp_embedlib_add(WebAssets FOLDER public ...)` in `CMakeLists.txt`). Build
order is always: `npm install && npm run build` in `web/` first, then
`cmake -B build && cmake --build build`. All four build scripts
(`build_and_run.bat`, `package_release.bat`) do this automatically.

One non-obvious wrinkle worth knowing before touching `web/shell/vite.config.ts`:
both simulator submodules need `useDefineForClassFields: false` — several of
their classes assign fields that read sibling fields in the same constructor
pass, which is safe under legacy (assignment) class-field semantics but a
genuine use-before-init crash under native (spec) class fields, which is
what esbuild uses by default at Vite's target. This is set explicitly via
`esbuild.tsconfigRaw` in `vite.config.ts` rather than relying on each
submodule's own `tsconfig.json`, because Vite resolves TS options once for
the whole bundle rather than per vendored file. See the README's
"Dependencies" notes for the related stray-build-artifact hazard in the
submodules.
