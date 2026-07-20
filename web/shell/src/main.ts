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
let activeAdapterId: AdapterId = adapterSelect.value as AdapterId;

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
  apply(adapterSelect.value as AdapterId);
});

function activeClient() {
  return getAdapterClient(activeAdapterId);
}

startBtn.addEventListener("click", () => void activeClient().call("start"));
stopBtn.addEventListener("click", () => void activeClient().call("stop"));
stepBtn.addEventListener("click", () => void activeClient().call("step", 1));
resetBtn.addEventListener("click", () => void activeClient().call("reset"));

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

  const board = boardFor[activeAdapterId];
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
  const board = boardFor[activeAdapterId];
  if (!board) return;
  const rowId = `${activeAdapterId}:${name}:${pinRowsById.size}:${Date.now()}`;
  const client = activeClient();
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
  const board = boardFor[activeAdapterId];
  if (!board || !pinSelect.value) return;
  const pin = CircuitPin.forBoardPin(activeClient(), board, pinSelect.value);
  void pin.read().then((value) => {
    pinLogLine(`${activeAdapterId}:${pin.pin} read -> ${value}`);
  });
});

pinAttachBtn.addEventListener("click", () => {
  if (!pinSelect.value) return;
  addPinRow(pinSelect.value, pinKindSelect.value as "led" | "button");
});

// Deferred until here (not right after `apply` is defined above) because
// apply() -> refreshPinPanel() reads the pin-panel elements declared in
// this section - calling it any earlier would hit them before their
// `const` declarations run.
apply(activeAdapterId);
