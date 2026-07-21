import type { SimState } from "@physicalsim/common";
import type { LitElement } from "lit";
import { getAdapterClient, type AdapterId } from "./adapter-registry.js";
import {
  boardPowerSetter,
  boardTagName,
  createBoard,
  type Circuit,
  type CircuitBoard,
} from "./circuit.js";
import { computeEnergy, type BoardEnergy } from "./energy.js";
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

let unsubscribe: (() => void) | null = null;
// The adapter the Start/Pause/Stop controls act on. Only changes
// when Apply is clicked - picking a different item in the dropdown alone
// does not switch anything, so a control click always applies to the
// adapter you last confirmed, not whatever the select happens to show.
// Starts (and, for now, stays) null: avr8/rp2040/cortex-m are parked out
// of the dropdown - see index.html - so there's no running adapter to
// attach to until Arduino Uno gets wired to one.
let activeAdapterId: AdapterId | null = null;

function renderState(state: SimState): void {
  stateRunning.textContent = state.running ? "running" : "stopped";
  stateCycles.textContent = String(state.cycles);
  const pc = typeof state.pc === "number" ? state.pc : 0;
  statePc.textContent = "0x" + pc.toString(16);
  // Every stateChange already fires continuously while running - the
  // natural place to nudge current draw from "idle" to "running" once
  // ticking actually starts, no new adapter-side plumbing needed.
  updateEnergy(state.running);
}

function logLine(text: string): void {
  log.textContent = text;
}

function apply(id: AdapterId): void {
  unsubscribe?.();
  activeAdapterId = id;
  const client = getAdapterClient(id);
  unsubscribe = client.onStateChange(renderState);
  logLine(`watching ${id} (native bridge can drive it too)`);
}

applyBtn.addEventListener("click", () => {
  const value = adapterSelect.value;
  // "Arduino Uno" is a board illustration, not a running SimulatorAdapter -
  // it isn't in the AdapterId union and never reaches getAdapterClient().
  // Selecting it just places the board on tab 1; it doesn't touch
  // start/pause/stop or any of the avr8/rp2040/cortex-m machinery.
  if (value === "arduino-uno") {
    void showBoard("arduino-uno");
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
});

// -----------------------------------------------------------------------
// Board workspace: a tab bar on the right, one pane per tab - generic
// tabs, not tied to a specific simulator (see index.html's data-tab
// values). Tab 1 also holds the "Simulator" panel (moved out of the
// sidebar - see index.html) alongside its design surface, filling the
// rest of the pane; showBoard() below places a real board element onto
// it. Tabs 2/3 stay full-bleed placeholder <canvas> elements - no scene,
// no interaction; unaffected by the DOM-based rewrite below, which is
// scoped entirely to tab 1.
// -----------------------------------------------------------------------

const boardTabs = document.getElementById("board-tabs") as HTMLElement;
const tabPanes = new Map<string, HTMLElement>();
// Only tabs 2/3 have a real <canvas> - tab 1's ".board-canvas" is a <div>
// now (see below), so this tag-qualified selector naturally excludes it.
const boardCanvases = new Map<string, HTMLCanvasElement>();
for (const pane of document.querySelectorAll<HTMLElement>(".tab-pane")) {
  const tab = pane.dataset.tab;
  if (!tab) continue;
  tabPanes.set(tab, pane);
  const canvas = pane.querySelector<HTMLCanvasElement>("canvas.board-canvas");
  if (canvas) boardCanvases.set(tab, canvas);
}

// Matches .board-canvas-interactive's CSS grid in style.css (tab 1, a
// <div>) - kept as pixel-drawn grid lines here since tabs 2/3 are real
// <canvas> elements using an opaque (alpha: false) context, which paints
// over any CSS background applied to the element itself. Keep in sync
// with style.css's background-size if either changes.
const CANVAS_BG = "#2b2b2b";
const CANVAS_GRID = "#3a3a3a";
const GRID_SIZE_CSS_PX = 20;

function drawPlaceholder(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return;
  ctx.fillStyle = CANVAS_BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const dpr = window.devicePixelRatio || 1;
  const gridSize = GRID_SIZE_CSS_PX * dpr;
  ctx.strokeStyle = CANVAS_GRID;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= canvas.width; x += gridSize) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, canvas.height);
  }
  for (let y = 0; y <= canvas.height; y += gridSize) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(canvas.width, y + 0.5);
  }
  ctx.stroke();
}

function resizeCanvas(canvas: HTMLCanvasElement): void {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width === width && canvas.height === height) return;
  canvas.width = width;
  canvas.height = height;
  drawPlaceholder(canvas);
}

function showTab(tab: string): void {
  for (const [name, pane] of tabPanes) pane.classList.toggle("active", name === tab);
  for (const btn of boardTabs.querySelectorAll<HTMLButtonElement>(".tab-btn")) {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  }
  const canvas = boardCanvases.get(tab);
  if (canvas) resizeCanvas(canvas);
}

boardTabs.addEventListener("click", (ev) => {
  const target = (ev.target as HTMLElement).closest<HTMLButtonElement>(".tab-btn");
  if (target?.dataset.tab) showTab(target.dataset.tab);
});

// Only the currently-active pane's canvas needs a resize, since an
// inactive pane (display:none) reports a zero-size rect anyway. Two
// triggers, deliberately not just one: ResizeObserver catches
// layout-driven changes (sidebar content changing height/width, DPI
// changes), window's own "resize" event is the belt-and-suspenders
// fallback for whatever embedding context doesn't deliver those reliably
// (observed directly during testing: an external viewport override
// reflowed the DOM correctly but never fired the ResizeObserver callback
// at all). resizeCanvas() no-ops if the backing store already matches, so
// calling it from both costs nothing extra.
function resizeActivePane(): void {
  for (const [tab, pane] of tabPanes) {
    if (!pane.classList.contains("active")) continue;
    const canvas = boardCanvases.get(tab);
    if (canvas) resizeCanvas(canvas);
  }
}
new ResizeObserver(resizeActivePane).observe(document.querySelector(".workspace") as Element);
window.addEventListener("resize", resizeActivePane);

// -----------------------------------------------------------------------
// Tab 1: real DOM/SVG board elements (@wokwi/elements), not canvas-drawn.
// No devicePixelRatio math or hit-testing needed - the browser already
// positions/scales real elements, and clicks land on the actual element
// under the pointer. Only one board placed at a time for now (Apply
// replaces it); the container itself is otherwise a plain positioned box
// (`.board-canvas-interactive` in style.css).
// -----------------------------------------------------------------------

const tab1Container = document.getElementById("canvas-tab1") as HTMLElement;

// The circuit: plain, JSON-serializable board data (circuit.ts) kept
// separate from its DOM - circuitDom is the id-keyed lookup for the
// actual elements, so JSON.stringify(circuit) never has to filter DOM
// nodes out of it. One board at a time for now (showBoard() below
// replaces rather than appends), same as the DOM scene it mirrors.
let circuit: Circuit = { boards: [] };
const circuitDom = new Map<string, { wrapper: HTMLElement; boardEl: HTMLElement }>();

// A second, separate model from `circuit` above - see energy.ts. Keyed
// the same way circuitDom is (by CircuitBoard.id), for the same reason:
// keeps this out of the JSON-serializable Circuit/CircuitBoard shape.
const energy = new Map<string, BoardEnergy>();

function renderEnergy(e: BoardEnergy): void {
  energyVoltage.textContent = `${e.voltage.toFixed(1)} V`;
  energyCurrent.textContent = `${e.currentMa} mA`;
  energyPower.textContent = `${Math.round(e.voltage * e.currentMa)} mW`;
}

// Recomputes and re-renders energy for whichever placed board is backed
// by the active adapter - same "find the active board" shape as
// setPowered() below, called from there (on power change) and from
// renderState() (on every stateChange, so current draw tracks running
// vs. idle without any new adapter-side plumbing).
function updateEnergy(running: boolean): void {
  const board = circuit.boards.find((b) => b.adapterId === activeAdapterId);
  if (!board) return;
  const e = computeEnergy(board, running);
  energy.set(board.id, e);
  renderEnergy(e);
}

let tab1Selected: HTMLElement | null = null;

function selectBoardItem(item: HTMLElement | null): void {
  tab1Selected?.classList.remove("selected");
  tab1Selected = item;
  tab1Selected?.classList.add("selected");
}

// Wires drag on one placed item's wrapper. Returns a dispose function so
// showBoard() can clean up the window-level listeners when it replaces
// the scene, rather than leaking a new pair every time Apply is clicked.
// Also keeps `board`'s x/y in sync as the DOM moves - the model doesn't
// derive position after the fact, it's updated right alongside the style
// that actually renders it.
function makeDraggable(wrapper: HTMLElement, board: CircuitBoard): () => void {
  let dragOffset: { dx: number; dy: number } | null = null;

  const pointerInContainer = (ev: MouseEvent): { x: number; y: number } => {
    const rect = tab1Container.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  };

  const onMouseDown = (ev: MouseEvent): void => {
    // Stop the container's own mousedown (below) from treating this as a
    // background click and deselecting what we're about to select.
    ev.stopPropagation();
    selectBoardItem(wrapper);
    const { x, y } = pointerInContainer(ev);
    dragOffset = { dx: x - wrapper.offsetLeft, dy: y - wrapper.offsetTop };
    wrapper.classList.add("dragging");
  };

  const onMouseMove = (ev: MouseEvent): void => {
    if (!dragOffset) return;
    const { x, y } = pointerInContainer(ev);
    board.x = x - dragOffset.dx;
    board.y = y - dragOffset.dy;
    wrapper.style.left = `${board.x}px`;
    wrapper.style.top = `${board.y}px`;
  };

  const onMouseUp = (): void => {
    dragOffset = null;
    wrapper.classList.remove("dragging");
  };

  wrapper.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);

  return () => {
    wrapper.removeEventListener("mousedown", onMouseDown);
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
  };
}

// Click on the container background (not a placed item - onMouseDown
// above stops propagation for those) deselects.
tab1Container.addEventListener("mousedown", () => selectBoardItem(null));

let tab1ItemDispose: (() => void) | null = null;

// Places a board element at its true size (SVG intrinsic size, browser-
// rendered - never scaled to fit) centered in the container, and plugs
// it into its adapter (apply()) - the "plugging the board in" moment
// this whole model exists for. Replaces whatever was already placed -
// Apply always starts a fresh scene rather than stacking duplicate
// boards on repeated clicks.
async function showBoard(name: string): Promise<void> {
  showTab("tab1");
  const tagName = boardTagName[name];
  const board = createBoard(name);
  if (!tagName || !board) return;

  tab1ItemDispose?.();
  tab1ItemDispose = null;
  tab1Selected = null;
  tab1Container.replaceChildren();
  circuit = { boards: [board] };
  circuitDom.clear();

  const wrapper = document.createElement("div");
  wrapper.className = "board-item";
  const boardEl = document.createElement(tagName);
  wrapper.appendChild(boardEl);
  tab1Container.appendChild(wrapper);
  circuitDom.set(board.id, { wrapper, boardEl });

  // LitElement's first render happens on a microtask after connect, not
  // synchronously on appendChild - measuring immediately would see an
  // empty (zero-size) shadow DOM and center against the wrong size.
  // updateComplete resolves once that first render has actually happened.
  // Every @wokwi/elements custom element is a LitElement, regardless of
  // board type, so this cast is generic (not board-specific like
  // boardPowerSetter's ArduinoUnoElement one has to be).
  await (boardEl as unknown as LitElement).updateComplete;

  const containerRect = tab1Container.getBoundingClientRect();
  const itemRect = wrapper.getBoundingClientRect();
  board.x = Math.max(0, (containerRect.width - itemRect.width) / 2);
  board.y = Math.max(0, (containerRect.height - itemRect.height) / 2);
  wrapper.style.left = `${board.x}px`;
  wrapper.style.top = `${board.y}px`;

  tab1ItemDispose = makeDraggable(wrapper, board);

  apply(board.adapterId);
}

// Powers (or unpowers) whichever placed board is backed by the active
// adapter - today that's at most one board, since the scene only ever
// holds one. Reflects onto the element via boardPowerSetter (board-type-
// specific: Arduino Uno's power LED, for instance).
function setPowered(on: boolean): void {
  const board = circuit.boards.find((b) => b.adapterId === activeAdapterId);
  if (!board) return;
  board.powered = on;
  const dom = circuitDom.get(board.id);
  if (dom) boardPowerSetter[board.type]?.(dom.boardEl, on);
  // Running state isn't known yet here - start()/reset() are async RPC
  // calls that haven't resolved. Snapshot as "not running" for now; the
  // next stateChange (renderState -> updateEnergy) corrects it once the
  // adapter actually confirms it's ticking.
  updateEnergy(false);
}

showTab("tab1");

// -----------------------------------------------------------------------
// Theme toggle (bottom bar): light/dark for the chrome only - the canvas
// stays --canvas-bg regardless (see style.css). Persisted so it survives
// a reload, since this is meant to stay set while developing against the
// app repeatedly, not reset itself every time.
// -----------------------------------------------------------------------

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
}

const storedTheme = localStorage.getItem(THEME_STORAGE_KEY);
applyTheme(storedTheme === "dark" ? "dark" : "light");

themeToggleBtn.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_STORAGE_KEY, next);
  applyTheme(next);
});
