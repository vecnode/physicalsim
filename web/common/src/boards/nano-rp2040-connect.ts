import type { BoardPinMap } from "./board.js";

// Arduino Nano RP2040 Connect silkscreen pin names -> rp2040 adapter pin
// ids ("GP<n>", see web/adapters/rp2040/src/adapter.ts). This is the one
// RP2040-family element @wokwi/elements actually vendors (nano-rp2040-
// connect-element.ts) - a plain Raspberry Pi Pico element doesn't exist
// in the fork, so this is the board that makes rp2040 placeable at all
// (see COMPONENTS.md's "not registered as boards yet" list). Every
// D<n>/A<n> -> GP<n> pairing below is taken directly from that element's
// own pinInfo `description` field (e.g. `{ name: 'D10', ...,
// description: 'GPIO05' }`), not derived or guessed - the vendored
// element already carries the real board's GPIO numbering.
//
// rp2040-board.ts's own `rp2040Board` (a generic identity GP<n> -> GP<n>
// map) is deliberately left alone, not reused here - it exists purely
// for board.test.ts's own resolvePin() coverage today and doesn't match
// any placeable element's pin names, so it isn't the map this board
// actually needs.
export const nanoRp2040Connect: BoardPinMap = {
  TX: "GP0",
  RX: "GP1",
  D2: "GP25",
  D3: "GP15",
  D4: "GP16",
  D5: "GP17",
  D6: "GP18",
  D7: "GP19",
  D8: "GP20",
  D9: "GP21",
  D10: "GP5",
  D11: "GP7",
  D12: "GP4",
  D13: "GP6",
  A0: "GP26",
  A1: "GP27",
  A2: "GP28",
  A3: "GP29",
  A4: "GP12",
  A5: "GP13",
};
