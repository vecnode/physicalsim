import { IntelHexParseError, parseIntelHex, type SimState } from "@physicalsim/common";
import { getAdapterClient, type AdapterId } from "./adapter-registry.js";
import { boardPowerSetter } from "./circuit.js";
import { computeEnergy, type BoardEnergy } from "./energy.js";
import { SignalChain } from "./signal-chain.js";
import { CanvasController } from "./canvas/index.js";
import { Terminal } from "./terminal.js";
import { SketchEditor } from "./sketch-editor.js";
import "./native-bridge.js";
// Side-effect only: registers every <wokwi-*> custom element (Lit's
// @customElement decorator calls customElements.define() when each
// class is defined, i.e. on module evaluation). Pulls in the whole
// vendored library for now, not just Arduino Uno - fine at this scale,
// worth trimming to a narrower import if bundle size becomes a concern
// once more boards are wired up.
import "@wokwi/elements";

const adapterSelect = document.getElementById("adapter-select") as HTMLSelectElement;
const applyBtn = document.getElementById("apply-btn") as HTMLButtonElement;
const startBtn = document.getElementById("start-btn") as HTMLButtonElement;
const pauseBtn = document.getElementById("pause-btn") as HTMLButtonElement;
const stopBtn = document.getElementById("stop-btn") as HTMLButtonElement;
const stateRunning = document.getElementById("state-running") as HTMLElement;
const stateCycles = document.getElementById("state-cycles") as HTMLElement;
const statePc = document.getElementById("state-pc") as HTMLElement;
const energyVoltage = document.getElementById("energy-voltage") as HTMLElement;
const energyCurrent = document.getElementById("energy-current") as HTMLElement;
const energyPower = document.getElementById("energy-power") as HTMLElement;
const log = document.getElementById("log") as HTMLElement;

function logLine(text: string): void {
  log.textContent = text;
}

// -----------------------------------------------------------------------
// Canvas (tab 1): everything about placing/dragging/wiring boards and
// components lives in ./canvas - this file only plugs a placed board
// into its SimulatorAdapter and drives the energy readout, neither of
// which the canvas module knows anything about.
// -----------------------------------------------------------------------

const canvas = new CanvasController({
  container: document.getElementById("canvas-tab1") as HTMLElement,
  content: document.getElementById("tab1-content") as HTMLElement,
  zoomOutBtn: document.getElementById("zoom-out-btn") as HTMLButtonElement,
  zoomInBtn: document.getElementById("zoom-in-btn") as HTMLButtonElement,
  zoomResetBtn: document.getElementById("zoom-reset-btn") as HTMLButtonElement,
  zoomLevelEl: document.getElementById("zoom-level") as HTMLElement,
  minimapPanel: document.getElementById("minimap") as HTMLElement,
  minimapItems: document.getElementById("minimap-items") as HTMLElement,
  minimapViewport: document.getElementById("minimap-viewport") as HTMLElement,
  minimapWidthReference: document.querySelector(".zoom-controls") as HTMLElement,
});

// Serial Monitor (web/shell/src/terminal.ts) - Stage 1 of the terminal
// feature (see ARCHITECTURE.md): read-only display of whatever the
// active adapter's UART transmits. Constructed here (not inside
// CanvasController) since it isn't part of the board-placement canvas -
// it's tied to whichever *adapter* is being watched, the same thing
// apply()/setPowered() below already are.
const terminal = new Terminal({
  panel: document.getElementById("terminal-panel") as HTMLElement,
  output: document.getElementById("terminal-output") as HTMLElement,
  collapseBtn: document.getElementById("terminal-collapse-btn") as HTMLButtonElement,
  clearBtn: document.getElementById("terminal-clear-btn") as HTMLButtonElement,
});

let unsubscribe: (() => void) | null = null;
let unsubscribeSerial: (() => void) | null = null;
// The adapter the Start/Pause/Stop controls act on. Only changes
// when Apply is clicked - picking a different item in the dropdown alone
// does not switch anything, so a control click always applies to the
// adapter you last confirmed, not whatever the select happens to show.
// Starts (and, for now, stays) null: avr8/rp2040/cortex-m are parked out
// of the dropdown - see index.html - so there's no running adapter to
// attach to until Arduino Uno gets wired to one.
let activeAdapterId: AdapterId | null = null;

// A second, separate model from the circuit itself - see energy.ts.
// Keyed by CircuitBoard.id, same reasoning as circuit.ts's own
// separation of concerns: this file doesn't reach into canvas/scene.ts's
// internals for it.
const energy = new Map<string, BoardEnergy>();

function renderEnergy(e: BoardEnergy): void {
  energyVoltage.textContent = `${e.voltage.toFixed(1)} V`;
  energyCurrent.textContent = `${e.currentMa} mA`;
  energyPower.textContent = `${Math.round(e.voltage * e.currentMa)} mW`;
}

// Recomputes and re-renders energy for whichever placed board is backed
// by the active adapter - called from setPowered() (on power change) and
// from renderState() (on every stateChange, so current draw tracks
// running vs. idle without any new adapter-side plumbing).
function updateEnergy(running: boolean): void {
  const board = canvas.scene.findBoardByAdapter(activeAdapterId ?? "");
  if (!board) return;
  const e = computeEnergy(board, running);
  energy.set(board.id, e);
  renderEnergy(e);
}

function renderState(state: SimState): void {
  stateRunning.textContent = state.running ? "running" : "stopped";
  stateCycles.textContent = String(state.cycles);
  const pc = typeof state.pc === "number" ? state.pc : 0;
  statePc.textContent = "0x" + pc.toString(16);
  updateEnergy(state.running);
}

function apply(id: AdapterId): void {
  unsubscribe?.();
  unsubscribeSerial?.();
  activeAdapterId = id;
  const client = getAdapterClient(id);
  unsubscribe = client.onStateChange(renderState);
  // onSerialData is optional on SimClient (see adapter-registry.ts) -
  // only avr8 implements it today. Guarding on the capability itself,
  // rather than calling "subscribeSerial" unconditionally, avoids an RPC
  // round-trip to an adapter kind that would just throw
  // "does not support onSerialData" (see worker-host.ts).
  if (client.onSerialData) {
    unsubscribeSerial = client.onSerialData((byte) => terminal.writeByte(byte));
    void client.call("subscribeSerial");
  } else {
    unsubscribeSerial = null;
  }
  logLine(`watching ${id} (native bridge can drive it too)`);
}

// Plugs a newly-placed board into its adapter, from either Apply or the
// canvas's own right-click "Boards" menu - Scene fires this without
// knowing anything about SimulatorAdapter/apply() itself.
canvas.scene.onBoardPlaced((board) => apply(board.adapterId));

// Bridges canvas wiring to real pin I/O - a pushbutton wired to a board
// pin can now drive it, and an LED wired to one reflects it. Constructed
// once; it subscribes to the scene's own wiring changes and needs no
// further wiring from this file (see signal-chain.ts).
new SignalChain(canvas.scene, getAdapterClient);

// If the board currently backing the active adapter gets deleted
// (Backspace/Delete - see canvas/index.ts), the Start/Pause/Stop
// readouts shouldn't keep pointing at it.
canvas.scene.onEntityDeleted((entity) => {
  if ("adapterId" in entity && entity.adapterId === activeAdapterId) {
    unsubscribe?.();
    unsubscribe = null;
    unsubscribeSerial?.();
    unsubscribeSerial = null;
    activeAdapterId = null;
    stateRunning.textContent = "idle";
    stateCycles.textContent = "0";
    statePc.textContent = "0x0";
    renderEnergy({ boardId: entity.id, voltage: 0, currentMa: 0 });
    terminal.clear();
    logLine("board removed");
  }
});

applyBtn.addEventListener("click", () => {
  const value = adapterSelect.value;
  // "Arduino Uno" is a board illustration, not a running SimulatorAdapter -
  // it isn't in the AdapterId union and never reaches getAdapterClient().
  // Selecting it just places the board on tab 1; it doesn't touch
  // start/pause/stop or any of the avr8/rp2040/cortex-m machinery.
  if (value === "arduino-uno") {
    showTab("tab1");
    void canvas.scene.showBoard("arduino-uno");
    return;
  }
  apply(value as AdapterId);
});

function activeClient() {
  return activeAdapterId ? getAdapterClient(activeAdapterId) : null;
}

// Start/Pause/Stop are "power the circuit": Start and Stop flip .powered
// on whichever placed board is backed by the active adapter and reflect
// that on its element (the board's power-supply LED, independent of any
// GPIO pin - see circuit.ts); Pause doesn't touch power at all. No-ops
// safely via activeClient()'s null check if nothing is plugged in yet.
//
// Pause vs. Stop is a real distinction, not just two names for the same
// thing: the adapter's own "stop" RPC method only halts ticking - it
// never resets CPU state (see e.g. Avr8Adapter.stop() in
// web/adapters/avr8/src/adapter.ts, which just clears the tick timer).
// So Pause = call "stop" and leave it there: execution halts mid-program,
// state intact, Start resumes exactly where it left off - like a real
// board's power staying on while halted at a breakpoint. Stop = call
// "reset" instead (which itself calls "stop" first, then wipes the CPU
// back to power-on defaults) *and* turn the power LED off - matching
// what actually happens to a real board's SRAM when it loses power for
// real, not just pauses.
startBtn.addEventListener("click", () => {
  void activeClient()?.call("start");
  setPowered(true);
});
pauseBtn.addEventListener("click", () => void activeClient()?.call("stop"));
stopBtn.addEventListener("click", () => {
  void activeClient()?.call("reset");
  setPowered(false);
  // A real reset wipes CPU state (see the comment above) - stale Serial
  // output from before the reset shouldn't linger as if it were still
  // relevant.
  terminal.clear();
});

// Powers (or unpowers) whichever placed board is backed by the active
// adapter. Reflects onto the element via boardPowerSetter (board-type-
// specific: Arduino Uno's power LED, for instance).
function setPowered(on: boolean): void {
  const board = canvas.scene.findBoardByAdapter(activeAdapterId ?? "");
  if (!board) return;
  board.powered = on;
  const dom = canvas.scene.getDom(board.id);
  if (dom) boardPowerSetter[board.type]?.(dom.boardEl, on);
  // Running state isn't known yet here - start()/reset() are async RPC
  // calls that haven't resolved. Snapshot as "not running" for now; the
  // next stateChange (renderState -> updateEnergy) corrects it once the
  // adapter actually confirms it's ticking.
  updateEnergy(false);
}

// -----------------------------------------------------------------------
// Firmware loading (Stage 2 of the terminal feature - see
// ARCHITECTURE.md's "Firmware loading" section): load a compiled Intel
// HEX file into the active adapter's flash and reboot into it.
// -----------------------------------------------------------------------

const loadFirmwareBtn = document.getElementById("load-firmware-btn") as HTMLButtonElement;
const firmwareFileInput = document.getElementById("firmware-file-input") as HTMLInputElement;

// A generous sanity ceiling for *parsing* - not a real hardware limit.
// The adapter itself (Avr8Adapter.loadFirmware()) is the sole authority
// on the actual flash size and rejects with a specific error if the
// parsed image is too large for it; this just keeps parseIntelHex()
// from being handed an unbounded size for a pathological input file.
const FIRMWARE_PARSE_SANITY_LIMIT_BYTES = 1024 * 1024;

loadFirmwareBtn.addEventListener("click", () => {
  if (!activeClient()) {
    logLine("place a board (Apply) before loading firmware");
    return;
  }
  firmwareFileInput.click();
});

firmwareFileInput.addEventListener("change", () => {
  const file = firmwareFileInput.files?.[0];
  firmwareFileInput.value = ""; // allow re-selecting the same file next time
  if (file) void loadFirmwareFile(file);
});

async function loadFirmwareFile(file: File): Promise<void> {
  const client = activeClient();
  if (!client) {
    logLine("place a board (Apply) before loading firmware");
    return;
  }

  let bytes: Uint8Array;
  try {
    const text = await file.text();
    const parsed = parseIntelHex(text, FIRMWARE_PARSE_SANITY_LIMIT_BYTES);
    // parseIntelHex() always returns a buffer the full sanity-limit size,
    // padded with 0xff past whatever the file actually specified -
    // trimmed here so the adapter only ever sees the meaningful part
    // (and doesn't reject a small, valid file for looking "too large"
    // because of that padding).
    bytes = parsed.bytes.slice(0, parsed.usedBytes);
  } catch (err) {
    logLine(err instanceof IntelHexParseError ? err.message : `couldn't read "${file.name}"`);
    return;
  }

  try {
    await client.call("loadFirmware", bytes);
    terminal.clear();
    // The Serial Monitor, not the sidebar log - firmware loading is
    // about what's about to run on the board, the same place its output
    // shows up, not a one-line status that gets overwritten by the next
    // unrelated update.
    terminal.writeLine(`${file.name} loaded (${bytes.length} bytes)`);
  } catch (err) {
    logLine(err instanceof Error ? err.message : "firmware load failed");
  }
}

// -----------------------------------------------------------------------
// Sketch compiling: a real code editor (Monaco - src/sketch-editor.ts) +
// "Compile & Run" (index.html's .sketch-panel). Posts to the native
// shell's own POST /compile (src/avr_toolchain.cpp, which shells out to a
// bundled/system avr-gcc + the vendored ArduinoCore-avr), then feeds the
// resulting hex text through the exact same
// parseIntelHex() -> loadFirmware() path loadFirmwareFile() above uses -
// compiling only ever produces the same kind of bytes "Load .hex…"
// already consumes.
// -----------------------------------------------------------------------

// Pre-filled, not an empty editor - Compile & Run should do something
// meaningful the first time it's clicked, not fail on an empty sketch.
const DEFAULT_SKETCH = `void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(1000);
  digitalWrite(LED_BUILTIN, LOW);
  delay(1000);
}`;

const sketchEditor = new SketchEditor(
  document.getElementById("sketch-editor") as HTMLElement,
  DEFAULT_SKETCH,
);
const compileRunBtn = document.getElementById("compile-run-btn") as HTMLButtonElement;

interface CompileResponse {
  ok: boolean;
  hexText?: string;
  log: string;
}

compileRunBtn.addEventListener("click", () => void compileAndRun());

async function compileAndRun(): Promise<void> {
  const client = activeClient();
  if (!client) {
    logLine("place a board (Apply) before compiling");
    return;
  }
  const source = sketchEditor.getValue();
  if (!source.trim()) {
    logLine("sketch is empty");
    return;
  }

  compileRunBtn.disabled = true;
  try {
    const res = await fetch("/compile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source }),
    });
    const body = (await res.json()) as CompileResponse;

    if (!body.ok) {
      terminal.clear();
      terminal.writeLine(`compile failed:\n${body.log || "(no compiler output)"}`);
      return;
    }

    const parsed = parseIntelHex(body.hexText ?? "", FIRMWARE_PARSE_SANITY_LIMIT_BYTES);
    const bytes = parsed.bytes.slice(0, parsed.usedBytes);
    await client.call("loadFirmware", bytes);
    terminal.clear();
    terminal.writeLine(`sketch compiled and loaded (${bytes.length} bytes)`);
  } catch (err) {
    terminal.clear();
    terminal.writeLine(err instanceof Error ? `compile error: ${err.message}` : "compile failed");
  } finally {
    compileRunBtn.disabled = false;
  }
}

// -----------------------------------------------------------------------
// Tabs: tab 1 holds the interactive canvas above; tabs 2/3 are
// intentionally blank panes (no canvas, no content) - future workspaces
// with nothing built yet, not placeholders drawing a grid no one uses.
// -----------------------------------------------------------------------

const boardTabs = document.getElementById("board-tabs") as HTMLElement;
const tabPanes = new Map<string, HTMLElement>();
for (const pane of document.querySelectorAll<HTMLElement>(".tab-pane")) {
  const tab = pane.dataset.tab;
  if (tab) tabPanes.set(tab, pane);
}

function showTab(tab: string): void {
  for (const [name, pane] of tabPanes) pane.classList.toggle("active", name === tab);
  for (const btn of boardTabs.querySelectorAll<HTMLButtonElement>(".tab-btn")) {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  }
  // Switching back to tab1 from tab2/tab3: the minimap/zoom-controls were
  // display:none (zero size) the whole time they were hidden, so their
  // ResizeObserver may not have anything useful to report until they're
  // actually visible again - resync explicitly rather than rely on it.
  if (tab === "tab1") canvas.refresh();
}

boardTabs.addEventListener("click", (ev) => {
  const target = (ev.target as HTMLElement).closest<HTMLButtonElement>(".tab-btn");
  if (target?.dataset.tab) showTab(target.dataset.tab);
});

showTab("tab1");

// -----------------------------------------------------------------------
// Bottom bar: terminal, rotate, link-style, chrome-visibility, and theme
// toggles.
// -----------------------------------------------------------------------

// Shows/hides the Serial Monitor entirely (visible by default) -
// persisted like chrome-hidden/theme below, since this is meant to stay
// set while working, not reset on every reload. Separate from the
// terminal's own collapse button (Terminal.setCollapsed()): this hides
// it completely, that just shrinks it to its header.
const TERMINAL_HIDDEN_STORAGE_KEY = "physicalsim-terminal-hidden";
const terminalToggleBtn = document.getElementById("terminal-toggle-btn") as HTMLButtonElement;

let terminalHidden = localStorage.getItem(TERMINAL_HIDDEN_STORAGE_KEY) === "true";
terminal.setVisible(!terminalHidden);

terminalToggleBtn.addEventListener("click", () => {
  terminalHidden = !terminalHidden;
  localStorage.setItem(TERMINAL_HIDDEN_STORAGE_KEY, String(terminalHidden));
  terminal.setVisible(!terminalHidden);
});

// Rotates whichever board/component is currently selected 90 degrees
// clockwise (canvas/scene.ts's rotateSelected()) - works for sensors and
// connections the same way it does for boards, since rotation lives on
// the shared CircuitBoard/PlacedComponent shape, not anything board-
// specific.
const rotateBtn = document.getElementById("rotate-btn") as HTMLButtonElement;
rotateBtn.addEventListener("click", () => canvas.scene.rotateSelected());

// Cycles how every wire is drawn (straight/elbow/bezier - see
// canvas/wiring.ts's LinkStyle) - a global setting, applying to every
// existing wire immediately, not just ones drawn after the click. Not
// persisted (unlike chrome-hidden/theme below) - this one's more of an
// in-session drawing preference than a lasting UI setting.
const linkStyleBtn = document.getElementById("link-style-btn") as HTMLButtonElement;
const linkStyleIcons = {
  straight: document.getElementById("link-icon-straight") as HTMLElement,
  elbow: document.getElementById("link-icon-elbow") as HTMLElement,
  bezier: document.getElementById("link-icon-bezier") as HTMLElement,
};

function renderLinkStyleIcon(): void {
  const style = canvas.scene.wiring.getStyle();
  for (const [name, icon] of Object.entries(linkStyleIcons)) icon.hidden = name !== style;
  linkStyleBtn.title = `Link style: ${style} (click to cycle)`;
}

renderLinkStyleIcon();
linkStyleBtn.addEventListener("click", () => {
  canvas.scene.wiring.cycleStyle();
  renderLinkStyleIcon();
});

// Hides/shows the simulator panel and the zoom-controls/minimap overlay,
// leaving just the bare canvas - useful once a circuit is laid out and
// the controls are just in the way. Persisted like the theme, since this
// is meant to stay set while working, not reset on every reload.
const CHROME_HIDDEN_STORAGE_KEY = "physicalsim-chrome-hidden";
const panelToggleBtn = document.getElementById("panel-toggle-btn") as HTMLButtonElement;
const panelIconVisible = document.getElementById("panel-icon-visible") as HTMLElement;
const panelIconHidden = document.getElementById("panel-icon-hidden") as HTMLElement;

function applyChromeHidden(hidden: boolean): void {
  document.documentElement.classList.toggle("chrome-hidden", hidden);
  // Icon shows what clicking the button switches *to*, not the current
  // state - matches the theme toggle's own convention below.
  panelIconVisible.hidden = hidden;
  panelIconHidden.hidden = !hidden;
  // The zoom controls/minimap go display:none while hidden - re-sync
  // once they're shown again, same reasoning as the tab-switch case
  // above.
  if (!hidden) canvas.refresh();
}

const storedChromeHidden = localStorage.getItem(CHROME_HIDDEN_STORAGE_KEY) === "true";
applyChromeHidden(storedChromeHidden);

panelToggleBtn.addEventListener("click", () => {
  const next = !document.documentElement.classList.contains("chrome-hidden");
  localStorage.setItem(CHROME_HIDDEN_STORAGE_KEY, String(next));
  applyChromeHidden(next);
});

// Theme toggle: light/dark for the chrome only - the canvas stays
// --canvas-bg regardless (see style.css). Persisted so it survives a
// reload, since this is meant to stay set while developing against the
// app repeatedly, not reset itself every time.
const THEME_STORAGE_KEY = "physicalsim-theme";
const themeToggleBtn = document.getElementById("theme-toggle-btn") as HTMLButtonElement;
const themeIconLight = document.getElementById("theme-icon-light") as HTMLElement;
const themeIconDark = document.getElementById("theme-icon-dark") as HTMLElement;

function applyTheme(theme: "light" | "dark"): void {
  if (theme === "dark") document.documentElement.dataset.theme = "dark";
  else delete document.documentElement.dataset.theme;
  // Icon shows what clicking the button switches *to*, not the current
  // state - a moon while light (click to go dark), a sun while dark.
  themeIconLight.hidden = theme === "dark";
  themeIconDark.hidden = theme !== "dark";
  // Monaco has its own theme concept, independent of the CSS variables
  // the rest of the chrome uses - kept in sync here so the editor doesn't
  // look inconsistent with everything around it.
  sketchEditor.setTheme(theme);
}

const storedTheme = localStorage.getItem(THEME_STORAGE_KEY);
applyTheme(storedTheme === "dark" ? "dark" : "light");

themeToggleBtn.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_STORAGE_KEY, next);
  applyTheme(next);
});

// -----------------------------------------------------------------------
// Sidebar resize: drag #sidebar-resize-handle to change .sidebar's width -
// persisted like the theme/chrome-hidden toggles above, since this is
// meant to stay set while working, not reset on every reload.
// -----------------------------------------------------------------------

const SIDEBAR_WIDTH_STORAGE_KEY = "physicalsim-sidebar-width";
const SIDEBAR_MIN_WIDTH = 260;
const SIDEBAR_MAX_WIDTH = 720;

const sidebarEl = document.querySelector(".sidebar") as HTMLElement;
const sidebarResizeHandle = document.getElementById("sidebar-resize-handle") as HTMLElement;

function applySidebarWidth(width: number): void {
  const clamped = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
  sidebarEl.style.width = `${clamped}px`;
  // Monaco's automaticLayout (a ResizeObserver internally) isn't a
  // reliable signal in every host/embedding - see sketch-editor.ts's own
  // layout() doc comment - so this is told explicitly rather than trusted
  // to notice the width change on its own.
  sketchEditor.layout();
}

const storedSidebarWidth = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
if (storedSidebarWidth > 0) applySidebarWidth(storedSidebarWidth);

sidebarResizeHandle.addEventListener("mousedown", (ev) => {
  ev.preventDefault();
  sidebarResizeHandle.classList.add("dragging");
  const startX = ev.clientX;
  const startWidth = sidebarEl.getBoundingClientRect().width;

  const onMouseMove = (moveEv: MouseEvent): void => {
    applySidebarWidth(startWidth + (moveEv.clientX - startX));
  };
  const onMouseUp = (): void => {
    sidebarResizeHandle.classList.remove("dragging");
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarEl.getBoundingClientRect().width));
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
  };
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
});
