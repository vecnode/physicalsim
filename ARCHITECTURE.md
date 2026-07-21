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
  // Optional: not every adapter kind supports pin I/O (see "Pin I/O
  // pipeline" below for why cortex-m doesn't, today).
  readPin?(pin: string): number | undefined;
  writePin?(pin: string, value: number): void;
  onPinChange?(pin: string, cb: (value: number) => void): () => void;
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

## Pin I/O pipeline

Layered on top of the lifecycle contract above so per-pin read/write/change
reaches every adapter kind through the exact same bridge that already
carries `start`/`stop`/`step`/`reset` — no adapter-kind-specific code
anywhere above the adapter implementations themselves.

**The RPC surface.** Three additions to `web/common/src/adapter-types.ts`
and `worker-host.ts`:

- `readPin`/`writePin` — regular request/response `AdapterMethod`s, exactly
  like `step`. Optional on `SimulatorAdapter` (`readPin?`/`writePin?`) since
  not every adapter kind supports them yet.
- `subscribePin` — a request that tells the worker to start forwarding one
  pin's changes as `pinChange` events. Idempotent per pin (a `Map` of
  live unsubscribe functions in `worker-host.ts` keyed by pin id) — calling
  it twice for the same pin is a no-op the second time, so callers don't
  need to track subscription state themselves.
- `{ event: "pinChange", pin, value }` — a new member of the `RpcEvent`
  union alongside `stateChange`, pushed unsolicited once a pin has been
  subscribed.

On the browser side, `AdapterClient` (`web/shell/src/worker-rpc.ts`) routes
`pinChange` messages to a second listener set (`onPinChange`), parallel to
`onStateChange`. `NativeAdapterClient` deliberately does **not** implement
`onPinChange` — see "Why cortex-m has no real pin I/O" below.

**Per-adapter pin semantics.** Both Worker-backed adapters converge on the
same shape (`readPin`/`writePin` return/take a single `0`/`1`; `onPinChange`
fires on any change, whether firmware-driven or externally injected) despite
their underlying libraries modeling pins very differently:

- **avr8** (`web/adapters/avr8/src/adapter.ts`) — pin ids are
  `"<port letter><bit>"` (e.g. `"B5"`, the Uno's onboard LED).
  `readPin`/`writePin` read/write avr8js's `AVRIOPort` directly (`setPin()`
  for external stimulus, `cpu.data[PIN register]` for the actual electrical
  read, which correctly reflects either direction). Firmware-driven changes
  are caught via `AVRIOPort.addListener` (fires on `PORT`/`DDR` writes);
  `writePin`-driven changes bypass that listener entirely (`setPin()` never
  calls avr8js's internal `writeGpio()`), so `writePin` fires the
  notification itself. A per-pin `lastPinValues` map dedupes both paths so
  subscribers only see actual transitions.
- **rp2040** (`web/adapters/rp2040/src/adapter.ts`) — pin ids are `"GP<n>"`.
  Same two-path shape (`GPIOPin.addListener` for firmware/SIO-driven
  changes, manual notification for `writePin`), but rp2040js's `GPIOPin`
  needed one extra accommodation: its `value`/`inputValue` getters gate on
  `padValue`'s input-enable bit, which real firmware sets via `gpio_init()`
  before a pin reads as anything but disabled. Since `writePin` models an
  external wire being attached (not firmware configuring its own pad),
  it force-enables that bit rather than requiring a `gpio_init()` firmware
  call that doesn't exist yet.

**Why cortex-m has no real pin I/O.** `handle_qemu_bridge_call()` in
`src/main.cpp` routes `readPin`/`writePin` to `QemuInstance::read_pin()` /
`write_pin()` (`src/qemu_adapter.{hpp,cpp}`), which unconditionally throw —
the bridge surface is uniform (the shell never special-cases `cortex-m`),
but nothing behind it works yet. Real GPIO access would mean reading/writing
the STM32's IDR/ODR registers over QMP or the existing GDB RSP connection
against the `netduinoplus2` machine — unscoped, unverified, and explicitly
left as a future spike rather than guessed at.

**The circuit layer.** `web/common/src/circuit/` is a small,
adapter-agnostic layer built entirely on the client surface above, not on
any adapter internals directly:

- `CircuitPin` wraps one pin id behind `read()`/`write()`/`onChange()`,
  talking only to a `PinClient` (the minimal `call()`/`onPinChange()` shape
  — deliberately not imported from `web/shell`, so `web/common` has no
  dependency on it; `AdapterClient`/`NativeAdapterClient` satisfy it
  structurally). `onChange()` throws for a client that doesn't implement
  `onPinChange` (i.e. `NativeAdapterClient` today) rather than silently
  never firing.
- `Led`/`Button` (`web/common/src/circuit/components/`) are the first two
  components: `Led` is read-only (tracks a pin via `onChange`, plus one
  `read()` on construction so it reflects reality immediately rather than
  only after the next toggle); `Button` is write-only (`press()`/
  `release()` drive the pin to 1/0).
- `Circuit` is currently just a typed container (`addComponent()`) —
  intentionally thin until the UI needs more from it.
- `web/common/src/boards/` maps a board's silkscreen pin names (`"D13"`,
  `"LED"`) to the adapter's raw pin id (`"B5"`, `"GP25"`) —
  `arduino-uno.ts` for avr8, `rp2040-board.ts` for rp2040.
  `CircuitPin.forBoardPin(client, board, name)` is the convenience
  entry point that resolves through one of these before constructing.

## The board canvas

A real-time workspace for placing and wiring board illustrations, separate
from (and currently unconnected to) the adapter/pin machinery above —
`web/shell/index.html` + `web/shell/src/main.ts`'s board-workspace section.
This is the backend the UI needs as boards go from "a picture" to "a picture
you can actually wire up to a running adapter," so it's worth understanding
even though today it only draws and moves a static image.

**Layout.** `.app` is a full-viewport column: a `.topbar` (title), then
`.body` (a row: a fixed-width `.sidebar` holding the state/pins panels, and
`.workspace` filling the rest). `.workspace` is itself a tab bar
(`#board-tabs`) over one `.tab-pane` per tab — generic tabs (`tab1`/`tab2`/
`tab3`), not tied to a specific board. Tab 1 additionally holds the
"Simulator" panel (board picker + the now-disabled Start/Stop/Step/Reset —
see "Boards vs. adapters" below) pinned top-left via `align-self: flex-start`
so it doesn't stretch to the pane's full height and never overlaps the
canvas next to it.

**Rendering: plain 2D canvas, not DOM/SVG.** Each tab owns one `<canvas>`,
backing store sized 1:1 against `devicePixelRatio` and redrawn only on
resize/tab-switch/scene-change — no per-frame render loop, since nothing
animates on its own yet. Tab 1's canvas (`.board-canvas-interactive`) is the
only one with a scene: a plain array of placed items
(`SceneItem { name, x, y, width, height }`, all in canvas backing-store
pixel space) redrawn by `redrawTab1()`. Tabs 2/3 stay blank, unbordered
placeholders. This is a deliberate choice, not a placeholder-for-later: see
"Why canvas, not the real wokwi-elements components" below for the tradeoff
it's making.

**Selection and drag.** Hit-testing is a plain top-to-bottom rect scan over
`tab1Scene` (fine at this scale — one board today) converting pointer
`clientX/Y` into the same canvas-pixel space via `getBoundingClientRect()` +
`devicePixelRatio`. `mousedown` selects (and starts a drag, recording the
pointer's offset from the item's origin) or deselects (click on empty
canvas); `mousemove` updates the selected item's `x`/`y` and redraws;
`mouseup` is listened for on `window`, not the canvas, so a fast drag that
briefly leaves canvas bounds doesn't get stuck. Selected items get a dashed
black stroke around their bounding box — the "border when selected" is
drawn fresh every redraw, not a persistent DOM overlay.

**Board images: real size, not scaled to fit.** `showBoard(name)` loads the
image once (cached in `loadedBoardImages`), then places it at
`img.naturalWidth * devicePixelRatio` × `img.naturalHeight * devicePixelRatio`
— true size, never shrunk or stretched to fit the canvas. Repeated `Apply`
clicks replace the scene rather than stacking duplicate boards.

**Boards vs. adapters.** `avr8`/`rp2040`/`cortex-m` are parked out of the
`#adapter-select` dropdown (`index.html`) — not removed from the codebase;
`adapter-registry.ts`, `worker-rpc.ts`, and both adapter packages are
untouched, just unreachable from the UI for now while board work is the
focus. Start/Stop/Step/Reset are `disabled` in the HTML rather than quietly
doing nothing, since `activeAdapterId` starts (and, until a board picks up
an adapter, stays) `null` — see the comments in `main.ts` around
`activeClient()`. Selecting "Arduino Uno" and clicking Apply calls
`showBoard()` directly; it never reaches `apply()`/`getAdapterClient()` at
all, because there's no adapter to reach yet. Reconnecting a board to its
real MCU (Arduino Uno's is literally the same ATmega328p `avr8` already
emulates) is the next real step, not a rewrite — `CircuitPin`/`Led`/`Button`
and the board pin-name maps (`web/common/src/boards/arduino-uno.ts`) already
exist for exactly this from the "Pin I/O pipeline" work above.

**Supported boards.** One today. Tracked here as more are added — an entry
means a board image exists in `assets/boards/`, not that it's wired to a
running adapter yet:

| Board | Image asset | Wired to an adapter? |
|---|---|---|
| Arduino Uno | `arduino-uno.svg` | No — visual only (see above) |

**Board image assets.** `assets/boards/<name>.svg` is the canonical,
version-controlled copy; `web/shell/public/boards/<name>.svg` is a byte-identical
copy in Vite's static-asset source directory (`publicDir`, defaulting to
`<project>/public` — *not* the same `public/` as the repo-root build output;
see the `.gitignore` comment next to `/public/` for why that distinction is
now anchored explicitly). Vite copies it verbatim into the build output at
`npm run build` time, and `cpp-embedlib` embeds it into the binary the same
way it embeds `index.html`/the JS bundles — confirmed by a real headless run
serving `GET /boards/arduino-uno.svg` back correctly. Nothing is fetched
from wokwi.com or any CDN at runtime; distribution has to work offline, same
as the WebView2 runtime and bundled QEMU.

**Where `arduino-uno.svg` came from, and the license constraint that
matters for the next board.** Extracted from
[wokwi-elements](https://github.com/wokwi/wokwi-elements)'s
`arduino-uno-element.ts` (MIT licensed) — that project renders boards as
Lit web components with real SVG DOM per pin/LED/button, which is *why*
Wokwi's own boards are natively clickable per-element and this one currently
isn't (see below). The extraction kept only the static SVG markup (default
state: every LED off) and dropped the Lit-specific bindings (event
handlers, `tabindex`, conditional glow states) and computed template
expressions (inlined to literal numbers) — it's a plain static asset now,
not a component. [velxio](https://github.com/davidmonterocrespo24/velxio)
(a similar from-scratch Wokwi-style simulator, referenced during this work
for how a full project structures itself around `@wokwi/elements`) is
**AGPLv3 + a separate commercial license** — nothing from that repo should
be copied into physicalsim; it was consulted for architecture ideas only,
not code.

**Why canvas, not the real wokwi-elements components.** Two real options
for board rendering exist: (a) use `@wokwi/elements` directly as DOM/SVG —
every pin, LED, and button is already a real interactive element with its
own event handlers, which is how Wokwi gets per-pin clicks "for free" — or
(b) stay on plain `<canvas>`, as today, and hand-roll hit-testing. (a) means
taking on a real runtime dependency (Lit) and moving board rendering out of
the performance-first, dependency-free canvas model the rest of this
workspace is built on; (b) means porting *data* (not code — plain pin-name
→ x/y coordinates, e.g. `arduino-uno-element.ts`'s `pinInfo` array) into
this project's own board asset format, and extending the same hit-test
pattern `tab1Scene` already uses for whole-board selection down to
per-pin circles. (b) is the direction this project is headed in, to keep
the "no framework, fast canvas" property intact as more boards and
interactions (per-pin click, wiring between pins) get added — not yet
implemented, tracked as the natural next step once a board needs it.

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
