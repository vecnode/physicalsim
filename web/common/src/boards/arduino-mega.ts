import type { BoardPinMap } from "./board.js";

// Arduino Mega 2560 silkscreen pin names -> avr8 adapter pin ids
// ("<port letter><bit>" - see web/adapters/avr8/src/adapter.ts), backed
// by the "avr8-mega" adapter (ATMEGA2560 chip config, chip.ts), not
// "avr8" - a genuinely different, much bigger port set than the Uno/
// Nano's PORTB/C/D-only atmega328p, not just a relabeling of the same
// three ports. Every D<n>/A<n> -> port.bit pairing below is the real
// ATmega2560 pinout (confirmed against the datasheet's own Arduino Mega
// pin-mapping table, not derived from the atmega328p's layout) - Mega's
// digital pins are scattered across ports A/B/C/D/E/F/G/H/J/K/L in a
// deliberately non-contiguous order (the silkscreen numbering was chosen
// for board layout, not port-bit order).
//
// A8-A15 resolve here (plain GPIO digitalRead/digitalWrite works on
// them) but are NOT ADC-capable in this fork yet - chip.ts's
// ATMEGA2560.adcPortLetter is "F" (A0-A7 only); A8-A15 sit on PORTK,
// which would need the ADCSRB MUX5 bit avr8js's adcConfig doesn't model
// for a 16-channel ADC (see chip.ts's own comment). writeAnalogPin on
// A8-A15 fails the same "not ADC-capable" way it would for any non-ADC
// pin - a documented gap, not a silent one.
export const arduinoMega: BoardPinMap = {
  D0: "E0", // RX0
  D1: "E1", // TX0
  D2: "E4",
  D3: "E5",
  D4: "G5",
  D5: "E3",
  D6: "H3",
  D7: "H4",
  D8: "H5",
  D9: "H6",
  D10: "B4",
  D11: "B5",
  D12: "B6",
  D13: "B7", // onboard LED
  D14: "J1", // TX3
  D15: "J0", // RX3
  D16: "H1", // TX2
  D17: "H0", // RX2
  D18: "D3", // TX1
  D19: "D2", // RX1
  D20: "D1", // SDA
  D21: "D0", // SCL
  D22: "A0",
  D23: "A1",
  D24: "A2",
  D25: "A3",
  D26: "A4",
  D27: "A5",
  D28: "A6",
  D29: "A7",
  D30: "C7",
  D31: "C6",
  D32: "C5",
  D33: "C4",
  D34: "C3",
  D35: "C2",
  D36: "C1",
  D37: "C0",
  D38: "D7",
  D39: "G2",
  D40: "G1",
  D41: "G0",
  D42: "L7",
  D43: "L6",
  D44: "L5",
  D45: "L4",
  D46: "L3",
  D47: "L2",
  D48: "L1",
  D49: "L0",
  D50: "B3", // MISO
  D51: "B2", // MOSI
  D52: "B1", // SCK
  D53: "B0", // SS
  A0: "F0",
  A1: "F1",
  A2: "F2",
  A3: "F3",
  A4: "F4",
  A5: "F5",
  A6: "F6",
  A7: "F7",
  A8: "K0",
  A9: "K1",
  A10: "K2",
  A11: "K3",
  A12: "K4",
  A13: "K5",
  A14: "K6",
  A15: "K7",
};
