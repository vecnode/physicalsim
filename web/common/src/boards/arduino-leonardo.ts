import type { BoardPinMap } from "./board.js";

// Arduino Leonardo silkscreen pin names -> avr8 adapter pin ids ("<port
// letter><bit>" - see web/adapters/avr8/src/adapter.ts), backed by the
// "avr8-leonardo" adapter (ATMEGA32U4 chip config, chip.ts) - a
// genuinely different chip from the Uno/Nano's atmega328p, not a
// relabeling of the same three ports. Every D<n>/A<n> -> port.bit
// pairing below is the real ATmega32u4 pinout, confirmed against
// simulators/ArduinoCore-avr's own vendored variants/leonardo/
// pins_arduino.h (digital_pin_to_port_PGM/digital_pin_to_bit_mask_PGM),
// not derived from the atmega328p's layout - Leonardo's digital pins are
// scattered across ports B/C/D/E/F, not the Uno's contiguous B/C/D.
export const arduinoLeonardo: BoardPinMap = {
  D0: "D2", // RX
  D1: "D3", // TX
  D2: "D1", // SDA
  D3: "D0", // SCL, PWM
  D4: "D4",
  D5: "C6", // PWM
  D6: "D7", // PWM
  D7: "E6",
  D8: "B4",
  D9: "B5", // PWM
  D10: "B6", // PWM
  D11: "B7", // PWM
  D12: "D6",
  D13: "C7", // PWM, onboard LED
  A0: "F7",
  A1: "F6",
  A2: "F5",
  A3: "F4",
  A4: "F1",
  A5: "F0",
};
