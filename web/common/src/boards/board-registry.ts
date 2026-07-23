import { arduinoUno } from "./arduino-uno.js";
import type { BoardPinMap } from "./board.js";

// Board type (circuit.ts's CircuitBoard.type, shell-side) -> its
// BoardPinMap. Mirrors energy.ts's boardPowerProfile: one table, one
// entry per board type, so a signal chain gaining a second board (e.g.
// rp2040, once it's an actual placeable board type) is a one-line
// addition here - nothing in the resolution/orchestration code that reads
// this table needs to change.
export const boardPinMaps: Record<string, BoardPinMap> = {
  "arduino-uno": arduinoUno,
};

// Normalizes a board's own on-canvas pin marker name (@wokwi/elements'
// pinInfo, as seen by canvas/wiring.ts's PinRef.pin) into boardPinMaps'
// own key convention, for boards whose markers don't already match one to
// one. Arduino Uno's vendored element renders its digital pins as bare
// "13", not silkscreen-style "D13" - arduino-uno.ts's map still uses
// "D13" so a pin's name reads the same as the real datasheet regardless
// of how the SVG happens to label the marker. A board with no entry here
// is assumed to already match (identity).
export const boardPinNameFromMarker: Record<string, (marker: string) => string> = {
  "arduino-uno": (marker) => (/^\d+$/.test(marker) ? `D${marker}` : marker),
};

export function resolveBoardPinName(boardType: string, marker: string): string {
  return boardPinNameFromMarker[boardType]?.(marker) ?? marker;
}
