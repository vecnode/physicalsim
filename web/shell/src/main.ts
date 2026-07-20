import type { SimState } from "@physicalsim/common";
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
}

apply(activeAdapterId);

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
