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

A real-time workspace for placing and powering board illustrations,
connected to the adapter/pin machinery above via the circuit model
(`web/shell/src/circuit.ts`) — `web/shell/index.html` +
`web/shell/src/main.ts`'s board-workspace section. Placing a board plugs
it into its `SimulatorAdapter`; Start/Stop powers it on/off for real (CPU
running + a visual power LED, not just one or the other).

**Layout.** `.app` is a full-viewport column: a `.topbar` (title), then
`.body` (a row: a fixed-width `.sidebar` holding the state/pins panels, and
`.workspace` filling the rest). `.workspace` is itself a tab bar
(`#board-tabs`) over one `.tab-pane` per tab — generic tabs (`tab1`/`tab2`/
`tab3`), not tied to a specific board. Tab 1 additionally holds the
"Simulator" panel (board picker + Start/Stop, now wired - see "Boards vs.
adapters: plugging in, then powering on" below; Step/Reset stay disabled)
pinned top-left via `align-self: flex-start` so it doesn't stretch to the
pane's full height and never overlaps the canvas next to it. Start/Stop's
icons (Phosphor Icons, MIT, `assets/icons/phosphor/{play,stop}.svg`) are
inlined directly into their button markup, not fetched - `fill="currentColor"`
on the SVG is what makes them follow `button:hover`'s color inversion, and
two small static icons don't need a fetch or a templating layer.

**Rendering: real DOM/SVG, not canvas.** Tabs 2/3 still use plain
`<canvas>` placeholders (backing store sized 1:1 against
`devicePixelRatio`, redrawn only on resize/tab-switch — see
`resizeCanvas()`/`drawPlaceholder()`), but tab 1's design surface
(`#canvas-tab1`) is a plain `<div>`, not a canvas — its id is a holdover
name, not a claim about its element type. Placed boards are real
`@wokwi/elements` custom elements (`<wokwi-arduino-uno>` etc.), each
wrapped in a `.board-item` div positioned with ordinary CSS `left`/`top`.
This replaced an earlier canvas-image approach (draw a static SVG, hand-roll
hit-testing) — see "Why real DOM/SVG, not canvas" below for why.

**Vendoring `@wokwi/elements`.** `simulators/wokwi-elements` is a git
submodule (`https://github.com/vecnode/wokwi-elements`, a fork of
`wokwi/wokwi-elements`, MIT, 0 commits ahead at the time it was added) —
consumed exactly like `simulators/{avr8js,rp2040js}`: aliased straight to
its raw `src/index.ts` in `web/shell/vite.config.ts`'s `resolve.alias`, no
build step, esbuild compiles the TS as part of the Vite bundle. This
wasn't optional — the package's `dist/` (what `npm install` from its
registry form or a git URL would normally use) is gitignored in the
upstream repo and only produced by a `build` script that itself shells out
to `husky install`, too fragile to depend on for a project dependency.
Two things this vendoring needed that avr8js/rp2040js didn't:
- **`experimentalDecorators: true`** alongside the existing
  `useDefineForClassFields: false` in `vite.config.ts`'s
  `esbuild.tsconfigRaw.compilerOptions` (and mirrored in
  `web/shell/tsconfig.json` for `tsc`'s own typecheck) — wokwi-elements'
  components are Lit classes using legacy TS decorators
  (`@customElement`/`@property`/`@query`).
- **A `lit` alias/path mapping** (`vite.config.ts`'s `resolve.alias`,
  `tsconfig.json`'s `paths`) redirecting the bare `"lit"` specifier (and
  every subpath, `"lit/decorators.js"` etc.) to `web/node_modules/lit`.
  `simulators/` sits outside `web/`'s npm workspace, so plain node
  resolution walking up from `simulators/wokwi-elements/src/*.ts` never
  reaches `web/node_modules` on its own — `lit` (a real, well-behaved npm
  dependency, unlike avr8js/rp2040js which vendor everything) needed an
  explicit bridge. Same fix, for the same reason, for the type-only
  `import type React from 'react'` in wokwi-elements' `react-types.ts`
  (JSX typing for React consumers this project never uses) — a
  `"react"` path pointing at `@types/react` satisfies `tsc` without
  pulling in an actual React runtime dependency (the import is erased
  entirely at build; `@types/react` is types-only).
- `import "@wokwi/elements"` in `main.ts` is a bare side-effect import —
  Lit's `@customElement(tag)` decorator calls `customElements.define()`
  when each class is defined, i.e. on module evaluation, so importing the
  whole library registers every `<wokwi-*>` element. Pulls in more than
  just Arduino Uno for now (visible in the production bundle size); worth
  narrowing once more boards are wired up and the cost is worth avoiding.

**Selection and drag.** Plain DOM/CSS, no coordinate math needed at all —
a genuine simplification over the canvas approach it replaced, which had to
convert every pointer event through `devicePixelRatio`. `mousedown` on a
`.board-item` wrapper calls `stopPropagation()` (so the container's own
`mousedown` handler doesn't treat it as a background click), toggles
`.selected` (CSS `outline: 2px dashed`, replacing what used to be a
canvas-drawn dashed `strokeRect`), and records a drag offset in
container-relative CSS pixels; `mousemove`/`mouseup` are attached to
`window` (not the wrapper), so a fast drag that briefly leaves the
element doesn't get stuck — same reasoning as the pin-panel Button rows'
`mouseleave` handling elsewhere in `main.ts`. `makeDraggable()` returns a
dispose function so `showBoard()` can clean up a placed item's listeners
before replacing it, rather than leaking a new `window` listener pair
every time Apply is clicked. It also takes the placed `CircuitBoard`
directly and writes `x`/`y` back onto it on every `mousemove` — the model
(next section) is updated right alongside the DOM style that renders it,
not derived from the DOM after the fact.

**The circuit model — `web/shell/src/circuit.ts`.** A small, deliberately
plain-data model, kept separate from the DOM it's rendered as:

```ts
interface CircuitBoard {
  id: string;
  type: string;        // "arduino-uno" - key into the registries below
  adapterId: AdapterId; // which SimulatorAdapter this board type is backed by
  x: number;
  y: number;
  powered: boolean;
}
interface Circuit {
  boards: CircuitBoard[];
}
```

`main.ts` holds `circuit: Circuit` (the JSON-serializable source of truth
— `JSON.stringify(circuit)` never needs to filter anything out, since no
DOM reference lives inside it) alongside a separate
`circuitDom: Map<string, { wrapper, boardEl }>` for the id-keyed DOM
lookup. One board at a time for now (`showBoard()` replaces both on every
Apply, same as before); more boards is additively growing these, not
restructuring them. Three small per-type registries drive everything
board-specific: `boardTagName` (custom element tag, unchanged from
before, just moved here), `boardAdapterId` (which `SimulatorAdapter`
backs a board type — `"arduino-uno" -> "avr8"`, the piece that answers
"what adapter does this board use"), and `boardPowerSetter` (how to
reflect powered on/off onto a placed element — board-specific since not
every future board will expose the same property, or any at all).
`createBoard(type)` is the factory: resolves `boardAdapterId`, assigns a
simple incrementing id (`` `board-${n}` `` - no need for
`crypto.randomUUID()` at one-board scale), returns `null` for an unknown
type.

**Boards vs. adapters: plugging in, then powering on.** `avr8`/`rp2040`/
`cortex-m` are still parked out of the `#adapter-select` dropdown
(`index.html`) — not removed from the codebase; `adapter-registry.ts`,
`worker-rpc.ts`, and both adapter packages are untouched, just unreachable
from the UI while board work is the focus. But `showBoard()` now calls
`apply(board.adapterId)` right after placing a board — this *is* "plugging
the board into the adapter": `apply()` already did everything that means
(`main.ts`'s `activeAdapterId`/`getAdapterClient()`/state-subscription/
`refreshPinPanel()`), it just never used to be reachable, since nothing
tied a placed *board* to an *adapter id* before `boardAdapterId` existed.
The sidebar's state readout and pins panel start working the moment a
board is placed — no new UI, the existing machinery just gets a real
adapter id to point at.

Start/Stop are no longer just adapter lifecycle controls — they're
"power the circuit": `setPowered(on)` finds whichever placed board is
backed by the active adapter (`circuit.boards.find(b => b.adapterId ===
activeAdapterId)` — today, at most one board can ever match), sets its
`.powered` flag, and calls `boardPowerSetter[board.type]` to reflect it on
the real element — for Arduino Uno, `ArduinoUnoElement.ledPower` (the
board's power-supply LED, labeled "ON" on the silkscreen; verified by
checking the rendered shadow DOM directly — a `<circle fill="#80ff80">`
glow element appears/disappears exactly with `ledPower`). This is
deliberately *not* the same as `led13`/`ledTX`/`ledRX` (those track real
GPIO pin state, and aren't wired up yet — see "Not yet wired: per-pin
LEDs" below): `ledPower` represents whether the board has power at all,
independent of what any pin is doing. Both handlers still call
`activeClient()?.call("start"|"stop")` first, so the real `avr8` CPU
actually starts/stops too, not just the visual — verified together: state
readout shows `running`, `ledPower` is `true`, and the glow circle exists
in the shadow DOM, all three in lockstep. Step/Reset stay `disabled` in
`index.html` - deliberately out of scope for "power the circuit", not a
limitation of the model.

**Not yet wired: per-pin LEDs.** `led13`/`ledTX`/`ledRX` on
`ArduinoUnoElement` would make the board's own onboard LEDs reflect real
GPIO activity (pin B5/TX/RX) the same way the sidebar pins panel's `Led`
rows already do — a natural, cheap-looking follow-up once needed, not
conflated with the power-on/off work above.

**Board elements: real size, not scaled to fit.** `showBoard(name)`
creates the wrapper + custom element, then **awaits `updateComplete`**
before measuring and centering it — LitElement's first render happens on
a microtask after `connectedCallback`, not synchronously on `appendChild`,
so measuring immediately would see an empty (zero-size) shadow DOM and
center against the wrong size (caught during verification: centering was
silently wrong until this await was added). Once rendered, the element's
SVG intrinsic size (`width="72.58mm"` etc., browser-computed) is used
as-is — never scaled up or down to fit the container. Repeated `Apply`
clicks replace the scene rather than stacking duplicate boards.

**Supported boards.** One today. Tracked here as more are added:

| Board | Custom element | Adapter | Powered by Start/Stop? |
|---|---|---|---|
| Arduino Uno | `wokwi-arduino-uno` | `avr8` | Yes |

**Licensing note.** [velxio](https://github.com/davidmonterocrespo24/velxio)
(a similar from-scratch Wokwi-style simulator, referenced early on for how
a full project structures itself around `@wokwi/elements`) is **AGPLv3 +
a separate commercial license** — nothing from that repo was or should be
copied into physicalsim; it was consulted for architecture ideas only.
`wokwi-elements` itself, and this project's fork of it, are MIT.

**Why real DOM/SVG, not canvas.** The project's first board render (since
superseded) was a static SVG extracted from `wokwi-elements` by hand and
drawn as a flat image on `<canvas>`, with selection/drag hand-rolled as
canvas hit-testing — a reasonable starting point, but it meant every future
interaction (per-pin click, wiring) would need its own hand-rolled
hit-region math. Switching to the real components trades a canvas-specific
dependency-free property for the DOM's native event model — clicks land on
the actual element under the pointer, no coordinate math required, and it's
what Wokwi's own app is built on. **Honest limitation carried over, not
solved by this switch:** `<wokwi-arduino-uno>` does not give per-pin click
events for free — its pin headers render as a few grouped
`<rect fill="url(#pins-female)">` strips, not one interactive element per
pin. `ElementPin`/`pinInfo` (exported by `@wokwi/elements`, per-pin
`{name, x, y, signals}` coordinates) is positional data for Wokwi's own
external wiring tool, not baked-in interactivity. Real per-pin clicking is
still a real follow-up: overlay small positioned marker elements using
those coordinates, now trivial DOM/CSS positioning instead of canvas math,
wired to the `CircuitPin` read/write that already exists.

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
