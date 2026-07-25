import type { BoardPinMap } from "./board.js";

// Franzininho silkscreen pin names -> avr8 adapter pin ids ("<port
// letter><bit>" - see web/adapters/avr8/src/adapter.ts), backed by the
// "avr8-attiny85" adapter (ATTINY85 chip config, chip.ts). The real
// Franzininho (franzininho.com.br) is a Brazilian open-hardware
// educational board built around the ATtiny85 in a Digispark-compatible
// USB-stick form factor - genuinely a different, much smaller chip than
// the Uno/Nano/Mega's ATmega family, not a relabeling of the same ports.
// PB0-PB5 is ATtiny85's entire port - real hardware has no other GPIO.
//
// Digital I/O works correctly on every pin below. PWM (analogWrite) and
// analogRead/Serial do not yet - chip.ts's ATTINY85 config skips
// constructing Timer1/USART/SPI/TWI entirely (their fixed ATmega-shaped
// addresses would otherwise collide with ATtiny85's real GPIO
// registers), a real, documented gap rather than a silently wrong one.
export const franzininho: BoardPinMap = {
  PB0: "B0",
  PB1: "B1",
  PB2: "B2",
  PB3: "B3",
  PB4: "B4",
  PB5: "B5", // reset by default (fuse-dependent on real hardware) - not modeled, just exposed as a plain GPIO here
};
