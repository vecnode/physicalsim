import type { BoardPinMap } from "./board.js";

// Arduino Uno silkscreen pin names -> avr8-js adapter pin ids. Identity
// mapping: the avr8-js adapter's own pin ids ARE "D0".."D13"/"A0".."A5"
// (avr8js/arduino's own pinName() output - see
// web/adapters/avr8-js/src/adapter.ts), so there's no actual translation
// to do here - only a table because board-registry.ts needs one entry
// per board type. (Before the move to a JS-native runtime, this mapped
// onto avr8's own "<port letter><bit>" register-address scheme instead -
// see git history if that mapping is ever needed again.)
export const arduinoUno: BoardPinMap = {
  ...Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`D${i}`, `D${i}`])),
  ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`A${i}`, `A${i}`])),
};
