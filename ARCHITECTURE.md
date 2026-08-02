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
│        ├── POST /bridge/:adapter/:method, GET /bridge/:adapter/state  (native<->JS bridge)   │
│        └── POST /compile  (src/avr_toolchain.cpp - in-app sketch compiler, see below)        │
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
│         ┌──────────────────┼──────────────────────┐                                          │
│ Worker: adapters/rp2040/worker.ts   adapters/avr8/worker.ts   adapters/esp32/worker.ts         │
│         │ wraps                    │ wraps                    │ wraps                          │
│ simulators/rp2040js (submodule) simulators/avr8js (submodule) simulators/esp32js (submodule)   │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

Every registered adapter is Worker-backed JS/TS - there is no
native/process-backed adapter kind in this project (see "One adapter
kind: Worker-backed" below for what used to be there and why it's gone).

## Why it's split this way

The native shell ([webview](https://github.com/webview/webview) +
[cpp-httplib](https://github.com/yhirose/cpp-httplib) +
[cpp-embedlib](https://github.com/yhirose/cpp-embedlib)) is a thin,
deliberately dumb host: open a window (or don't), serve some embedded static
files, get out of the way. It doesn't know what a simulator is. Every actual
simulator - rp2040, avr8, esp32, and whatever gets added later - is a JS/TS
library running inside the webview's browser engine, because that's the
runtime every simulator project (rp2040js, avr8js, esp32js) actually
targets, and because it lets the exact same build serve identically to a
plain browser tab pointed at `localhost:<port>` or to the native window. See
[README.md](README.md) for the reasoning behind keeping the native shell
as-is instead of moving to Ultralight/CEF — this is an intentionally
deferred tradeoff, not an oversight.

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
  // Mandatory on every registered adapter today - see "Pin I/O pipeline"
  // below.
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

**`web/adapters/{rp2040,avr8,esp32}`** — one package per simulator. Each
`adapter.ts` implements `SimulatorAdapter` against its library; each
`worker.ts` is the Worker entry point (`hostAdapter(new XAdapter())`). The
libraries themselves aren't npm dependencies — `rp2040js`/`avr8js`/`esp32js`
are resolved via a Vite/tsconfig alias straight to
`simulators/<name>/src/index.ts` in the git submodule (see
`web/shell/vite.config.ts`). Adding another simulator means: add a
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

## One adapter kind: Worker-backed

Every registered adapter — `avr8`, `rp2040`, `esp32` — is **Worker-backed**:
pure JS/TS running in a Web Worker, reached by the UI via `postMessage` and
by external callers via the bridge above. There is no native/process-backed
adapter kind in this project: an earlier `cortex-m` adapter spawned a real
`qemu-system-arm` process from C++ (QMP for start/stop/reset, a minimal GDB
Remote Serial Protocol client for stepping), and ESP32 was originally built
the same way around a forked `qemu-system-xtensa` (`vecnode/qemu-esp32`).
Both were removed once `vecnode/esp32js` — a pure TypeScript Xtensa LX6
CPU+peripheral interpreter, the same shape `avr8js`/`rp2040js` already are
for their own architectures — made a native process unnecessary for ESP32,
and no board maps to `cortex-m` at all. `adapter-registry.ts`'s
`getAdapterClient()` now has exactly one code path: create (or reuse) a
Worker and wrap it in an `AdapterClient` (`worker-rpc.ts`), whose `SimClient`
shape `main.ts` drives without needing to know or care which chip's Worker
it's talking to.

## Pin I/O pipeline

Layered on top of the lifecycle contract above so per-pin read/write/change
reaches every adapter kind through the exact same bridge that already
carries `start`/`stop`/`step`/`reset` — no adapter-kind-specific code
anywhere above the adapter implementations themselves.

**The RPC surface.** Three additions to `web/common/src/adapter-types.ts`
and `worker-host.ts`:

- `readPin`/`writePin` — regular request/response `AdapterMethod`s, exactly
  like `step`. Optional on the `SimulatorAdapter` type (`readPin?`/
  `writePin?`), but every registered adapter implements them today.
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
`onStateChange`.

**Per-adapter pin semantics.** Every Worker-backed adapter converges on the
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
- **esp32** (`web/adapters/esp32/src/adapter.ts`) — pin ids are `"D<n>"`
  (GPIO numbers 0-39). Wraps `esp32js`'s `Board` class directly: `readPin`/
  `writePin` are thin passthroughs to `Board.getPin()`/`setPin()`. Unlike
  avr8js/rp2040js, esp32js's `Gpio` peripheral has no push-based "output
  changed" listener, so `onPinChange` is served by polling every subscribed
  pin once per `step()` instead (see the adapter's own `checkSubscribedPins`)
  — the same "dedupe via `lastPinValues`" posture as avr8/rp2040, just driven
  by a poll rather than a native listener callback.

**The circuit layer.** `web/common/src/circuit/` is a small,
adapter-agnostic layer built entirely on the client surface above, not on
any adapter internals directly:

- `CircuitPin` wraps one pin id behind `read()`/`write()`/`onChange()`,
  talking only to a `PinClient` (the minimal `call()`/`onPinChange()` shape
  — deliberately not imported from `web/shell`, so `web/common` has no
  dependency on it; `AdapterClient` satisfies it structurally).
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

A real-time workspace for placing, wiring, and powering board/sensor
illustrations, connected to the adapter/pin machinery above via the
circuit model (`web/shell/src/circuit.ts`) — `web/shell/index.html` +
`web/shell/src/canvas/` (the interactive tab-1 surface) + `web/shell/
src/main.ts` (the simulator panel, tabs, theme, and the handful of
bottom-bar toggles). Placing a board plugs it into its
`SimulatorAdapter`; Start/Stop powers it on/off for real (CPU running +
a visual power LED, not just one or the other).

**Layout.** `.app` is a full-viewport column: a `.topbar` (title), then
`.body` (a row: a narrow `.icon-rail` activity bar, a `.sidebar` holding
the log output + the Monaco sketch editor (see "In-browser editing and
compiling" below), and `.workspace` filling the rest). `.icon-rail` holds
two quick-access shortcuts stacked top-down - a cog (Compile & Run) and a
play triangle (Start) - that call the exact same handlers as the sketch
panel's own "Compile & Run" button and the simulator overlay's Start
button; no separate logic lives on the rail itself. `.workspace` is a tab bar (`#board-tabs`)
over one `.tab-pane` per tab — `tab2`/`tab3` are deliberately empty
panes (future workspaces with nothing built yet, not placeholder
canvases drawing an unused grid). Tab 1 holds the "Simulator" panel
(board picker, Start/Pause/Stop, state/energy readouts) pinned top-left,
next to a column of two things stacked vertically: the canvas itself
(with its own zoom-controls/minimap overlay, pinned to *its* bottom-right
corner, not the pane's) and, below it, the Serial Monitor panel (see
"Serial Monitor" below) — a `.tab1-canvas-and-overlay` wrapper exists
specifically so the overlay's positioning context is the canvas alone,
not a box that also includes the terminal, which would otherwise need to
know the terminal's current height to avoid overlapping it. The
bottombar (canvas-wide, not per-tab) holds, left to right: the Serial
Monitor visibility toggle, rotate-selected, the link-style toggle,
the simulator-panel/zoom-controls visibility toggle, and light/dark —
each an inlined Phosphor Icon (MIT, vendored at `assets/icons/phosphor/`)
or, for the three link-style icons, an original stroke-based glyph
(vendored at `assets/icons/custom/`) since no icon set has "a straight
line vs. an elbow vs. a bezier curve" as a ready-made concept.

**Module split: `web/shell/src/canvas/`.** The interactive part of tab 1
used to be ~900 lines inside `main.ts`; it's now six small modules, each
owning one concern, composed by `CanvasController` (`canvas/index.ts`) —
the only thing `main.ts` talks to:

- **`Viewport`** (`viewport.ts`) — pan and zoom (see below). Pure state
  and math; no DOM beyond the container/content elements it was
  constructed with.
- **`Scene`** (`scene.ts`) — the circuit model, its DOM, and every
  placement/drag/select/delete/rotate interaction (see below). Owns a
  `WiringLayer` internally (`scene.wiring`).
- **`Minimap`** (`minimap.ts`) — the small overview panel (see below).
- **`WiringLayer`** (`wiring.ts`) — pin-to-pin connections (see below).
- **`ContextMenu`** (`context-menu.ts`) — the right-click "Boards/
  Sensors/Connections" menu (see below).
- **`CanvasController`** (`index.ts`) — composes the five above and owns
  the interactions that don't belong to any single one of them:
  background-drag panning (a `Viewport` concern, but the mousedown has to
  originate from the same container `Scene` uses for its own background-
  click deselect, so they're coordinated here), the wheel-zoom binding,
  and the Backspace/Delete keyboard shortcut (tries `scene.deleteSelected()`
  first, then `scene.wiring.deleteSelectedWire()` — a board/component
  delete already takes its own wires with it, so the wire-delete path
  only ever fires when a wire itself, not one of its endpoints, is
  selected).

`main.ts` constructs one `CanvasController`, then only ever calls a
handful of things on it: `canvas.scene.showBoard()`/`addBoardAt()`/
`addComponentAt()` (via the context menu's callbacks), `canvas.scene.
onBoardPlaced()`/`onEntityDeleted()` (hooks — see "Boards vs. adapters"
below), `canvas.scene.findBoardByAdapter()`/`getDom()` (for Start/Stop's
power-LED and energy-readout logic), and `canvas.refresh()` (re-measure
the minimap after it was `display:none` — switching tabs, or the panel-
visibility toggle hiding it — see `Minimap.syncSize()`).

**Vendoring `@wokwi/elements`.** `simulators/iot-elements` is a git
submodule (`https://github.com/vecnode/iot-elements`, originally forked
as `vecnode/wokwi-elements` from `wokwi/wokwi-elements`, MIT, 0 commits
ahead at the time it was added — later renamed on GitHub, and, once a
second, separately vendored `vecnode/iot-elements` submodule turned out
to be the exact same repo under its new name, consolidated into this one
submodule; `simulators/wokwi-elements` no longer exists here) — consumed
exactly like `simulators/{avr8js,rp2040js}`: aliased straight to
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
  `web/shell/tsconfig.json` for `tsc`'s own typecheck) — iot-elements'
  components are Lit classes using legacy TS decorators
  (`@customElement`/`@property`/`@query`).
- **A `lit` alias/path mapping** (`vite.config.ts`'s `resolve.alias`,
  `tsconfig.json`'s `paths`) redirecting the bare `"lit"` specifier (and
  every subpath, `"lit/decorators.js"` etc.) to `web/node_modules/lit`.
  `simulators/` sits outside `web/`'s npm workspace, so plain node
  resolution walking up from `simulators/iot-elements/src/*.ts` never
  reaches `web/node_modules` on its own — `lit` (a real, well-behaved npm
  dependency, unlike avr8js/rp2040js which vendor everything) needed an
  explicit bridge. Same fix, for the same reason, for the type-only
  `import type React from 'react'` in iot-elements' `react-types.ts`
  (JSX typing for React consumers this project never uses) — a
  `"react"` path pointing at `@types/react` satisfies `tsc` without
  pulling in an actual React runtime dependency (the import is erased
  entirely at build; `@types/react` is types-only).
- `import "@wokwi/elements"` in `main.ts` is a bare side-effect import —
  Lit's `@customElement(tag)` decorator calls `customElements.define()`
  when each class is defined, i.e. on module evaluation, so importing the
  whole library registers every `<wokwi-*>` element, board and component
  alike (see `COMPONENTS.md` for the full registry, and its "Adding a new
  sensor or connection" section for why this means most new parts need
  zero new imports anywhere).

**Viewport: pan and zoom (`canvas/viewport.ts`).** One CSS transform —
`translate(panX, panY) scale(zoom)` — on the content layer
(`#tab1-content`), never on its container (`#canvas-tab1`).
`transform-origin: 0 0` keeps the math simple: world point `(0, 0)`
always maps to screen position `(panX, panY)` relative to the container,
regardless of zoom, so `screenToWorld()`/`visibleWorldRect()` are both a
few lines. Panning is its own `panX`/`panY` state, not the container's
native `scrollLeft`/`scrollTop` — tried scroll-based panning first, and
found by testing it directly that a `transform: scale()`'d child does
not reliably expand its parent's scrollable overflow region in this
engine: `scrollLeft` assignments silently clamped to a few dozen px once
zoomed in, nowhere near enough to reach the rest of the scene.
`translate()` sidesteps that entirely — `panX`/`panY` are plain state
this class owns and can move however far it wants.

Zoom is cursor-centered (`setZoomAt()`/`zoomAtBy()`): scrolling in on
part of the scene keeps that point under the cursor, by solving
`screen = pan + world * zoom` for the *new* pan while holding the world
point (derived from the *old* pan/zoom) fixed at the same screen
position. The `+`/`-` buttons and reset have no particular cursor
position to anchor on, so `setZoom()` centers on the viewport's own
center instead of leaving the anchor wherever the world origin happened
to be on screen. Bounded `0.25`–`2.5`× (`MIN_ZOOM`/`MAX_ZOOM` in
`canvas/index.ts`) — a floor so "zoom out to see the whole diagram" has
a limit before everything becomes unreadable, a ceiling so zooming
doesn't run away to a useless close-up. Background-drag panning
(left-click-drag on empty canvas) and the wheel binding are wired by
`CanvasController`, not `Viewport` itself, since the mousedown needs to
be coordinated with `Scene`'s own background-click deselect on the same
container element.

**Scene: placement, selection, drag, delete, rotation
(`canvas/scene.ts`).** Owns the circuit model (`circuit.ts`'s `Circuit`
— plain, JSON-serializable `CircuitBoard[]`/`PlacedComponent[]`, no DOM
reference inside it) and a parallel `Map<id, {wrapper, boardEl,
dispose}>` for the id-keyed DOM lookup, so `JSON.stringify(circuit)`
never has to filter anything out. Selection and drag are plain DOM/CSS —
no coordinate math beyond `Viewport.screenToWorld()`. `mousedown` on a
`.board-item` wrapper calls `stopPropagation()` (so the container's own
mousedown handler doesn't treat it as a background click), toggles
`.selected` (a CSS outline), and records a drag offset in world
coordinates; `mousemove`/`mouseup` are attached to `window` (not the
wrapper), so a fast drag that briefly leaves the element doesn't get
stuck. `makeDraggable()` returns a dispose function so `clearScene()`/
delete can clean up a placed item's listeners without leaking a new
`window` listener pair per item. Dragging keeps `entity.x`/`y` in sync
on every `mousemove` — the model is updated right alongside the DOM
style that renders it, not derived from the DOM after the fact — and
re-renders the wiring layer and notifies the minimap on every move,
since both need to track an entity's live position.

**Delete** (`deleteSelected()`, wired to Backspace/Delete by
`CanvasController`) removes whichever board/component is currently
selected: disposes its drag listeners, removes its DOM, drops it from
the `Circuit` arrays, and calls `wiring.removeEntity(id)` so any wire
touching it (and its registered pin offsets) goes with it — a deleted
board never leaves a dangling wire pointing at nothing. Selecting a pin
alone doesn't make anything deletable; only a placed board/component
itself can be removed this way. **Rotate** (`rotateSelected()`, the
bottom bar's rotate button) turns the selected item 90° clockwise by
setting `entity.rotation` (`CircuitBoard`/`PlacedComponent`'s newest
field, one of 0/90/180/270) and applying `transform: rotate(...)` to its
wrapper — purely visual (CSS transforms don't touch layout: `offsetLeft`/
`Width`/`Height`, drag math, and centering are all unaffected, exactly
like zoom's own `scale()` never disturbed them), so nothing about
placement or dragging needed to change for rotation to exist. The one
thing rotation *does* have to touch: a rotated entity's pins are no
longer where their raw, unrotated `{x, y}` offset says they are on
screen, so `Scene.entityFrame()` — the callback `WiringLayer` uses to
resolve a wire's endpoints — reports not just an entity's position but
its rotation and its wrapper's un-transformed layout size
(`offsetWidth`/`Height`, a plain layout property immune to the CSS
`rotate()`/`scale()` applied to it or its ancestors), so `WiringLayer`
can rotate a pin's local offset around the wrapper's own center the same
way the CSS transform visually does (see "Pin-to-pin wiring" below).
Verified directly: a wire's drawn endpoint tracks a rotated entity's
pin correctly at all four angles, and dragging still works normally on a
rotated item.

**Pin markers.** `overlayPinMarkers()` reads the placed element's own
`pinInfo` (`@wokwi/elements`' per-pin `{name, x, y}` coordinates) and
creates one small `.pin-marker` div per pin, positioned in plain CSS
pixels. Those coordinates are plain CSS pixels of the rendered element,
*not* the element's own SVG viewBox units — confirmed against
iot-elements' own reference overlay (`utils/show-pins-element.ts`: its
`<svg>` has no viewBox at all, and uses `pin.x`/`pin.y` directly as CSS
px) — dividing by the viewBox was tried first and produced markers
positioned outside the board, which is what exposed this. Since the
board element is rendered at true intrinsic size (never scaled to fit),
plain `${pin.x}px`/`${pin.y}px` lines a marker up with the real pin
regardless of zoom or devicePixelRatio, and — because the markers are
children of the same wrapper the board illustration is — rotating the
wrapper rotates them right along with it for free, visually; only the
wire-endpoint *math* (above) needed to separately account for rotation,
since that math lives outside the DOM.

**The circuit model — `web/shell/src/circuit.ts`.**

```ts
interface CircuitBoard {
  id: string;
  type: string;         // e.g. "arduino-uno" - key into the registries below
  adapterId: AdapterId;  // which SimulatorAdapter this board type is backed by
  x: number;
  y: number;
  powered: boolean;
  rotation: number;      // degrees, clockwise: 0/90/180/270
}
interface PlacedComponent {
  id: string;
  type: string;          // key into component-registry.ts's componentRegistry
  x: number;
  y: number;
  rotation: number;
}
interface Circuit {
  boards: CircuitBoard[];
  components: PlacedComponent[];
}
```

`PlacedComponent` is deliberately lighter than `CircuitBoard` — no
`adapterId`/`powered`, since sensors/connections aren't backed by any
`SimulatorAdapter` and have no power state of their own. Board-specific
behavior lives in per-type registries in `circuit.ts`
(`boardTagName`/`boardDisplayName`/`boardAdapterId`/`boardPowerSetter`);
everything placeable that isn't a board (sensors, connections) lives in
`web/shell/src/component-registry.ts`'s `componentRegistry` — see
`COMPONENTS.md` for the full list of both and how to add more of either.
`createBoard(type)`/`createComponent(type)` are the factories: resolve
the type against its registry, assign a simple incrementing id, return
`null` for an unknown type.

**Boards vs. adapters: plugging in, then powering on.** `avr8`/`rp2040`/
`esp32` are still parked out of the `#adapter-select` dropdown
(`index.html`) — not removed from the codebase; `adapter-registry.ts`,
`worker-rpc.ts`, and both adapter packages are untouched, just unreachable
from the UI while board work is the focus. `Scene.showBoard()`/
`addBoardAt()` fire an `onBoardPlaced` hook right after placing a board;
`main.ts` is the only subscriber, and its handler is exactly `apply
(board.adapterId)` — "plugging the board into the adapter" is `apply()`
doing everything it already did (`activeAdapterId`/`getAdapterClient()`/
state-and-serial-subscription), just reached through a hook instead of a
direct call, so `Scene` never needs to know `SimulatorAdapter`/`apply()`
exist. Symmetrically, `onEntityDeleted` lets `main.ts` notice when the
board backing the active adapter gets deleted (Backspace/Delete) and
reset the state/energy readouts and Serial Monitor rather than leaving
them pointed at a board that no longer exists.

**Start / Pause / Stop.** Three controls, not four - `step-btn`/`reset-btn`
were removed entirely (DOM and JS) rather than left disabled, once Pause
made Reset's old job part of what Stop already needed to do. All three
call through `activeClient()?.call(...)`, so they safely no-op if nothing
is plugged in yet:

- **Start** — `call("start")`, then `setPowered(true)`.
- **Pause** — `call("stop")` and nothing else. The adapter's own `"stop"`
  RPC method (`Avr8Adapter.stop()`/`Rp2040Adapter.stop()`) only halts
  ticking - it never resets CPU state, confirmed by watching `cycles`
  freeze exactly in place across repeated polls, then continue climbing
  (not restart from 0) after a later Start. This is deliberately *not*
  the same as powering off: `ledPower` and `board.powered` are untouched,
  matching a real board staying powered while halted mid-program (a
  debugger breakpoint, not a power cut).
- **Stop** — `call("reset")` (which itself calls `"stop"` first, then
  recreates the CPU/MCU object - wiping registers and cycle count back to
  power-on defaults) followed by `setPowered(false)` and
  `terminal.clear()` (stale Serial output from before the reset
  shouldn't linger as if still relevant). Verified: `cycles` reads back
  `0` and `ledPower` is `false` immediately after.

`setPowered(on)` (shared by Start and Stop, in `main.ts`) finds whichever
placed board is backed by the active adapter
(`canvas.scene.findBoardByAdapter(activeAdapterId)` — today, at most one
board can ever match), sets its `.powered` flag, and calls
`boardPowerSetter[board.type]` to reflect it on the real element — for
Arduino Uno, `ArduinoUnoElement.ledPower` (the power-supply LED, labeled
"ON" on the silkscreen; verified by checking the rendered shadow DOM
directly — a `<circle fill="#80ff80">` glow element appears/disappears
exactly with `ledPower`). This is deliberately *not* the same as
`led13`/`ledTX`/`ledRX` (those track real GPIO pin state, and aren't
wired up yet — see "Not yet wired: per-pin LEDs" below): `ledPower`
represents whether the board has power at all, independent of what any
pin is doing, and independent of whether it's currently executing (Pause
proves that: powered stays `true` throughout).

**Minimap (`canvas/minimap.ts`).** A small top-down overview, stacked
above the zoom controls at a rendered width that exactly matches theirs
(`Minimap.syncSize()`, watching `.zoom-controls` via `ResizeObserver`,
not a hardcoded number) — height derived from the canvas's own aspect
ratio so it isn't a distorted view of it. Its "world" bounds are a
*stable* frame — the container's own base (100%-zoom) viewport unioned
with every placed item's extent — deliberately *not* re-unioned with the
live visible viewport on every render. An earlier version did include
the live viewport in that union, and testing it directly showed the
whole frame constantly re-centering on wherever you'd just panned to
(since the live viewport was always one of the extremes defining the
frame) — the opposite of what a minimap is for. Panning somewhere with
nothing placed now correctly slides the viewport indicator toward (and
clips it against, via the panel's own `overflow: hidden`) the edge of a
frame that stays put. Click or drag anywhere on the panel pans the real
canvas there (`Viewport.centerOn()`), inverting the same offset/scale the
last render used.

**Pin-to-pin wiring (`canvas/wiring.ts`).** Click one pin, then another,
and a connection is drawn between them — a second, separate model from
the circuit (bridged only by entity id, the same pattern `energy.ts`
already established: two things that don't need to share a struct stay
two things). Rendered as one `<svg>` kept as the *last* child of
`#tab1-content` (`raiseToTop()`, re-asserted every time a new board/
component is placed) so wires always draw on top of everything they
connect; being a child of the same transformed content element as every
board/component wrapper, it inherits pan/zoom for free — a wire's
endpoints are plain world coordinates, no separate recompute needed for
that. A small terminal circle marks both ends of every wire, in every
style.

Three link styles, cycled globally by the bottom bar's link-style
button (applies to every existing wire immediately, not just ones drawn
after the click):
- **Straight** — a plain line.
- **Elbow** — a 5-segment orthogonal route (`A → (A.x, legAY) →
  (midX, legAY) → (midX, legBY) → (B.x, legBY) → B`), but only the
  middle three segments (both horizontal "legs" and the vertical
  "channel" between them) are ever independently dragged via their own
  handle — the two short vertical stubs at each end exist purely so a
  leg's height can move without dragging the (fixed) pin itself, and
  collapse to zero length at their defaults (`legAY === a.y`, `legBY ===
  b.y`), which is exactly what makes an un-dragged elbow wire look like
  a plain 3-segment "Z", not five. Each of the three free values
  (`ElbowRoute.midX`/`legAY`/`legBY`) stays exactly where dropped once
  dragged, and is otherwise recomputed against the pins' current
  positions — verified directly: dragging all three handles
  independently, then dragging the connected board, leaves the three
  stored values untouched while only the endpoints (and the stub
  lengths absorbing the difference) move. Handles only render for the
  *selected* wire, not every elbow wire on the canvas at once.
- **Bezier** — an automatic S-curve (control points offset from each
  endpoint along the horizontal axis, `MaxMSP`/Pd-style), no dragging.

A wire is itself selectable and deletable: each rendered path has a
wide, invisible twin underneath it (`pointer-events: stroke`, easier to
click than a 2px visible line) that selects the wire on click and clears
whatever board/pin was selected (only one kind of thing is ever selected
at once — a `Scene`↔`WiringLayer` callback pair keeps the two
selections mutually exclusive without either reaching into the other's
internals). Backspace/Delete on a selected wire
(`WiringLayer.deleteSelectedWire()`) removes just that wire, tried by
`CanvasController` *after* `Scene.deleteSelected()` — a board/component
delete already takes its own wires with it via `removeEntity()`, so the
wire-only path only fires when the selection is a wire itself, not one
of its endpoints.

**Wire color palette (`#wire-color-panel`, `main.ts`'s `WIRE_COLORS`).**
A wire's color is a single global setting (`WiringLayer.setColor()`), the
same posture as link style above — not a per-wire, per-signal property
computed from what a wire is actually carrying (`WiringLayer` has no such
opinion; see the signal-chain section below for the one place that *does*
know). The bottom bar's palette toggle exists so a user can *manually*
color-code their own wiring, and its nine swatches follow the
conventional breadboard signal-type color code, so a swatch's meaning is
documented rather than an arbitrary hue:

| Color  | Signal type          |
| ------ | --------------------- |
| Red    | VCC (power)           |
| Black  | GND (ground)          |
| Blue   | Analog                |
| Green  | Digital               |
| Purple | PWM                   |
| Gold   | I2C (SDA/SCL)         |
| Orange | SPI (MOSI/MISO/SCK)   |
| Cyan   | USART (TX/RX)         |

(GND's swatch renders as a dark gray, `#333333`, rather than pure black —
true black would be invisible against the canvas's own `#1a1a1a`
dark-theme background.) A first "Default" swatch (`DEFAULT_WIRE_COLOR`,
`#f5b400`) rounds the panel out to nine. Picking a swatch recolors every
wire on the canvas immediately, same as before this table existed —
wires still don't self-color by voltage/current from the energy model
(removed in #57; a wire keeps whatever color was last picked, or the
default, regardless of what the analog solver reports for it).

**From wires to real pin I/O — the signal chain
(`web/shell/src/signal-chain.ts`).** Pin-to-pin wiring above is purely
visual — `WiringLayer` never knows a `Wire` means anything electrical.
Three more pieces, layered on top, turn *some* wires into real,
adapter-backed I/O without `WiringLayer` gaining any opinion about it:

- **`component-signal-pin.ts`** (`web/common`) — a small, separate table
  (`componentSignalPins`, keyed by component type, not reusing
  `BoardPinMap` — a board's map describes 20+ real pins, this describes
  "the one pin (of a few electrically-equivalent names) that matters"
  for a small part) naming which of a component's pins actually carries
  a signal, and which direction: `role: "write"` means the component
  drives whatever board pin it's wired to (a pushbutton shorting a pin
  high while held); `role: "read"` means the component reflects whatever
  the board pin already is (an LED lighting up because firmware drove
  its pin). A component with no entry (most of `COMPONENTS.md`'s list,
  today) has no signal-chain behavior yet — still a purely visual
  illustration. `pushbutton`/`pushbutton-6mm` list all four of their
  (mechanically-shorted-in-pairs) legs as equivalent; `led` lists just
  its anode (`"A"`).
- **`canvas/signal-net.ts`** (`resolveSignalLinks()`) — resolves
  `WiringLayer.getWires()` into `SignalLink[]`, a second, narrower model
  bridged to `Wire` only by `wireId` (the same "two things stay two
  things" pattern `energy.ts`/`circuit.ts` already established).
  Deliberately narrow: a link is exactly one component pin wired to
  exactly one board pin, direction-agnostic on the wire itself (tries
  both endpoint orderings) — a wire between two boards, two components,
  or a component pin not in `componentSignalPins` resolves to nothing and
  stays purely visual, same as every other wire.
- **`SignalChain`** (`signal-chain.ts`) — constructed once in `main.ts`,
  subscribes to `scene.wiring.onWiresChanged()` and recomputes on every
  change (not polled, not on every `render()` — dragging a wire fires
  that constantly). For each live link it resolves the board pin's
  on-canvas marker name to the adapter's real pin id
  (`resolveBoardPinName()` + `boardPinMaps`, `web/common/src/boards/`)
  and constructs a `CircuitPin` against the board's own
  `SimulatorAdapter` client. A `role: "write"` component gets wrapped in
  a `Button` driven by the placed element's own `button-press`/
  `button-release` DOM events (already dispatched by `wokwi-pushbutton`'s
  built-in mouse handling — clicking it in the canvas presses it for
  real); a `role: "read"` component skips the `Led` wrapper entirely and
  drives the placed element's own `value` property directly from
  `CircuitPin.read()`/`onChange()`, since there's no external
  change-hook to redraw a DOM property from otherwise. Each attachment is
  disposed (listeners removed, subscription dropped) the moment its wire
  disappears, so deleting a wire — or the board/component at either
  end — cleanly stops driving/reading that pin rather than leaking a
  stale subscription. Board-agnostic by construction: everything it
  reads (`boardPinMaps`, `componentSignalPins`, the board's own
  `adapterId`) is a per-type lookup table, so a second placeable board
  type needs no change here, only a new `boardPinMaps` entry.

This means the "Explicitly out of scope" note below needs one
clarification: **digital** logic now does propagate along a drawn
wire — a pushbutton wired to pin 2 and an LED wired to pin 13 genuinely
drive/reflect real AVR GPIO state once "Examples" (next) wires them up.
What's still out of scope is everything *analog* — voltage/current
values, Ohm's-law current flow, any SPICE/MNA-style topology solve.
`SignalChain` moves a `0`/`1` between a pin and a component's on/off
state; it does not compute what a resistor between them would do to
that signal.

**Examples: canvas layout + sketch, loaded together
(`main.ts`'s `EXAMPLES` table).** The circuit-building tools above
(`Scene.showBoard()`/`addComponentAt()`, `WiringLayer.connect()`) are
also what a fresh launch uses to start from something already working,
not an empty canvas the user has to wire up by hand before "Compile &
Run" does anything visible. `WiringLayer.connect(a, b)` is the
programmatic equivalent of two pin clicks (added specifically for this),
bypassing `handlePinClick()`'s click-click pending state entirely since
there's no marker element to visually track a pending click against.

Each `EXAMPLES` entry pairs a `build()` (places a board + components via
the same `Scene` API the canvas's own right-click menu uses, then wires
them with `connect()`) with a matching sketch string — picking one
replaces both together, so the code always matches the circuit it's
about to run against. `loadExample(DEFAULT_EXAMPLE_ID)` runs
unconditionally on startup (today: "Blink LED" — an Arduino Uno with an
LED wired to pin 13, matching `LED_BUILTIN`), so `Compile & Run` already
does something the very first time it's clicked. A second example
("Button Control" — a pushbutton on pin 2 driving an LED on pin 13)
exercises the write-role half of the signal chain above, not just the
read-role half the first example does alone.

**The gallery (`#example-gallery-overlay`, `renderExampleGallery()`).** A
full-viewport modal (90vw × 90vh, rounded corners) shown right after the
default example finishes building underneath it — closing without
picking a different one just leaves that default in place, so the
gallery is never the only thing standing between a fresh launch and a
working circuit. Reopenable any time via the sidebar's "Choose
Example…" button. One `.example-card` button per `EXAMPLES` entry, built
fresh from the table (`grid-template-columns: repeat(4, 1fr)`, so more
examples naturally fill out more of the grid without any HTML to edit).
This is deliberately the one place in the app that breaks from the flat,
sharp-cornered node-editor look everywhere else (`.panel`, `button`, etc.
are all 1px borders, no radius, no shadow) — a full-viewport picker reads
as a launcher/dialog, not another canvas panel.

**Right-click context menu (`canvas/context-menu.ts`).** Three flyout
submenus — Boards, Sensors, Connections — each one entry per registered
type (`circuit.ts`'s `boardTagName`/`boardDisplayName` for boards,
`component-registry.ts`'s `componentRegistry` for the other two; see
`COMPONENTS.md`), built fresh on each open. Submenus default to opening
right/down but flip to whichever side actually has room
(`positionSubmenu()`, run on every hover rather than once at build time,
since a `display: none` submenu reports zero size to measure before
it's actually shown) — a row near the right or bottom edge of the window
no longer runs a submenu off-screen, the bug this exists to fix; the
top-level menu itself is clamped into the viewport the same way right
after it opens, for a right-click very close to the window's edge.

**Energy model — `web/shell/src/energy.ts`, deliberately separate from
the circuit model.** `CircuitBoard.powered` is binary; it says nothing
about voltage, current, or power draw. Rather than add those as more
fields on `CircuitBoard`, they live in their own file with their own
`BoardEnergy` type (`{boardId, voltage, currentMa}`, linked to a
`CircuitBoard` only by matching `id` — the two never share a struct).
This mirrors a pattern confirmed directly in
[velxio](https://github.com/davidmonterocrespo24/velxio)'s docs
(`docs/wiki/circuit-emulation*.md` — consulted for architecture ideas
only, see the licensing note below): their digital MCU harness
(`AVRHarness`, wrapping `avr8js`) and their analog solver never share a
data structure either — a dedicated `AVRSpiceBridge` is the *only*
connection point, reading pin/PWM state out of the harness and writing
solved node voltages back in. `computeEnergy(board, running)` in
`energy.ts` is that same shape of bridge here: it reads a `CircuitBoard`,
returns a `BoardEnergy`, and `circuit.ts` has no idea `energy.ts` exists
(one-directional dependency, not two modules reaching into each other).

velxio's own energy simulation is genuinely two-tier — confirmed, not
inferred: **Pipeline A**, a hand-rolled ~500-line JS Modified Nodal
Analysis (MNA) solver (node graph, component "stamps", Newton iteration,
backward-Euler transient — zero dependencies, fast); **Pipeline B**, real
`ngspice` compiled to WASM via `eecircuit-engine` (confirmed MIT
licensed, a real standalone npm package, not velxio's own code) for full
SPICE — AC/transient, diodes, BJTs, MOSFETs, op-amps, thermistors. Full
SPICE came *after* the fast/simple solver, which came *after* the
digital simulation was solid. (Wokwi's own approach is inferred, not
confirmed, since its core engine isn't open source: fundamentally
digital, with per-component behavioral analog approximations bolted on
where a specific part needs one — not a general topology solver.)

This project is at the "digital simulation solid, boards/components can
be placed and visually wired, no electrical solve across those wires
yet" stage — matching where velxio was *before* Pipeline A existed. So
`energy.ts` intentionally isn't a solver at all: everything
`computeEnergy()` needs for one board type lives in one `PowerProfile`
per type (`boardPowerProfile: Record<string, PowerProfile>` — collapsing
what used to be two separate lookup tables, `boardNominalVoltage` and
`boardNominalCurrentMa`, into one entry per board, so adding a board
type is one registry line instead of an edit in two places):
`supplyVoltage` and `currentMa: {idle, running}` are fixed, known
constants (an Arduino Uno's logic level *is* 5V whenever powered, not
something to compute), approximate and explicitly labeled as nominal in
code comments, not measured. A `PowerProfile` can also name the
`PowerSource`s a board could be fed from (USB, wall adapter, Vin header —
each with a nominal voltage and, where known, a current limit) —
informational only today, nothing in `computeEnergy()` branches on it
yet, but the natural slot for a future "what's this board plugged into"
control without reshaping `BoardEnergy` again. (`PowerSource` is
unrelated to `SimulatorAdapter` — the two just happen to share the
English word "adapter"; one is CPU emulation, the other is a power
supply.) `currentMa` picks between the idle/running nominal off the
adapter's own `state.running`. `power` (mW) is derived
(`voltage × currentMa`), not stored. Wired into `main.ts` at exactly two
points: `setPowered()` (voltage/current snapshot the instant power state
changes) and `renderState()` (already firing on every adapter
`stateChange` — the natural place to correct current from idle to
running once ticking is actually confirmed, no new adapter-side
plumbing). The UI is a second `<dl>` (`#energy-list`) sitting next to the
state readout in `.tab1-simulator-panel` — visually separate blocks,
matching the code-level split, not merged rows in one table.

**Explicitly out of scope, tracked here on purpose.** Per-pin voltage,
real circuit-topology solving (Ohm's law across actual wires), any
SPICE/MNA solver (hand-rolled or `eecircuit-engine`/ngspice-WASM). Pin-
to-pin wiring (above) is still a *visual* connection model on its own —
which pin points at which — and nothing propagates a voltage or current
along a drawn wire; the signal chain (below) layers *digital* logic
(`0`/`1`) on top of specific wires for specific, registered component
pins, which is a narrower thing than an electrical solve, not a first
version of one. All of the above is the natural Pipeline-A-shaped next
step now that there's an actual netlist (the wires) for a solver to work
on — not guessed at or half-built here.

**Board elements: real size, not scaled to fit.** Placing an element
creates the wrapper + custom element, then **awaits `updateComplete`**
before measuring and centering it — LitElement's first render happens on
a microtask after `connectedCallback`, not synchronously on `appendChild`,
so measuring immediately would see an empty (zero-size) shadow DOM and
center against the wrong size (caught during verification: centering was
silently wrong until this await was added). Once rendered, the element's
SVG intrinsic size (`width="72.58mm"` etc., browser-computed) is used
as-is — never scaled up or down to fit the container. `Apply` replaces
the whole scene rather than stacking duplicate boards; the right-click
menu's "add" flow adds alongside whatever's already placed instead.

**Supported boards/components.** See `COMPONENTS.md` for the full,
maintained list (one board, 13 sensors, 30 connections, and how to add
more of either) — not duplicated here to avoid two places going stale
independently of each other.

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
what Wokwi's own app is built on. The per-pin click events this switch
didn't give for free on its own — `<wokwi-arduino-uno>`'s pin headers
render as a few grouped `<rect>` strips, not one interactive element per
pin — are exactly what "Pin markers" and "Pin-to-pin wiring" above went
on to build: small positioned marker elements using `pinInfo`'s
coordinates, wired to click-to-select and click-to-connect.

**Not yet wired: per-pin LEDs.** `led13`/`ledTX`/`ledRX` on
`ArduinoUnoElement` would make the board's own onboard LEDs reflect real
GPIO activity (pin B5/TX/RX), the same way `web/common/src/circuit/`'s
`Led` component already can for any `CircuitPin` — a natural, cheap-
looking follow-up once there's a reason to read a pin's live value on
the canvas itself, not conflated with the power-on/off work above.

## Serial Monitor

A read-only terminal panel (`web/shell/src/terminal.ts`), docked below
the canvas as a flex sibling — not overlaid on top of it, which is why
`web/shell/index.html`'s `.tab1-canvas-area` grew a `.tab1-canvas-and-
overlay` wrapper: the zoom-controls/minimap overlay needed a positioning
context that stays scoped to the canvas itself, so it doesn't need to
know how tall the terminal panel currently is to avoid overlapping it.
Two independent ways to get it out of the way: a bottom-bar button
(`#terminal-toggle-btn`) hides the whole panel, persisted the same way
as the theme/chrome-hidden toggles; the panel's own header has a second,
lighter-weight collapse button that just shrinks it to that header
without hiding it.

**Three stages — all three now built.** The natural next step after a
Serial Monitor exists is "let me write and run an Arduino sketch here,"
and the honest constraint was always that nothing about an editor widget
is the hard part — `avr8js` only emulates a CPU executing whatever's
already sitting in its flash; turning an Arduino sketch into AVR machine
code needs a real compiler, not a text editor.

1. **Surface whatever the firmware transmits over UART** — see above.
2. **Firmware loading** — accepts a compiled `.hex` file (below), so the
   terminal could show something real before an in-browser editor or
   compiler existed at all.
3. **In-browser editing and compiling** — a real AVR toolchain, reached
   from a real code editor, both now exist. See below.

**The editor (`web/shell/src/sketch-editor.ts`).** Monaco (VS Code's own
editor engine), not the plain `<textarea>` the sketch panel used before
this. `index.html`'s CSP carries `style-src 'unsafe-inline'` specifically
for this — Monaco's theming engine injects a runtime `<style>` tag with
computed CSS, and there's no working nonce-based alternative today (a
still-open upstream limitation, confirmed by checking rather than
assumed: microsoft/monaco-editor#271, #4927); `script-src` stays `'self'`
regardless, low-risk here specifically because physicalsim binds to
`127.0.0.1` only. Two things needed to make it actually work, both
confirmed live rather than assumed correct:
- The `cpp` Monarch tokenizer is imported and registered *eagerly*
  (`monaco.languages.setMonarchTokensProvider`), not left to Monaco's own
  lazy-load-on-first-tokenize path — that path depends on an internal
  animation-frame-driven scheduler that doesn't reliably run in every
  host/embedding; every token stayed the plain, uncolored `"mtk1"` even
  seconds after the lazy load must have finished, until this was made
  eager.
- The constructor forces one real content-change event right after
  creation (`model.setValue(getValue() + " ")` then immediately
  `slice(0, -1)` back) followed by an explicit `layout()`/`render(true)` —
  Monaco's own first paint/tokenization pass is deferred to that same
  unreliable scheduler, and a `setValue()` with *identical* content is a
  silent no-op (no change event, nothing to retokenize), so only a real,
  reverted change actually forces the first real paint.
- A small hand-written completion list (`ARDUINO_CORE_COMPLETIONS`) for
  the Arduino core's most common calls (`pinMode`, `digitalWrite`,
  `delay`, `Serial.print`, …) — not a real language server; `avr8js`
  itself only emulates GPIO/Timer/USART today, so semantic analysis
  against real Arduino headers wouldn't buy much yet either.

**The compiler (`src/avr_toolchain.cpp`, native side).** `POST /compile`
(body `{"source": "<sketch text>"}`) wraps the source in
`#include <Arduino.h>\n` + the sketch body (the same assumption the real
`.ino` → `.cpp` wrapping step makes — sketches are plain function bodies
plus `setup()`/`loop()`, not full translation units), compiles it and
every `.c`/`.cpp` file in the vendored Arduino core
(`simulators/ArduinoCore-avr/cores/arduino`) against `-mmcu=atmega328p`,
links with `avr-gcc`, and runs `avr-objcopy` to Intel HEX — the exact
same format, and the exact same
`parseIntelHex()` → `loadFirmware()` path, "Load .hex…" already used, so
compiling was never a second firmware-loading code path to maintain.
Each compile step (`run_and_wait()`) spawns synchronously with a 30s
timeout and its own temp working directory, wiped afterward (success or
failure) so repeated "Compile & Run" clicks don't leak files.

`find_toolchain()` looks for two things independently, each with its own
fallback chain, and only proceeds if both resolve:
- **The compiler bin dir** (`find_toolchain_bin_dir()`) — a bundled copy
  next to physicalsim's own executable (`avr-toolchain/bin/`, see
  "Distribution" below) first, then `avr-g++`/`avr-gcc` on `PATH`, then a
  real Arduino IDE install's own bundled toolchain
  (`%LOCALAPPDATA%\Arduino15\packages\arduino\tools\avr-gcc\<version>\bin`
  on Windows) — reusing it rather than requiring a second copy if the
  user already has the IDE installed.
- **The core/variant dirs** (`find_core_dir()`/`find_variant_dir()`) — a
  bundled `avr-core/` next to the executable first (packaged builds copy
  `simulators/ArduinoCore-avr`'s `cores/arduino` + `variants/standard`
  there unconditionally at build time, since it's small enough to always
  ship, unlike the toolchain), falling back to
  `simulators/ArduinoCore-avr` straight from the source tree
  (`PHYSICALSIM_SOURCE_DIR`, a compile-time define) for a dev build run
  before that copy step has ever happened.

**Distribution: bundled vs. system avr-gcc.** `BUNDLE_AVR_TOOLCHAIN`
(`CMakeLists.txt`) mirrors `BUNDLE_WEBVIEW2_FIXED_RUNTIME`'s pattern: off by
default, `FetchContent`-fetches Arduino's own prebuilt `avr-gcc` archive
per platform when on, `package_release.bat` turns it on automatically for
every Release package. One real bug found and fixed by actually
extracting the archive and looking, not by trusting the URL/layout
comment that shipped with the original code: the Windows zip's layout
doesn't match the macOS/Linux tarballs'. The macOS/Linux archives nest
the *entire* toolchain — `bin/`, `include/`, `lib/`, `libexec/` (which
holds `cc1plus`, needed at compile time), the real `avr-`-prefixed
compiler drivers and all — one level down inside a single top-level
`avr/` directory. The Windows zip is flatter: the real `avr-g++.exe`/
`avr-gcc.exe`/`avr-objcopy.exe` and `libexec/` already sit at the archive
*root*; its own `avr/` subdirectory is just the AVR target sysroot
(unprefixed binutils only — `ar.exe`, `ld.exe` — no compiler driver at
all). Pointing at `avr/bin/` on Windows (what a first pass at this
CMake logic did) silently "succeeded" — a real `avr-toolchain/` folder
landed next to the exe — while dropping the compiler driver from it
entirely, so `Compile & Run` still failed with the exact
toolchain-not-found error `BUNDLE_AVR_TOOLCHAIN` exists to fix. Fixed by
checking which layout the extracted archive actually has
(`EXISTS ".../bin/avr-g++.exe"`) and mirroring the correct root wholesale
into `avr-toolchain/` either way. `build_and_run.bat` also passes
`-DBUNDLE_AVR_TOOLCHAIN=ON` now, so a Debug dev build gets a working
in-app compiler the same way a packaged Release does, rather than
requiring a separately-installed toolchain just to exercise this feature
locally.

**Vendored Arduino libraries (`simulators/LiquidCrystal`, etc.).** A
sketch can `#include` a real Arduino library now, not just the core -
each is its own git submodule under `simulators/`, following the modern
Arduino 1.5+ layout (headers/sources directly under the library's own
`src/`). `find_library_dirs()` resolves each name in a fixed
`known_libraries()` list (currently just `LiquidCrystal`) the same
bundled-first-then-source-tree way `find_core_dir()`/`find_variant_dir()`
already do — a bundled `avr-libraries/<name>/src` next to the executable
(`CMakeLists.txt`'s `AVR_LIBRARIES` list copies each one there
unconditionally, the same "small enough to always ship" posture as
`avr-core/`), falling back to `simulators/<name>/src` for a dev build.
Missing libraries are dropped individually, not all-or-nothing -
`find_toolchain()` still succeeds without any of them, since most
sketches don't need one. Each resolved directory becomes both a `-I`
(`common_flags()`) and a set of `.c`/`.cpp` files compiled unconditionally
alongside the core, sketch-independent — same reasoning as the core
itself being fully compiled regardless of which functions a given sketch
actually calls: `-ffunction-sections`/`--gc-sections` (already in place)
drops whatever the linker doesn't reach, so there's no need to detect a
sketch's actual `#include`s first. `compile_one()`'s object filenames
gained a running-counter prefix at the same time — once the core and N
library directories can each contribute a file, two different
directories sharing a basename (e.g. two `utility.cpp`s) would otherwise
silently overwrite each other's `.o` in the shared temp `work_dir`.

Verified end-to-end, not just "it links": a real sketch (`#include
<LiquidCrystal.h>`, `lcd.begin()`/`lcd.print()`) posted to `/compile`
produced a genuine, non-empty Intel HEX image with an empty compiler log,
and a plain non-LCD sketch still compiled afterward with no regression.
I2C-based LCD libraries (`LiquidCrystal_I2C`, most real-world backpacks)
remain a separate, larger gap - `avr8js` has no I2C/TWI peripheral
emulated at all, unlike parallel `LiquidCrystal` below, which only ever
needs plain GPIO.

## Multi-pin protocols: from real GPIO writes to a real display

The compiler above gets a `LiquidCrystal`-based sketch to compile and run
against a real CPU; this section is what makes its `digitalWrite()` calls
actually turn into characters on the canvas's LCD - the *simulation*
half of the same feature, deliberately built as a second, general
mechanism rather than one LCD-shaped special case.

**Why this couldn't just be `signal-chain.ts` again.** Every component
`SignalChain` (see "Pin-to-pin wiring"/"From wires to real pin I/O"
above) drives is *one pin, one 0/1 value* - a pushbutton's write, an
LED's read. An LCD's HD44780 bus needs **six pins correlated together**
(RS, E, D4, D5, D6, D7) read as one unit, not six independent signals -
a shape `componentSignalPins`/`SignalChain` has no way to express. Rather
than bolt multi-pin support onto that file (and risk the already-working
LED/pushbutton path along the way), this is a parallel system, the same
"two things that don't need to share a struct stay two things" posture
`circuit.ts`/`energy.ts` already established:

- **`web/common/src/circuit/component-protocol-pin.ts`** —
  `componentProtocols`, keyed by component type, each naming a set of
  required *roles* (`rs`, `e`, `d4`.. for `lcd1602`) and which of the
  component's own `pinInfo` names satisfy each one. The counterpart to
  `component-signal-pin.ts`'s single-pin roles, deliberately kept
  separate rather than folded in - forcing "one pin, one role" and
  "several correlated pins, one decoder" into one table would leave one
  shape's fields unused by the other.
- **`web/shell/src/canvas/protocol-net.ts`** — `resolveProtocolLinks()`,
  the multi-pin counterpart to `signal-net.ts`'s `resolveSignalLinks()`:
  groups wires by the *component instance* they touch (not the wire
  alone), and only emits a `ProtocolLink` once **every** role
  `componentProtocols` names for that component type has a wired pin - a
  partially-wired LCD (say, missing `D7`) simply doesn't appear yet, the
  same way an entirely unwired one wouldn't.
- **`web/shell/src/protocol-chain.ts`** — `ProtocolChain`, the multi-pin
  counterpart to `SignalChain`: recomputes on `onWiresChanged()`, and for
  each complete link resolves one real `CircuitPin` per role through
  **the exact same three pieces `SignalChain` already uses** -
  `boardPinMaps`, `resolveBoardPinName()`, `CircuitPin.forBoardPin()` -
  then hands them to a small `PROTOCOL_ATTACHERS` registry keyed by
  component type (`lcd1602`/`lcd2004` → both construct an
  `Hd44780Decoder` and assign its output to the placed element's own
  `characters` property, differing only in the `cols`/`rows` passed in -
  `wokwi-lcd2004` is a plain subclass of `wokwi-lcd1602` in
  `simulators/iot-elements`, same pinInfo, same API, just a 20x4 size
  override, so it needed no protocol work of its own once
  `Hd44780Decoder`'s row addressing was generalized - see below).
  Disposal is per-component, not per-wire: the moment any one of the six
  wires disappears, the whole decoder detaches.

**Why this is already board-agnostic, not just component-agnostic.**
Nothing above - `componentProtocols`, `resolveProtocolLinks()`,
`ProtocolChain` - ever names a board type or talks to an adapter
directly; every board-specific lookup goes through the same
`BoardPinMap`/`CircuitPin.forBoardPin()`/`PinClient` surface
`SignalChain` and the whole pin I/O pipeline already share. A second
placeable board type on an already-registered adapter (a new AVR variant,
say) needs one new `boardPinMaps` entry and nothing else - the adapter
already has a working `readPin`/`writePin`/`onPinChange`. A genuinely new
adapter needs those three implemented once (esp32 did exactly this, see
"ESP32 board and toolchain" below) - nothing in this section changes
either way. A second multi-pin component (a relay
needing its own vendored library and its own multi-pin decoder, say)
needs one `componentProtocols` entry, one decoder class, and one
`PROTOCOL_ATTACHERS` entry - again, nothing else here changes. This
extensibility was a deliberate design goal, not an incidental side
effect of how it happened to get built.

**`Hd44780Decoder`
(`web/common/src/circuit/protocols/hd44780-decoder.ts`).** Board- and
DOM-agnostic on purpose (only ever talks to `CircuitPin`, and reports
character-buffer updates through a plain callback) - it's tested in
isolation the same tier `Led`/`Button` are
(`hd44780-decoder.test.ts`, `vitest`), not only through the full app.
Every decoding choice below is derived directly from the exact vendored
source it decodes (`simulators/LiquidCrystal/src/LiquidCrystal.cpp`), not
general HD44780 folklore:

- **Never a reactive `read()` at the moment a pulse latches.** Pin I/O is
  an async Worker RPC round-trip (see the pin I/O pipeline above); a
  fresh `read()` triggered *by* `E`'s falling edge could easily resolve
  after the firmware has already moved on to the next nibble. Instead,
  all six pins are subscribed via `onChange()` into a local shadow
  `Record<role, value>`, kept current purely by event order - `write4bits()`
  always sets all four data lines *before* calling `pulseEnable()`, so
  their change events are guaranteed to arrive before `E`'s own, in the
  CPU's real program order.
- **Latches on `E`'s falling edge** (`pulseEnable()`: `LOW → HIGH → LOW`,
  data lines never touched while `E` is high) - matches the real
  datasheet's own latch point, not just "whichever edge is convenient."
- **Nibble pairing, not per-call framing.** `send()` always issues two
  nibble pulses (high, then low) with one shared `RS` value set once
  before both - so the decoder holds the first nibble until a second
  arrives, then decodes the combined byte with the first nibble's `RS`.
  The one place unpaired nibbles exist in the real source at all -
  `begin()`'s 4-bit-mode reset dance, four standalone `write4bits()`
  calls (`0x3, 0x3, 0x3, 0x2`) - isn't special-cased: naive pairing turns
  them into two bogus "bytes" (`0x33`, `0x32`), and both happen to decode
  as `FUNCTION SET` (bit `0x20` is the highest set bit in each) under the
  real HD44780 priority encoding below - which this decoder treats as an
  intentional no-op anyway, since the wokwi-lcd1602 element it drives is
  a fixed 16×2, 5×8-font display regardless of what any sketch requests.
  The mispairing is inert by construction, not a tolerated bug.
- **Instruction decoding is real HD44780 priority encoding** - each
  command is one distinct flag bit (`0x80` down to `0x01`) with payload
  bits reserved below it, so checking from the highest bit down and
  stopping at the first match is exactly what the real chip's hardware
  does, not an approximation of it. `SETDDRAMADDR`/character writes and
  cursor increment/decrement (entry mode's `I/D` bit) are fully
  implemented; `SETCGRAMADDR` (custom glyphs via `createChar()`) and
  whole-display shifting (`scrollDisplayLeft/Right`, `autoscroll()`) are
  documented no-ops - the sketch itself still compiles and runs correctly
  either way, they just don't draw on this canvas yet. `CLEARDISPLAY`
  also resets entry mode to increment, matching the real datasheet (not
  only `LiquidCrystal`'s own default), since `clear()` is the one command
  real firmware can call at any point to reach a fully known state.
- **Display on/off blanks without discarding** - `noDisplay()`/`display()`
  toggle whether the buffer is rendered, not whether it's written to, the
  same as a real LCD's backlight-off-but-still-holding-content behavior.

Verified against the *exact* pulse sequence the real source produces
(`hd44780-decoder.test.ts` replays `begin()`'s full init dance,
`print("Hi")`, `setCursor(0,1)` + a second `print()`, and `clear()` by
hand, asserting the decoded buffer at each step) and, separately, against
the real running app: a genuine `LiquidCrystal`-based sketch
(`simulators/LiquidCrystal`'s own `examples/HelloWorld/HelloWorld.ino`,
public domain, used verbatim as the "LCD Display" canvas example)
compiled, loaded, and run through the full pipeline - `lcd.print("hello,
world!")` and a live `millis()/1000` counter on row 2 both appeared on
the placed `wokwi-lcd1602` element and kept advancing in real time, with
no static/preset text involved anywhere in the path.

**Generalizing to `lcd2004`.** DDRAM row addressing wasn't a 2-row
hardcode to begin with: `rowOffsets` is computed as
`[0x00, 0x40, cols, 0x40 + cols]` - exactly `LiquidCrystal::begin()`'s
own `setRowOffsets(0x00, 0x40, 0x00 + cols, 0x40 + cols)` call, made
unconditionally regardless of line count - and `addressToRowCol()`
resolves an address against however many of those four offsets the
display actually has rows for (the highest offset not exceeding the
address wins, the same way a real chip's row boundaries work). So a
20x4 `wokwi-lcd2004` (a plain `wokwi-lcd1602` subclass in
`simulators/iot-elements` - same `pinInfo`, same `characters`/`text`
API, only `numCols`/`numRows` overridden) needed no protocol work of its
own: one more `componentProtocols`/`PROTOCOL_ATTACHERS` entry passing
`cols=20, rows=4` into the same `Hd44780Decoder`. Rows 2/3 starting at
`cols` and `0x40 + cols` (not a straightforward continuation of rows
0/1) is a real, slightly odd quirk of 4-line HD44780 displays, not a
physicalsim simplification of one - covered by its own
`hd44780-decoder.test.ts` case. Verified in the running app that a
placed `wokwi-lcd2004` exposes the same `RS`/`E`/`D4`-`D7` pin names and
wires successfully through the exact same `ProtocolChain` path
`lcd1602` already runs through end-to-end above; the row-addressing math
itself is what the new unit test covers.

**The RPC surface** — three additions, mirroring the pin I/O pipeline
above almost exactly (`web/common/src/adapter-types.ts`,
`worker-host.ts`):

- `onSerialData?(cb): () => void` — optional on `SimulatorAdapter`, same
  reasoning as `onPinChange?`: not every adapter has a UART wired up
  (`avr8` and `esp32` do; `rp2040js` isn't given a UART peripheral in
  `web/adapters/rp2040/src/adapter.ts`).
- `"subscribeSerial"` — a request-shaped `AdapterMethod`, idempotent via
  a single `serialSubscribed` boolean in `worker-host.ts` (simpler than
  `subscribePin`'s per-pin `Map`, since there's only one serial stream
  per adapter, not one per pin).
- `{ event: "serialData", byte }` — a new `RpcEvent` member, pushed
  unsolicited once subscribed, exactly like `pinChange`.
  `AdapterClient` (`web/shell/src/worker-rpc.ts`) routes it to a third
  listener set (`serialDataListeners`), parallel to `stateListeners`/
  `pinChangeListeners`; `SimClient` (`adapter-registry.ts`) declares
  `onSerialData?` as optional since not every adapter implements it
  (`rp2040` doesn't, see above).

**Where the byte actually comes from.** `Avr8Adapter.attachPeripherals()`
already constructed an `AVRUSART` (from `avr8js`) before this feature
existed — nothing used it. `AVRUSART.onByteTransmit` is a plain nullable
callback property that fires synchronously, unconditionally (confirmed
directly in `avr8js`'s `usart.ts`: it doesn't gate on `UCSRB`'s TXEN bit
— a deliberately simplified, not cycle-accurate, USART model) whenever
firmware writes to the `UDR` register, which is exactly what
`Serial.write()`/`Serial.print()` compile down to. `attachPeripherals()`
now wires `this.usart.onByteTransmit` to fan out to a `serialListeners`
set the same way `port.addListener()` already fanned pin changes out to
`pinListeners`. Read-only for now: `AVRUSART.writeByte()` exists for
injecting an RX byte (the direction a Serial Monitor's input box would
need), but nothing calls it — Stage 1 is transmit-only, matching what's
actually built.

**Surviving reset().** `reset()` replaces `this.cpu` and re-runs
`attachPeripherals()`, which constructs a *new* `AVRUSART` with its own
blank `onByteTransmit` — the wiring above happens inside
`attachPeripherals()` itself, not once at construction, specifically so
Serial output keeps flowing to the same subscribers across a reset
instead of silently going dark after the first Stop. `serialListeners`
itself (the outside world's subscriptions) is never cleared on reset,
the same way `pinListeners` isn't — only `lastPinValues`-style per-run
caches get wiped; a subscription is not per-run state. Covered directly
in `web/adapters/avr8/src/adapter.test.ts` (a `describe("Avr8Adapter
serial output")` block mirroring the existing pin-I/O tests' style:
`cpu.writeData(UDR_ADDRESS, ...)` drives the exact write hook real AVR
instructions would, without hand-assembling a firmware image).

**Line buffering.** `Terminal.writeByte()` drops `\r` and treats `\n` as
"the current line is done," appending characters to a lazily-created
line `<div>` as they arrive rather than buffering a whole line before
showing anything — a byte streaming in should read like a live terminal,
not something that only updates once a newline shows up. Capped at 500
completed lines (`MAX_LINES`), trimmed from the oldest end, so a
long-running sketch printing continuously doesn't grow the DOM (and the
page's memory) without bound — a rolling window, matching the sidebar
log's own spirit rather than a full transcript.

**Firmware loading (Stage 2).** The "Load .hex…" button (next to Apply)
reads a file, parses it with `parseIntelHex()` (`web/common/src/
intel-hex.ts` — adapter-agnostic on purpose, since the format itself has
nothing to do with AVR specifically; records `02`/`04`/`03`/`05`
handled, not just the `00`/`01` a 32KB image actually needs, and
checksums verified line by line), and calls a new `loadFirmware`
RPC method with the resulting bytes. `Avr8Adapter.loadFirmware()` is the
sole authority on the real flash size (the parser itself is only
handed a generous sanity ceiling, not a hardware limit, so one magic
number doesn't have to stay in sync across the process boundary): it
fills `program` with `0xffff` (erased-flash state, so a shorter second
load can't leave a previous load's stale instructions reachable past
the new one's end), packs the bytes into little-endian words, and calls
`this.reset()` — reusing the exact CPU-recreation path Stop already
uses, rather than duplicating it, so loading firmware reboots into it
the same way power-cycling a real board would. Verified end-to-end, not
just unit-by-unit: a hand-assembled 3-word program (`LDI r16, 'H'` /
`STS 0xc6, r16`, the encoding confirmed directly against `avr8js`'s own
instruction decoder) loaded through the real UI and produced a live
stream of `H` characters in the terminal once Started.

## Feature parity vs. velxio (davidmonterocrespo24/velxio)

velxio (velxio.dev) is the closest comparable project: an open-source,
browser-based Arduino/RP2040/ESP32 emulator built on the same two core
libraries physicalsim vendors (`avr8js`, `rp2040js`), plus `wokwi-elements`
for its components. Its docs (`/docs/emulator`, `/docs/roadmap`,
`/docs/components`) were reviewed 2026-07-24 to check what it has wired up
that physicalsim doesn't. Kept here, not just as a chat answer, because the
gap is concrete and actionable — it's a to-do list, not a vibe.

### What velxio has that physicalsim doesn't (yet)

*(Updated 2026-07-24 — ADC, SPI/I2C bus-level, Nano/Mega/RP2040 boards,
and EEPROM shipped since this section was first written; see "Shipped"
below. The bullets below are what's still actually open.)*

- **SPI/I2C device-specific decoding** for `ILI9341`, the SD card
  element, `SSD1306`, and `MPU6050` — `AVRSPI`/`AVRTWI` are constructed
  now (fixes the hang bug for all of them), and one I2C device
  (`DS1307`) has real protocol-level behavior, but these four still don't
  decode what a sketch actually sends them. I2C-mode `LCD1602`/`LCD2004`
  is the same story (today's LCD support is HD44780 4-bit parallel only,
  via `ProtocolChain`/`Hd44780Decoder` — a different, already-solid
  mechanism, just not the I2C variant).
- **RP2040 (Raspberry Pi Pico) I2C/SPI/PIO** — UART0 and GPIO26-29's ADC
  are wired now (see "Shipped"); `simulators/rp2040js/src/peripherals/`
  also ships `i2c.ts`, `spi.ts`, `pio.ts`, `dma.ts`, `usb.ts`, `rtc.ts`,
  all live the moment `new RP2040()` runs (it's a monolithic full-chip
  model) but not yet exposed through `Rp2040Adapter`'s own RPC surface.
- **ESP32-S3/C3 (Xtensa LX7 / RISC-V RV32IMC)** — velxio runs these
  through a QEMU fork bridged over WebSocket from a Python backend
  (ESP32-C3 also has a from-scratch TypeScript RV32IMC interpreter,
  `RiscVCore.ts`, used for ISA unit testing, not production). Plain
  ESP32 (Xtensa LX6) has since shipped in physicalsim, Worker-backed via
  `vecnode/esp32js` (see "ESP32 board and toolchain" below) - S3/C3
  remain a real gap, since `esp32js` only models plain ESP32 today.
- **Raspberry Pi 3 (ARM Cortex-A)** — unrelated to Arduino-shaped work,
  but in velxio's catalog via QEMU; physicalsim has no story for it at
  all, and would need either a QEMU-backed process (the shape this
  project has since moved away from for every board it actually ships)
  or a JS/TS Cortex-A core, neither of which exists yet.

**Other gaps, smaller:**

- **Serial RX** — `AVRUSART.writeByte()` (injecting a byte the CPU's
  `Serial.read()` would see) already exists in `avr8js` and is already
  noted as unused in the Serial Monitor section above; velxio's Serial
  Monitor supports sending input, physicalsim's is transmit-only.
- **Capacitor / Inductor** as placeable passive components (velxio has
  both; physicalsim only has Resistor/Potentiometer in that category).
- **Oscilloscope component** (plot analog pin voltage over time) — on
  velxio's roadmap, not shipped by either project. A land-first
  opportunity, same spirit as EEPROM was (see "Shipped" below — that one's
  done now, and velxio still doesn't have it).
- **Wire-level electrical validation** (short-circuit / invalid-connection
  detection) — velxio lists this as "in progress"; physicalsim's wires are
  logical routing only (see "Pin-to-pin wiring" above), same as velxio's
  shipped state today.
- **Product-surface features** (Monaco multi-file workspace, arduino-cli
  backend compile via FastAPI, cloud project persistence, auth, Library
  Manager, multiplayer): real velxio features, but SaaS/editor surface,
  not simulator core — physicalsim already has an equivalent in-app
  compiler (`POST /compile`, `src/avr_toolchain.cpp`) with a different,
  arguably stronger architecture (see below), so these aren't tracked here
  as gaps so much as a different product shape.

### Where physicalsim is already stronger

- **No backend process required for any of it.** velxio's own docs are
  explicit that ESP32/ESP32-S3/ESP32-C3/RPi3 emulation "requires the
  velxio backend to be running... not in a pure static frontend
  deployment" — those boards don't work in a self-contained build at all.
  Every board physicalsim ships (avr8/rp2040/esp32) runs entirely inside
  the webview's own JS engine — no separate server process, no network
  hop, no external emulator binary, works fully offline in one binary.
- **One uniform adapter interface, one execution model.** velxio bridges
  its QEMU-backed boards over a bespoke WebSocket protocol per chip
  family (`Esp32Bridge`, etc.); physicalsim's `SimulatorAdapter`/
  `SimClient` interface is implemented by every registered adapter the
  same Worker-backed way (see "One adapter kind: Worker-backed" above),
  so `adapter-registry.ts` and the UI don't know or care which chip
  they're talking to. Adding a Raspberry Pi 3/RISC-V board means a new
  adapter *package* (and, unlike ESP32, a JS/TS CPU core that doesn't
  exist yet for either architecture), not new UI-level plumbing.
- **An external automation surface velxio doesn't have.** The native
  `POST /bridge/:adapter/:method` HTTP surface (see "The native <-> JS
  bridge" above) lets an outside tool (droidcli) drive any adapter without
  going through a browser tab at all — velxio's WebSocket bridges are
  reached only from its own frontend.
- **Multi-pin protocol decoding verified against real vendored source, not
  general datasheet folklore.** `Hd44780Decoder` is checked line-by-line
  against `simulators/LiquidCrystal/src/LiquidCrystal.cpp`'s actual pulse
  sequence (nibble pairing, latch edge, priority-encoded instruction
  decode) and tested by replaying that exact sequence
  (`hd44780-decoder.test.ts`) — velxio's docs don't describe an equivalent
  verification methodology for its own component decoders.
- **Vendored, editable forks, not npm dependencies.** `avr8js`,
  `rp2040js`, and `iot-elements` are all `vecnode/*` git submodules
  physicalsim can patch directly (see the build pipeline note below on
  `useDefineForClassFields`) rather than being locked to whatever upstream
  publishes.
- **No account, no cloud, no lock-in.** Every velxio feature above the
  "Implemented" line in its roadmap that isn't board/peripheral emulation
  is auth, persistence, or collaboration tooling — a different product
  bet. physicalsim's single-binary, everything-local model is a
  deliberate tradeoff, not a gap to close.

### On "current"/AC-DC: what physicalsim models today, and what it doesn't

Neither project does analog circuit simulation. `web/shell/src/energy.ts`
(`computeEnergy()`) is explicitly a **nominal, not-solved** model — a
fixed idle/running mA lookup per board type (see its own header comment:
"Nominal values only, not solved from a real topology... there's no
wiring between components yet for anything Ohm's-law-shaped to apply
to"). It reports one number for "how much current this board draws," not
a per-wire or per-component current, and there is no AC modeling anywhere
— every board here is a DC logic-level MCU (5V or 3.3V rails), which is
also all velxio's docs describe (their wire system is digital/analog
*signal* routing with color-coded types, not a solved electrical network
either — "electrical signal routing and validation" is still "in
progress" on their own roadmap, not a SPICE-style solver). A real
per-component voltage/current readout — the natural target if "illustrate
current" means "show what's flowing through this wire" rather than "board
power draw" — would need a real topology solver (nodal/MNA-style, as
`energy.ts`'s own comment anticipates), which is a materially bigger,
separate project, not a peripheral-wiring task like ADC/SPI/I2C above.

### Shipped (2026-07-24, following the plan above)

Items 1-5 of the original plan landed in one pass:

- **AVR ADC** — `AVRADC` constructed in `Avr8Adapter.attachPeripherals()`;
  a new `writeAnalogPin?` capability on `SimulatorAdapter`
  (`adapter-types.ts`), routed end-to-end through a new `CircuitPin.
  writeAnalog()`, a new `componentAnalogPins` registry (`component-
  analog-pin.ts`, the analog counterpart to `componentSignalPins`), and a
  new `AnalogChain` (`analog-chain.ts`, structurally the same shape as
  `SignalChain`/`ProtocolChain`) wired into `main.ts`. Potentiometer,
  slide-potentiometer, and analog-joystick's VERT/HORZ now drive real
  `analogRead()` values. Covered by `adapter.test.ts`'s "Avr8Adapter
  analog input" block (a real ADMUX/ADCSRA/ADCL/ADCH register round trip,
  not just a channelValues-level check).
- **AVR SPI / I2C** — `AVRSPI` and `AVRTWI` are now constructed
  unconditionally in `attachPeripherals()`, which alone fixes every
  sketch that touches `SPI.transfer()`/`Wire.endTransmission()` from
  hanging forever (previously, writes to `SPDR`/`TWCR` had no
  `writeHooks` at all, so the completion flag those calls poll for never
  set). One concrete I2C device decoder shipped on top:
  **`DS1307Device`** (`ds1307.ts`), a real `TWIEventHandler` implementing
  the DS1307's actual register map (0x00-0x06 BCD clock/calendar,
  0x08-0x3F NVRAM), bound unconditionally at I2C address 0x68 (I2C is
  address-based, not wire-routed, so it doesn't need a placed-and-wired
  `wokwi-ds1307` element to be "on the bus" — the same reasoning Serial
  output doesn't depend on the Serial Monitor pane being open). Clock
  registers are computed live from the host machine's wall-clock time on
  every read (a documented simplification — `rtc.adjust()` acks correctly
  but doesn't stick); NVRAM genuinely round-trips. SSD1306/MPU6050/
  ILI9341/SD still have no device-specific decoder — the *bus* now works
  correctly for them (no more hangs), but nothing decodes what they'd be
  sent yet. Covered by `adapter.test.ts`'s "Avr8Adapter I2C (DS1307 RTC)"
  block, replaying the real Wire-library register sequence (START, SLA+W,
  pointer byte, repeated START, SLA+R) against avr8js's own TWI state
  machine.
- **Arduino Nano and Mega boards** — Nano was already fully registered
  (this doc undersold that). Mega needed more than a registry entry: it's
  a different chip (`ATmega2560`, 11 GPIO ports vs the Uno/Nano's 3, 256KB
  flash vs 32KB), so `Avr8Adapter` was refactored to take an `AvrChipConfig`
  (`chip.ts` — `ATMEGA328P`/`ATMEGA2560`) instead of hardcoding
  `portB`/`portC`/`portD`/`FLASH_WORDS`; a new `avr8-mega` `AdapterId` and
  `worker-mega.ts` entry point keep it from sharing a CPU instance with
  Uno/Nano's `avr8` (clients are cached one-per-id — two boards of a
  *different* chip sharing one would corrupt state, unlike Uno+Nano
  sharing `avr8` today, which is correct since they're the same chip).
  `boards/arduino-mega.ts`'s D0-D53/A0-A15 → port.bit pin map is the real
  ATmega2560 datasheet pinout, not derived from the Uno's. Mega's ADC is
  scoped to A0-A7 (`PORTF`) only — A8-A15 (`PORTK`) would need the
  `ADCSRB` MUX5 bit for a 16-channel ADC, which this fork's `adcConfig`
  doesn't model; a documented gap, not a silent one. Covered by
  `adapter.test.ts`'s "Avr8Adapter chip variants" block.

  **The sketch compiler needed the same chip-awareness.** CPU emulation
  alone wasn't enough for a real Mega example: `src/avr_toolchain.cpp`
  was hardcoded to `-mmcu=atmega328p` + ArduinoCore-avr's "standard"
  variant for every compile, so a sketch's `pinMode(13, ...)` always
  compiled down to the Uno's PB5 regardless of which board was actually
  placed - wiring an LED to a Mega's real D13 (PB7, per `arduino-mega.ts`
  above) would've stayed dark. Fixed by making the whole compile path
  board-aware: `avr_toolchain.cpp` gained `resolve_board_target()`
  (board string -> `{mcu, variant, define}` - Mega gets `atmega2560` +
  `variants/mega`), `POST /compile`'s body gained an optional `"board"`
  field, and `main.ts`'s `compileAndRun()` now sends whichever board is
  actually backing the active adapter. `ArduinoCore-avr/variants/mega`
  (a single `pins_arduino.h`, restored verbatim from upstream
  `arduino/ArduinoCore-avr` - it had been dropped in the original
  "cores/arduino + variants/standard only" trim) had to come back for
  this to even be possible; CMakeLists.txt's POST_BUILD copy step now
  bundles both variants unconditionally, the same "small enough to
  always ship" posture the trim already established.

  Verified end-to-end, not just unit-by-unit: built and ran the real
  packaged `physicalsim.exe` headless against its own bundled `avr-gcc`,
  compiled the same Blink sketch for both `arduino-uno` and
  `arduino-mega` via the real `/compile` endpoint, and confirmed the two
  resulting Intel HEX outputs genuinely differ (13128 vs 7284 hex-text
  bytes - Mega's larger core/vector table, not just a different byte or
  two) while an omitted `board` field still produces byte-identical
  output to an explicit `"arduino-uno"` (the pre-existing default
  preserved exactly). A new `"mega-blink"` example (`main.ts`'s
  `EXAMPLES`) exercises the same path end-to-end from the UI.
- **RP2040 UART + ADC, and a placeable RP2040 board** — `Rp2040Adapter`
  gained `onSerialData?` (wired to `mcu.uart[0].onByte` once in the
  constructor — RP2040 is one monolithic class whose peripherals survive
  `reset()`, unlike avr8's per-reset CPU recreation) and `writeAnalogPin?`
  (GPIO26-29 → `mcu.adc.channelValues[0..3]`, scaled against the Pico's
  3.3V reference — rp2040js's ADC stores raw 12-bit codes directly, unlike
  avr8js's voltage-based `channelValues`). Discovered along the way: no
  plain "Raspberry Pi Pico" element exists in the vendored
  `wokwi-elements` fork — the one RP2040-family element is `wokwi-nano-
  rp2040-connect` (Arduino Nano RP2040 Connect, Arduino-Nano-shaped D/A
  pin markers, not bare `GP<n>`). `boards/nano-rp2040-connect.ts`'s pin
  map comes straight from that element's own `pinInfo.description`
  fields (e.g. `D10` → `GPIO05`), not guessed. `rp2040-board.ts`'s
  existing generic `GP<n>` identity map was left alone (nothing placeable
  uses it; it exists for `board.test.ts`'s own coverage). Covered by
  `adapter.test.ts`'s "Rp2040Adapter analog input"/"serial output" blocks.
- **AVR EEPROM** — `AVREEPROM` + `EEPROMMemoryBackend`, sized per chip
  variant (1KB atmega328p / 4KB atmega2560, via `chip.ts`'s new
  `eepromBytes`). The backend is constructed once in the adapter's own
  constructor, not per-reset in `attachPeripherals()` — real EEPROM is
  battery-backed, so its contents survive Stop/Start, Reset, and even
  `loadFirmware()`'s reboot into a new sketch, matching real hardware.
  It does *not* survive this Worker being torn down (a full page reload)
  — in-memory only, a documented gap, not persisted to IndexedDB/disk.
  velxio still doesn't have this at all (their own roadmap: "planned:
  mid-term") — genuinely ahead here, not catching up. Covered by
  `adapter.test.ts`'s "Avr8Adapter EEPROM" block (real EECR/EEDR/EEARL/
  EEARH register round trip, including the erase-then-write semantics a
  real chip's `EEPROMMemoryBackend.writeMemory()`'s AND-not-assign
  behavior requires).
- **RP2040 I2C (DS1307)** — unlike avr8's SPI/TWI, `rp2040js`'s `RP2040`
  class already constructs I2C0/I2C1/SPI0/SPI1/PIO0/PIO1 unconditionally
  (`rp2040.ts`'s own `readonly i2c = [...]` etc.) — there was never a
  "bus hangs, nothing's wired" bug to fix here the way there was for
  avr8. What was missing was the same device-specific layer:
  `adapters/rp2040/src/ds1307.ts` is a second `DS1307Device`, a
  near-duplicate of avr8's own one, written against `RPI2C`'s different
  callback shape (`onStart`/`onConnect`/`onWriteByte`/`onReadByte`/
  `onStop` flat callbacks, vs. avr8js's `TWIEventHandler` interface
  object) — different enough APIs that sharing one implementation wasn't
  a clean fit, so this is deliberate duplication, not an oversight. Bound
  to I2C0 unconditionally in `Rp2040Adapter`'s constructor, same "address-
  based, not wire-routed" reasoning as the avr8 version. Covered by
  `ds1307.test.ts`, using a lightweight fake of the 5 callbacks
  `DS1307Device` actually touches rather than driving `RPI2C`'s own much
  larger DesignWare-style FIFO/register state machine.

All of the above passes `npm run typecheck` and `npm test` (69 tests) across
every workspace, and the app was smoke-tested in a running dev server with
zero console/build errors after each stage.

### Still open

- **Device-specific SPI decoders** for ILI9341 and the SD card element
  (avr8) — the bus-level hang bug is fixed (`AVRSPI` is constructed), but
  neither decodes what it's actually sent yet. Same shape of project as
  `DS1307Device`, against `AVRSPI`'s `onByte` hook instead of a
  `TWIEventHandler`.
- **SSD1306 / MPU6050 (I2C)** — same story, but these fit the exact
  `TWIEventHandler`/`RPI2C`-callback pattern `DS1307Device` already
  established on both adapters, so they're the more mechanical follow-up
  of the two SPI/I2C gaps above.
- **RP2040 PIO** — genuinely no AVR analog (PIO is RP2040-specific
  assembly-programmable state machines, used for things like WS2812/
  NeoPixel timing); `rp2040js`'s `pio.ts` is constructed and live, but
  nothing decodes a running PIO program's output yet. A real project on
  its own, not a small follow-up.
- **RP2040 board-placement parity** beyond GPIO/UART/ADC/I2C — no SPI
  exposure yet, and no second RP2040-family element exists in the
  vendored fork to place a "real" Pico with (see above).
- **A Raspberry Pi 3 (ARM Cortex-A) adapter**, if broader board coverage
  matters more than the peripheral depth just added — no JS/TS Cortex-A
  emulator exists to build one against the way `esp32js` now exists for
  ESP32, so this would mean either a from-scratch JS/TS core or falling
  back to a native QEMU-backed process, the shape this project has moved
  away from for every board it actually ships. A bigger lift than
  everything above either way.
- **ESP32-S3/C3** support, on top of the plain ESP32 (Xtensa LX6)
  `esp32js` already covers — a genuinely different CPU core (LX7 for S3,
  RISC-V RV32IMC for C3), not a config tweak on the existing adapter.
- **Wire-level electrical validation** (short-circuit / invalid-connection
  detection) and an **oscilloscope component** are both still open on
  velxio's own roadmap too — real, documented user-facing features either
  project could ship next, lower priority than the device decoders above.

## RP2040 sketch runtime (JS-native, no compiler)

**History, briefly.** A real-compile pipeline shipped 2026-07-24:
`arm-none-eabi-gcc` + a vendored, untrimmed `raspberrypi/pico-sdk` fork
(`vecnode/pico-sdk`), `src/rp2040_toolchain.cpp` producing a raw flash
image `rp2040js`'s `RP2040` class would `flash.set()` directly (no HEX/UF2
framing, simpler even than AVR's Intel HEX convention). It worked, and is
documented in git history if that approach is ever needed again - but it
meant a second, RP2040-specific C/C++ toolchain, a ~9MB vendored core, and
a from-scratch CMake configure on every "Compile & Run" click.

**What replaced it (2026-08-01).** Once `avr8js/arduino`'s pattern proved
out for AVR (interpret the sketch directly, no compiler - see "AVR sketch
runtime" below), the same approach replaced RP2040's real-compile pipeline
entirely: `rp2040js/pico` (a new module in the `rp2040js` fork, mirroring
`avr8js/arduino`'s shape) exposes `PicoRuntime` - GPIO pin state faithful
to real `gpio_init()`/`gpio_set_dir()`/`gpio_put()`/`gpio_get()` semantics
(confirmed against `raspberrypi/pico-sdk`'s own `gpio.c` - `gpio_init()`
genuinely resets direction+value, not just documentation, the same
verify-against-the-real-source discipline the original toolchain work
used) and a blocking `sleep_ms()`. `compileSketch()`/`createSketchGlobals()`
interpret a sketch's `setup()`/`loop()` via `new Function(...)` - no
compiler, no ARM Cortex-M0+ machine code, no `rp2040js` CPU core involved
at all for this path.

Sketches still use **pico-sdk's own C API names** (`gpio_init`,
`gpio_set_dir`, `gpio_put`, `gpio_get`, `sleep_ms`, `GPIO_IN`, `GPIO_OUT` -
real pico-sdk constants, not invented ones) inside the same `setup()`/
`loop()` shape - JS/TS syntax now (`function setup() {}`, not `void
setup(void) {}`), since a real C parser is out of scope, but the function
names/constants/semantics stay faithful to the real library, the same
posture `LiquidCrystal`'s JS port takes for AVR (see "Multi-pin protocols"
above).

`web/adapters/rp2040-js` (`Rp2040JsAdapter`) implements the same
`SimulatorAdapter` contract the real, cycle-accurate `rp2040` adapter
does - `nano-rp2040-connect`/`pi-pico`/`pi-pico-w`'s `boardAdapterId`
(`circuit.ts`) all point at `"rp2040-js"` directly (not a separate opt-in
board type) since there's no real-compile alternative left to fall back
to. The real `rp2040` adapter class is untouched (still plain JS/TS, no
C++) - it's simply unreachable from any board now, with nothing left that
produces a real ARM binary for it to execute.

**Removed:** `simulators/pico-sdk` (submodule), `src/rp2040_toolchain.cpp`/
`.hpp`, `src/rp2040_sketch_template/`, the `BUNDLE_ARM_TOOLCHAIN` CMake
option and its fetch/bundle steps. `/compile`'s RP2040 branch is gone -
`main.ts`'s `NO_COMPILER_ADAPTER_IDS` routes these boards away from that
endpoint before it's ever called.

## AVR sketch runtime (JS-native, no compiler)

Same story as RP2040 above, shipped the same day (2026-08-01), for every
AVR board: Uno, Nano, Mega, Leonardo, and Franzininho (ATtiny85) all run
through `avr8js/arduino`'s `ArduinoRuntime` now - `pinMode`/`digitalWrite`/
`digitalRead`/`analogRead`/`analogWrite`/`millis`/`delay`/`Serial`, the
real Arduino API names and semantics, interpreted directly via
`compileSketch()`, no `avr-gcc`, no vendored `ArduinoCore-avr`/
`ATTinyCore`/`LiquidCrystal`.

`web/adapters/avr8-js` (`Avr8JsAdapter`) is parameterized by pin shape
(`{digitalPinCount, analogPinCount}`) rather than one class per chip -
Uno/Nano/Leonardo share the default (14+6, D0-D13/A0-A5); Mega gets its
own worker entry point (`worker-mega.ts`, 54+16, D0-D53/A0-A15) since
clients are cached one per `AdapterId` and an Uno/Mega sharing one runtime
would be shaped for neither correctly. Franzininho is a separate, small
`Avr8JsAttiny85Adapter` class instead of a third pin shape: ATtiny85's
real Arduino numbering (0-5 mapping directly onto PB0-PB5) doesn't follow
the D`<n>`/A`<n>` convention the ATmega-family boards share at all.

`LiquidCrystal` sketches (`new LiquidCrystal(rs, enable, d4, d5, d6, d7)`)
work identically to real Arduino - `avr8js/arduino`'s `LiquidCrystal`
class is a line-for-line port of the real `LiquidCrystal.cpp`'s
`write4bits()`/`pulseEnable()` logic, bit-banging RS/E/D4-D7 in the exact
same order, so the existing `Hd44780Decoder` (see "Multi-pin protocols"
above) needed zero changes - it was always adapter-agnostic, decoding
whatever toggles those six pins, real CPU or this JS class alike.

**Removed:** `simulators/ArduinoCore-avr`, `simulators/ATTinyCore`,
`simulators/LiquidCrystal` (submodules), `src/avr_toolchain.cpp`/`.hpp`,
the `BUNDLE_AVR_TOOLCHAIN` CMake option and its fetch/bundle steps.
`/compile`'s AVR fallback now cleanly returns 501 ("no C/C++ compiler
backs this board") instead of attempting a compile that can no longer
succeed - nothing valid reaches it; every AVR/RP2040 board is routed away
by `NO_COMPILER_ADAPTER_IDS` before the endpoint is ever called.

## ESP32 sketch runtime (JS-native, no compiler)

**History, briefly.** A real-compile pipeline shipped 2026-07-25: a
vendored, untrimmed `espressif/esp-idf` fork (`vecnode/esp-idf`, pinned
to `v5.3.1`) plus a fetched `xtensa-esp-elf-gcc` toolchain,
`src/esp32_toolchain.cpp` driving a real `cmake -G Ninja` + `ninja`
build of ESP-IDF's full component tree (bootloader, partition table,
`nvs_flash`, `lwip`, dozens more - none of it trimmed) for every "Compile
& Run" click, producing a real Xtensa ELF that `esp32js`'s `Board` class
(a `Cpu`+`SystemBus` pair for the Xtensa LX6 ESP32) executed cycle-
accurately via `loadElf()`. It worked - verified end-to-end with two
genuinely blinking LEDs through the real UI - and is documented in git
history if that approach is ever needed again, but it meant the single
heaviest toolchain this project carried: a ~590MB submodule (plus its own
nested submodules - FreeRTOS-Kernel, mbedtls, and more), a separately
fetched Xtensa gcc, and a Python/`cmake`/`ninja` environment that only
ever resolved on a dev machine, never bundled.

**What replaced it (2026-08-01).** Same move `avr8js/arduino` and
`rp2040js/pico` already made (see "RP2040 sketch runtime" and "AVR
sketch runtime" above): interpret the sketch directly, no compiler.
`esp32js/espidf` (a new module in the `esp32js` fork) exposes
`EspIdfRuntime` - GPIO pin state faithful to real ESP-IDF `gpio_config()`/
`gpio_set_level()`/`gpio_get_level()` semantics (a pin's direction is
whatever the most recent `gpio_config()` call covering it set, undefined-
direction pins default to `'input'` matching real hardware reset state)
and a blocking `vTaskDelay()`. `compileSketch()`/`createSketchGlobals()`
interpret a sketch's `setup()`/`loop()` via `new Function(...)` - no
compiler, no Xtensa machine code, no `esp32js` CPU core involved at all
for this path.

Sketches still use **real ESP-IDF C API names** (`gpio_config`,
`gpio_set_level`, `gpio_get_level`, `vTaskDelay`, `portTICK_PERIOD_MS`,
`GPIO_MODE_OUTPUT` - real ESP-IDF constants, not invented ones) inside
the same `setup()`/`loop()` shape - JS/TS syntax now (`function setup()
{}`, not `void app_main(void) {}`), since a real C parser is out of
scope, but the function names/constants/semantics stay faithful to the
real framework, the same posture `rp2040js/pico`'s pico-sdk names take.

`web/adapters/esp32-js` (`Esp32JsAdapter`) implements the same
`SimulatorAdapter` contract the real, cycle-accurate `esp32` adapter did.
One class backs all three ESP32 boards - `esp32-devkit-v1`/
`esp32-devkit-c-v4`/`esp32-cam`'s `boardAdapterId` (`circuit.ts`) all
point at `"esp32-js"` directly, accepting either `"D<n>"` (`esp32-devkit-
v1`'s own board map convention) or a bare `"<n>"` (`esp32-devkit-c-v4`/
`esp32-cam`'s real bare-GPIO-number silkscreens) pin id, both resolving
to the same GPIO index. `writeAnalogPin` throws (`"not an ADC-capable
pin"`) - no ADC modeled yet in this JS-native runtime, a real documented
gap rather than a silent no-op.

**Removed:** `simulators/esp-idf` (submodule), `src/esp32_toolchain.cpp`/
`.hpp`, `src/process_exec.cpp`/`.hpp` (esp-idf's own dedicated subprocess
runner - no other toolchain used it), `src/esp32_sketch_template/`, the
`BUNDLE_ESP_IDF`/`BUNDLE_XTENSA_TOOLCHAIN` CMake options and their fetch/
bundle steps, and the old cycle-accurate `web/adapters/esp32` package.
`/compile` itself is gone entirely (`src/main.cpp`) - ESP32 was the last
board still using it; every board now interprets its sketch directly via
its own adapter's `loadFirmware()`, no C/C++ toolchain, no `/compile`
round-trip at all (see `main.ts`'s `compileAndRun()`).

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
