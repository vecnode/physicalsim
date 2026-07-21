import type { BoardPinMap, SimState } from "@physicalsim/common";
import { arduinoUno, Button, CircuitPin, Led, rp2040Board } from "@physicalsim/common";
import type { LitElement } from "lit";
import { getAdapterClient, type AdapterId } from "./adapter-registry.js";
import {
  boardPowerSetter,
  boardTagName,
  createBoard,
  type Circuit,
  type CircuitBoard,
} from "./circuit.js";
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
const stopBtn = document.getElementById("stop-btn") as HTMLButtonElement;
const stepBtn = document.getElementById("step-btn") as HTMLButtonElement;
const resetBtn = document.getElementById("reset-btn") as HTMLButtonElement;
const stateRunning = document.getElementById("state-running") as HTMLElement;
const stateCycles = document.getElementById("state-cycles") as HTMLElement;
const statePc = document.getElementById("state-pc") as HTMLElement;
const log = document.getElementById("log") as HTMLElement;

let unsubscribe: (() => void) | null = null;
// The adapter the Start/Stop/Step/Reset controls act on. Only changes
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
  refreshPinPanel();
}

applyBtn.addEventListener("click", () => {
  const value = adapterSelect.value;
  // "Arduino Uno" is a board illustration, not a running SimulatorAdapter -
  // it isn't in the AdapterId union and never reaches getAdapterClient().
  // Selecting it just places the board on tab 1; it doesn't touch
  // start/stop/step/reset or any of the avr8/rp2040/cortex-m machinery.
  if (value === "arduino-uno") {
    void showBoard("arduino-uno");
    return;
  }
  apply(value as AdapterId);
});

function activeClient() {
  return activeAdapterId ? getAdapterClient(activeAdapterId) : null;
}

// Start/Stop double as "power the circuit": beyond calling the adapter's
// own start()/stop(), they flip .powered on whichever placed board is
// backed by the active adapter and reflect that on its element (the
// board's power-supply LED, independent of any GPIO pin - see circuit.ts).
// No-ops safely via activeClient()'s null check if nothing is plugged in
// yet (see setPowered below, defined near the circuit model further down).
startBtn.addEventListener("click", () => {
  void activeClient()?.call("start");
  setPowered(true);
});
stopBtn.addEventListener("click", () => {
  void activeClient()?.call("stop");
  setPowered(false);
});
// Step/Reset stay disabled (see index.html) - not part of "power the
// circuit", left wired rather than removed for whenever they're needed.
stepBtn.addEventListener("click", () => void activeClient()?.call("step", 1));
resetBtn.addEventListener("click", () => void activeClient()?.call("reset"));

// -----------------------------------------------------------------------
// Pins panel: read/attach/detach individual pins on the active adapter.
// No board/canvas view - just a list of rows, each backed by a CircuitPin.
// See ARCHITECTURE.md's "Pin I/O pipeline" section for what's underneath.
// -----------------------------------------------------------------------

const pinSelect = document.getElementById("pin-select") as HTMLSelectElement;
const pinKindSelect = document.getElementById("pin-kind-select") as HTMLSelectElement;
const pinReadBtn = document.getElementById("pin-read-btn") as HTMLButtonElement;
const pinAttachBtn = document.getElementById("pin-attach-btn") as HTMLButtonElement;
const pinUnsupported = document.getElementById("pin-unsupported") as HTMLElement;
const pinRows = document.getElementById("pin-rows") as HTMLElement;
const pinLog = document.getElementById("pin-log") as HTMLElement;

// Only avr8/rp2040 have real pin I/O today - cortex-m's QemuInstance always
// throws (see src/qemu_adapter.cpp), so there's no board map for it and the
// panel disables itself entirely rather than let you hit that error blind.
const boardFor: Record<AdapterId, BoardPinMap | null> = {
  avr8: arduinoUno,
  rp2040: rp2040Board,
  "cortex-m": null,
};

const MAX_PIN_LOG_LINES = 200;
const pinLogLines: string[] = [];

function pinLogLine(text: string): void {
  const time = new Date().toLocaleTimeString();
  pinLogLines.push(`[${time}] ${text}`);
  if (pinLogLines.length > MAX_PIN_LOG_LINES) pinLogLines.shift();
  pinLog.textContent = pinLogLines.join("\n");
  pinLog.scrollTop = pinLog.scrollHeight;
}

interface PinRow {
  el: HTMLElement;
  dispose: () => void;
}

let pinRowsById = new Map<string, PinRow>();

function clearPinRows(): void {
  for (const row of pinRowsById.values()) row.dispose();
  pinRowsById = new Map();
  pinRows.replaceChildren();
}

function refreshPinPanel(): void {
  // Switching the active adapter invalidates every attached row - each one
  // held a CircuitPin bound to the *previous* adapter's client.
  clearPinRows();

  const board = activeAdapterId ? boardFor[activeAdapterId] : null;
  pinUnsupported.hidden = board !== null;
  pinSelect.disabled = board === null;
  pinKindSelect.disabled = board === null;
  pinReadBtn.disabled = board === null;
  pinAttachBtn.disabled = board === null;

  pinSelect.replaceChildren();
  if (board) {
    for (const name of Object.keys(board)) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = `${name} (${board[name]})`;
      pinSelect.appendChild(option);
    }
  }
}

function addPinRow(name: string, kind: "led" | "button"): void {
  const board = activeAdapterId ? boardFor[activeAdapterId] : null;
  const client = activeClient();
  if (!board || !client) return;
  const rowId = `${activeAdapterId}:${name}:${pinRowsById.size}:${Date.now()}`;
  const pin = CircuitPin.forBoardPin(client, board, name);

  const el = document.createElement("div");
  el.className = "pin-row";

  const label = document.createElement("span");
  label.className = "pin-row-name";
  label.innerHTML = `${name} <span class="pin-row-id">(${pin.pin})</span>`;
  el.appendChild(label);

  let dispose: () => void;

  if (kind === "led") {
    const led = new Led(pin);
    const dot = document.createElement("span");
    dot.className = "led-dot";
    el.appendChild(dot);
    const unsubscribe = pin.onChange((value) => {
      dot.classList.toggle("on", !!value);
      pinLogLine(`${activeAdapterId}:${pin.pin} -> ${value}`);
    });
    dispose = () => {
      unsubscribe();
      led.dispose();
    };
  } else {
    const button = new Button(pin);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "hold to press";
    const pressed = async (): Promise<void> => {
      await button.press();
      const readBack = await pin.read();
      pinLogLine(`${activeAdapterId}:${pin.pin} wrote 1, read back ${readBack}`);
    };
    const released = async (): Promise<void> => {
      await button.release();
      const readBack = await pin.read();
      pinLogLine(`${activeAdapterId}:${pin.pin} wrote 0, read back ${readBack}`);
    };
    btn.addEventListener("mousedown", () => void pressed());
    btn.addEventListener("mouseup", () => void released());
    btn.addEventListener("mouseleave", () => void released());
    el.appendChild(btn);
    dispose = () => {
      /* Button holds no subscription of its own to release. */
    };
  }

  const detachBtn = document.createElement("button");
  detachBtn.type = "button";
  detachBtn.className = "pin-row-detach";
  detachBtn.textContent = "✕";
  detachBtn.title = "Detach";
  detachBtn.addEventListener("click", () => {
    dispose();
    pinRowsById.delete(rowId);
    el.remove();
    pinLogLine(`detached ${activeAdapterId}:${pin.pin}`);
  });
  el.appendChild(detachBtn);

  pinRowsById.set(rowId, { el, dispose });
  pinRows.appendChild(el);
  pinLogLine(`attached ${activeAdapterId}:${pin.pin} as ${kind}`);
}

pinReadBtn.addEventListener("click", () => {
  const board = activeAdapterId ? boardFor[activeAdapterId] : null;
  const client = activeClient();
  if (!board || !client || !pinSelect.value) return;
  const pin = CircuitPin.forBoardPin(client, board, pinSelect.value);
  void pin.read().then((value) => {
    pinLogLine(`${activeAdapterId}:${pin.pin} read -> ${value}`);
  });
});

pinAttachBtn.addEventListener("click", () => {
  if (!pinSelect.value) return;
  addPinRow(pinSelect.value, pinKindSelect.value as "led" | "button");
});

// Deferred until here (not right after `apply` is defined above) because
// refreshPinPanel() reads the pin-panel elements declared in this
// section - calling it any earlier would hit them before their `const`
// declarations run. Renders the "no running adapter" disabled state
// correctly on load, since activeAdapterId starts null (see above).
refreshPinPanel();

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

function drawPlaceholder(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
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
}

showTab("tab1");
