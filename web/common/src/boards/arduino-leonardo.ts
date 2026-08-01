import type { BoardPinMap } from "./board.js";

// Arduino Leonardo silkscreen pin names -> avr8-js adapter pin ids. Same
// identity D0-D13/A0-A5 shape as arduino-uno.ts - the Leonardo's real
// ATmega32u4 has a genuinely different port/bit layout than the Uno's
// atmega328p, but that only mattered for the real, CPU-register-level
// avr8 adapter (see git history for that mapping); the JS-native
// avr8-js runtime uses the same plain Arduino pin-numbering scheme for
// every AVR board it backs, regardless of the real chip underneath.
export const arduinoLeonardo: BoardPinMap = {
  ...Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`D${i}`, `D${i}`])),
  ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`A${i}`, `A${i}`])),
};
