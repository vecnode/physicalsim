import type { BoardPinMap } from "./board.js";

// Arduino Uno (JS/TS-interpreted, no C/C++ compiler - avr8-js adapter)
// silkscreen pin names -> adapter pin ids. Identity mapping: the avr8-js
// adapter's own pin ids ARE "D0".."D13"/"A0".."A5" (avr8js/arduino's own
// pinName() output - see web/adapters/avr8-js/src/adapter.ts), unlike the
// real-CPU avr8 adapter's "<port letter><bit>" scheme (arduino-uno.ts),
// so there's no actual translation to do here - only a table because
// board-registry.ts needs one entry per board type.
export const arduinoUnoJs: BoardPinMap = {
  ...Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`D${i}`, `D${i}`])),
  ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`A${i}`, `A${i}`])),
};
