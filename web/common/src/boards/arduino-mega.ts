import type { BoardPinMap } from "./board.js";

// Arduino Mega 2560 silkscreen pin names -> avr8-js-mega adapter pin
// ids. Identity D0-D53/A0-A15 - the JS-native avr8-js-mega runtime
// (ArduinoRuntime configured with digitalPinCount:54, analogPinCount:16
// - see web/adapters/avr8-js/src/adapter-mega.ts) uses plain Arduino
// pin-numbering directly, the same as every other AVR board this
// project backs, regardless of the real ATmega2560's much bigger and
// non-contiguous port/bit layout (see git history for that real mapping,
// from when this board ran the cycle-accurate avr8-mega adapter).
export const arduinoMega: BoardPinMap = {
  ...Object.fromEntries(Array.from({ length: 54 }, (_, i) => [`D${i}`, `D${i}`])),
  ...Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`A${i}`, `A${i}`])),
};
