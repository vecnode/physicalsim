import type { BoardPinMap } from "./board.js";

// Franzininho silkscreen pin names -> avr8-js-attiny85 adapter pin ids.
// Identity mapping - the adapter's own pin ids ARE "PB0".."PB5" (see
// web/adapters/avr8-js/src/adapter-attiny85.ts), so there's no actual
// translation to do here. The real Franzininho (franzininho.com.br) is
// a Brazilian open-hardware educational board built around the ATtiny85
// in a Digispark-compatible USB-stick form factor. PB0-PB5 is ATtiny85's
// entire port - real hardware has no other GPIO.
//
// Digital I/O works correctly on every pin below. PWM (analogWrite) and
// analogRead/Serial are not modeled yet for this board - a real,
// documented gap, not a silently wrong one (see
// Avr8JsAttiny85Adapter.writeAnalogPin()).
export const franzininho: BoardPinMap = {
  PB0: "PB0",
  PB1: "PB1",
  PB2: "PB2",
  PB3: "PB3",
  PB4: "PB4",
  PB5: "PB5", // reset by default (fuse-dependent on real hardware) - not modeled, just exposed as a plain GPIO here
};
