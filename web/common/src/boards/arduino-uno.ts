import type { BoardPinMap } from "./board.js";

// Arduino Uno (ATmega328p) silkscreen pin names -> avr8 adapter pin ids
// ("<port letter><bit>", see web/adapters/avr8/src/adapter.ts). Digital
// pins 0-7 are PORTD, 8-13 are PORTB, analog pins 0-5 (used as digital
// I/O here) are PORTC - the standard Uno pinout.
export const arduinoUno: BoardPinMap = {
  D0: "D0",
  D1: "D1",
  D2: "D2",
  D3: "D3",
  D4: "D4",
  D5: "D5",
  D6: "D6",
  D7: "D7",
  D8: "B0",
  D9: "B1",
  D10: "B2",
  D11: "B3",
  D12: "B4",
  D13: "B5", // onboard LED
  A0: "C0",
  A1: "C1",
  A2: "C2",
  A3: "C3",
  A4: "C4",
  A5: "C5",
};
