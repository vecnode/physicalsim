import type { BoardPinMap, SimState } from "@physicalsim/common";
import { arduinoUno, Button, CircuitPin, Led, rp2040Board } from "@physicalsim/common";
import { getAdapterClient, type AdapterId } from "./adapter-registry.js";
import "./native-bridge.js";

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
  // Selecting it just draws the board on tab 1; it doesn't touch
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

// Unreachable via the UI right now (the four buttons are disabled - see
// index.html) since activeAdapterId never becomes non-null without a
// dropdown path to avr8/rp2040/cortex-m. Left wired rather than removed:
// this is exactly what re-enabling those adapters later needs.
startBtn.addEventListener("click", () => void activeClient()?.call("start"));
stopBtn.addEventListener("click", () => void activeClient()?.call("stop"));
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
// sidebar - see index.html) alongside a canvas filling the rest of its
// area; showBoard() below places a board illustration onto it as a
// selectable, draggable element. Tabs 2/3 stay full-bleed placeholder
// canvases - no scene, no interaction. Kept to plain 2D canvas
// throughout, backing store sized 1:1 against devicePixelRatio and
// redrawn only on resize/tab-switch/scene-change (no per-frame render
// loop for something that only changes on user input), so it stays cheap
// regardless of what eventually gets placed on it.
// -----------------------------------------------------------------------

const boardTabs = document.getElementById("board-tabs") as HTMLElement;
const tabPanes = new Map<string, HTMLElement>();
const boardCanvases = new Map<string, HTMLCanvasElement>();
for (const pane of document.querySelectorAll<HTMLElement>(".tab-pane")) {
  const tab = pane.dataset.tab;
  if (!tab) continue;
  tabPanes.set(tab, pane);
  const canvas = pane.querySelector<HTMLCanvasElement>(".board-canvas");
  if (canvas) boardCanvases.set(tab, canvas);
}

// Board illustrations are plain static images, not the interactive
// wokwi-elements web components they're adapted from - see
// assets/boards/arduino-uno.svg (canonical copy) and
// web/shell/public/boards/arduino-uno.svg (the copy this actually fetches,
// per Vite's static-asset convention).
const boardImageSrc: Record<string, string> = {
  "arduino-uno": "/boards/arduino-uno.svg",
};
const loadedBoardImages = new Map<string, HTMLImageElement>();

function loadBoardImage(name: string): Promise<HTMLImageElement> {
  const cached = loadedBoardImages.get(name);
  if (cached) return Promise.resolve(cached);
  const src = boardImageSrc[name];
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      loadedBoardImages.set(name, img);
      resolve(img);
    };
    img.onerror = () => reject(new Error(`Failed to load board image "${name}"`));
    img.src = src;
  });
}

// One placed item on tab 1's canvas. Position/size are in the canvas's
// own backing-store pixel space (already devicePixelRatio-scaled), same
// space pointer coordinates get converted into below - so hit-testing and
// drawing both work in one consistent coordinate system.
interface SceneItem {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const tab1Scene: SceneItem[] = [];
let tab1Selected: SceneItem | null = null;

function redrawTab1(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const item of tab1Scene) {
    const img = loadedBoardImages.get(item.name);
    if (img) ctx.drawImage(img, item.x, item.y, item.width, item.height);
    if (item === tab1Selected) {
      ctx.save();
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(item.x + 1, item.y + 1, item.width - 2, item.height - 2);
      ctx.restore();
    }
  }
}

function drawPlaceholder(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function resizeCanvas(canvas: HTMLCanvasElement, tab: string): void {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width === width && canvas.height === height) return;
  canvas.width = width;
  canvas.height = height;
  if (tab === "tab1") redrawTab1(canvas);
  else drawPlaceholder(canvas);
}

function showTab(tab: string): void {
  for (const [name, pane] of tabPanes) pane.classList.toggle("active", name === tab);
  for (const btn of boardTabs.querySelectorAll<HTMLButtonElement>(".tab-btn")) {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  }
  const canvas = boardCanvases.get(tab);
  if (canvas) resizeCanvas(canvas, tab);
}

// Places a board at its true size (devicePixelRatio-adjusted, never
// scaled down or up to "fit") centered on the canvas. Replaces whatever
// was already placed - Apply always starts a fresh scene rather than
// stacking duplicate boards on repeated clicks.
async function showBoard(name: string): Promise<void> {
  showTab("tab1");
  const canvas = boardCanvases.get("tab1");
  if (!canvas) return;
  const img = await loadBoardImage(name);
  const dpr = window.devicePixelRatio || 1;
  const width = img.naturalWidth * dpr;
  const height = img.naturalHeight * dpr;
  tab1Scene.length = 0;
  tab1Scene.push({
    name,
    x: (canvas.width - width) / 2,
    y: (canvas.height - height) / 2,
    width,
    height,
  });
  tab1Selected = null;
  redrawTab1(canvas);
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
    if (canvas) resizeCanvas(canvas, tab);
  }
}
new ResizeObserver(resizeActivePane).observe(document.querySelector(".workspace") as Element);
window.addEventListener("resize", resizeActivePane);

// -----------------------------------------------------------------------
// Tab 1 selection + drag. Canvas has no DOM nodes per placed item - only
// this one element type exists so far, so hit-testing is a plain
// top-to-bottom rect scan rather than anything more elaborate.
// -----------------------------------------------------------------------

const tab1Canvas = boardCanvases.get("tab1");
if (tab1Canvas) {
  let dragOffset: { dx: number; dy: number } | null = null;

  const toCanvasPoint = (ev: MouseEvent): { x: number; y: number } => {
    const rect = tab1Canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return { x: (ev.clientX - rect.left) * dpr, y: (ev.clientY - rect.top) * dpr };
  };

  const hitTest = (x: number, y: number): SceneItem | null => {
    for (let i = tab1Scene.length - 1; i >= 0; i--) {
      const item = tab1Scene[i];
      if (x >= item.x && x <= item.x + item.width && y >= item.y && y <= item.y + item.height) {
        return item;
      }
    }
    return null;
  };

  tab1Canvas.addEventListener("mousedown", (ev) => {
    const { x, y } = toCanvasPoint(ev);
    const hit = hitTest(x, y);
    tab1Selected = hit;
    dragOffset = hit ? { dx: x - hit.x, dy: y - hit.y } : null;
    tab1Canvas.style.cursor = hit ? "grabbing" : "default";
    redrawTab1(tab1Canvas);
  });

  tab1Canvas.addEventListener("mousemove", (ev) => {
    if (!dragOffset || !tab1Selected) {
      const { x, y } = toCanvasPoint(ev);
      tab1Canvas.style.cursor = hitTest(x, y) ? "grab" : "default";
      return;
    }
    const { x, y } = toCanvasPoint(ev);
    tab1Selected.x = x - dragOffset.dx;
    tab1Selected.y = y - dragOffset.dy;
    redrawTab1(tab1Canvas);
  });

  const endDrag = (): void => {
    if (!dragOffset) return;
    dragOffset = null;
    tab1Canvas.style.cursor = tab1Selected ? "grab" : "default";
  };
  window.addEventListener("mouseup", endDrag);
  tab1Canvas.addEventListener("mouseleave", () => {
    if (!dragOffset) tab1Canvas.style.cursor = "default";
  });
}

showTab("tab1");
