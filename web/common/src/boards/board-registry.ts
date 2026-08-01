import { arduinoUno } from "./arduino-uno.js";
import { arduinoUnoJs } from "./arduino-uno-js.js";
import { arduinoNano } from "./arduino-nano.js";
import { arduinoMega } from "./arduino-mega.js";
import { arduinoLeonardo } from "./arduino-leonardo.js";
import { franzininho } from "./franzininho.js";
import { nanoRp2040Connect } from "./nano-rp2040-connect.js";
import { rp2040Board } from "./rp2040-board.js";
import { esp32DevkitV1Board } from "./esp32-devkit-v1.js";
import { esp32DevkitCV4Board } from "./esp32-devkit-c-v4.js";
import { esp32CamBoard } from "./esp32-cam.js";
import type { BoardPinMap } from "./board.js";

// Board type (circuit.ts's CircuitBoard.type, shell-side) -> its
// BoardPinMap. Mirrors energy.ts's boardPowerProfile: one table, one
// entry per board type, so a signal chain gaining a second board (e.g.
// rp2040, once it's an actual placeable board type) is a one-line
// addition here - nothing in the resolution/orchestration code that reads
// this table needs to change.
export const boardPinMaps: Record<string, BoardPinMap> = {
  "arduino-uno": arduinoUno,
  "arduino-uno-js": arduinoUnoJs,
  "arduino-nano": arduinoNano,
  "arduino-mega": arduinoMega,
  "arduino-leonardo": arduinoLeonardo,
  franzininho,
  "nano-rp2040-connect": nanoRp2040Connect,
  // rp2040-board.ts's own generic GP<n> identity map - written before any
  // placeable board used it (only board.test.ts's own coverage), and
  // finally the right fit: wokwi-pi-pico's own pin markers are literally
  // "GP0".."GP28" (see pi-pico-element.ts, vendored from wokwi/wokwi-
  // boards), unlike nano-rp2040-connect's Arduino-Nano-shaped D/A markers.
  "pi-pico": rp2040Board,
  // Same RP2040 chip, same physical GP<n> header (confirmed identical
  // against both boards' own board.json, not assumed) - the only real
  // difference (CYW43439 WiFi/Bluetooth chip) isn't emulated, per an
  // explicit user decision (2026-07-25) that this board should just
  // work like the plain Pico for now. Shares the identical map, not a
  // copy of it.
  "pi-pico-w": rp2040Board,
  "esp32-devkit-v1": esp32DevkitV1Board,
  // Same ESP32-WROOM-32 chip as esp32-devkit-v1 (confirmed against both
  // boards' own board.json), just a different header layout/pinout -
  // hence its own, non-identical BoardPinMap rather than sharing the DevKit
  // V1 one the way pi-pico-w shares rp2040Board wholesale.
  "esp32-devkit-c-v4": esp32DevkitCV4Board,
  "esp32-cam": esp32CamBoard,
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
  // Same wokwi-arduino-uno element/markers as "arduino-uno" above - only
  // the backing adapter differs (avr8-js instead of avr8), not the SVG.
  "arduino-uno-js": (marker) => (/^\d+$/.test(marker) ? `D${marker}` : marker),
  "arduino-nano": (marker) => (/^\d+$/.test(marker) ? `D${marker}` : marker),
  // arduino-mega-element.ts uses the identical bare-digit convention for
  // its digital pins (its A0-A15 markers already say "A0".."A15", same
  // as the other two boards, so only the digit-only case needs mapping).
  "arduino-mega": (marker) => (/^\d+$/.test(marker) ? `D${marker}` : marker),
};

export function resolveBoardPinName(boardType: string, marker: string): string {
  return boardPinNameFromMarker[boardType]?.(marker) ?? marker;
}
