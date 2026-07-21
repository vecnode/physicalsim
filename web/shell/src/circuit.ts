import type { AdapterId } from "./adapter-registry.js";
import type { ArduinoUnoElement } from "@wokwi/elements";
import { componentRegistry } from "./component-registry.js";

// Not the same thing as @physicalsim/common's Circuit class
// (web/common/src/circuit/circuit.ts, a thin CircuitComponent container -
// currently unused anywhere, unrelated to this file). This one is the
// shell's board-placement scene: what's on tab 1's canvas, at what
// position, powered or not. Different layer, different job, same English
// word - worth knowing before assuming they're connected.

// A single placed board, deliberately plain/serializable data - no DOM
// references live here (those stay in a separate id-keyed map in
// main.ts), so JSON.stringify(circuit) always reflects exactly what's on
// the canvas without needing to strip anything out first.
export interface CircuitBoard {
  id: string;
  type: string; // e.g. "arduino-uno" - key into the registries below
  adapterId: AdapterId; // which SimulatorAdapter this board type is backed by
  x: number;
  y: number;
  powered: boolean;
}

// A placed sensor/connection part (component-registry.ts) - deliberately
// lighter than CircuitBoard: no adapterId/powered, since these aren't
// backed by any SimulatorAdapter and have no power state of their own
// yet. Wiring a component's pins to a board's is the natural next step
// once there's an actual netlist to solve (see ARCHITECTURE.md's
// "Explicitly out of scope" section) - this is just "it's placed on the
// canvas, at this position", same starting point CircuitBoard had before
// adapterId/powered existed.
export interface PlacedComponent {
  id: string;
  type: string; // key into component-registry.ts's componentRegistry
  x: number;
  y: number;
}

export interface Circuit {
  boards: CircuitBoard[];
  components: PlacedComponent[];
}

// Board id -> custom element tag name (@wokwi/elements).
export const boardTagName: Record<string, string> = {
  "arduino-uno": "wokwi-arduino-uno",
};

// Board id -> human-readable label, for menus that list board types (the
// canvas's right-click "add component" menu) rather than the select's own
// hardcoded <option> text (index.html) - a second surface listing the same
// board types needs its own label lookup, not to reach into the DOM.
export const boardDisplayName: Record<string, string> = {
  "arduino-uno": "Arduino Uno",
};

// Board id -> the SimulatorAdapter that powers it. This is what "plugging
// a board into an adapter" resolves to - see main.ts's showBoard(),
// which calls apply(boardAdapterId[type]) right after placing a board.
export const boardAdapterId: Record<string, AdapterId> = {
  "arduino-uno": "avr8",
};

// Board id -> how to reflect powered on/off on its placed element. Board-
// specific because not every board type will expose the same property
// (or any property at all) for this - Arduino Uno's power-supply LED
// ("ON" on the silkscreen) is independent of any GPIO pin, unlike
// led13/ledTX/ledRX which track real pin state (not wired up yet).
export const boardPowerSetter: Record<string, (el: HTMLElement, on: boolean) => void> = {
  "arduino-uno": (el, on) => {
    (el as ArduinoUnoElement).ledPower = on;
  },
};

let nextBoardId = 1;

// Returns null for an unknown board type rather than throwing - callers
// (showBoard()) already no-op on an unrecognized type via boardTagName.
export function createBoard(type: string): CircuitBoard | null {
  const adapterId = boardAdapterId[type];
  if (!adapterId) return null;
  return {
    id: `board-${nextBoardId++}`,
    type,
    adapterId,
    x: 0,
    y: 0,
    powered: false,
  };
}

let nextComponentId = 1;

// Returns null for an unknown component type - mirrors createBoard()'s
// contract so callers (addComponentAt() in main.ts) handle both the same
// way.
export function createComponent(type: string): PlacedComponent | null {
  if (!componentRegistry[type]) return null;
  return { id: `component-${nextComponentId++}`, type, x: 0, y: 0 };
}
