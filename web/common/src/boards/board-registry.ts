import { arduinoUno } from "./arduino-uno.js";
import { arduinoNano } from "./arduino-nano.js";
import { arduinoMega } from "./arduino-mega.js";
import { nanoRp2040Connect } from "./nano-rp2040-connect.js";
import { rp2040Board } from "./rp2040-board.js";
import type { BoardPinMap } from "./board.js";

// Board type (circuit.ts's CircuitBoard.type, shell-side) -> its
// BoardPinMap. Mirrors energy.ts's boardPowerProfile: one table, one
// entry per board type, so a signal chain gaining a second board (e.g.
// rp2040, once it's an actual placeable board type) is a one-line
// addition here - nothing in the resolution/orchestration code that reads
// this table needs to change.
export const boardPinMaps: Record<string, BoardPinMap> = {
  "arduino-uno": arduinoUno,
  "arduino-nano": arduinoNano,
  "arduino-mega": arduinoMega,
  "nano-rp2040-connect": nanoRp2040Connect,
  // rp2040-board.ts's own generic GP<n> identity map - written before any
  // placeable board used it (only board.test.ts's own coverage), and
  // finally the right fit: wokwi-pi-pico's own pin markers are literally
  // "GP0".."GP28" (see pi-pico-element.ts, vendored from wokwi/wokwi-
  // boards), unlike nano-rp2040-connect's Arduino-Nano-shaped D/A markers.
  "pi-pico": rp2040Board,
};

// Normalizes a board's own on-canvas pin marker name (@wokwi/elements'
// pinInfo, as seen by canvas/wiring.ts's PinRef.pin) into boardPinMaps'
// own key convention, for boards whose markers don't already match one to
// one. Arduino Uno's vendored element renders its digital pins as bare
// "13", not silkscreen-style "D13" - arduino-uno.ts's map still uses
// "D13" so a pin's name reads the same as the real datasheet regardless
// of how the SVG happens to label the marker. A board with no entry here
// is assumed to already match (identity). Arduino Nano's element uses the
// exact same bare-digit convention, so it shares the identical resolver.
export const boardPinNameFromMarker: Record<string, (marker: string) => string> = {
  "arduino-uno": (marker) => (/^\d+$/.test(marker) ? `D${marker}` : marker),
  "arduino-nano": (marker) => (/^\d+$/.test(marker) ? `D${marker}` : marker),
  // arduino-mega-element.ts uses the identical bare-digit convention for
  // its digital pins (its A0-A15 markers already say "A0".."A15", same
  // as the other two boards, so only the digit-only case needs mapping).
  "arduino-mega": (marker) => (/^\d+$/.test(marker) ? `D${marker}` : marker),
};

export function resolveBoardPinName(boardType: string, marker: string): string {
  return boardPinNameFromMarker[boardType]?.(marker) ?? marker;
}
