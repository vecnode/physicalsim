import type { AdapterId } from "./adapter-registry.js";
import type { ArduinoUnoElement } from "@wokwi/elements";

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

export interface Circuit {
  boards: CircuitBoard[];
}

// Board id -> custom element tag name (@wokwi/elements).
export const boardTagName: Record<string, string> = {
  "arduino-uno": "wokwi-arduino-uno",
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
