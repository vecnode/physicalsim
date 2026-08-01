import type { BoardPinMap } from "./board.js";

// Arduino Nano silkscreen pin names -> avr8-js adapter pin ids. Same
// identity D0-D13/A0-A5 shape as arduino-uno.ts (the Nano is the same
// ATmega328p, and both boards now run the same JS-native avr8-js
// runtime - see that file's own comment for why no real translation
// happens here). A6/A7 (which the Nano breaks out but the Uno doesn't)
// are intentionally omitted - real ADC-only pins with no GPIO port at
// all, and analogRead() isn't modeled by this runtime's pin scheme
// beyond A0-A5 for this board yet.
export const arduinoNano: BoardPinMap = {
  ...Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`D${i}`, `D${i}`])),
  ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`A${i}`, `A${i}`])),
};
