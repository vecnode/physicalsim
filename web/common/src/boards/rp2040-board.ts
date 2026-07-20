import type { BoardPinMap } from "./board.js";

// Raspberry Pi Pico silkscreen pin names -> rp2040 adapter pin ids ("GP<n>",
// see web/adapters/rp2040/src/adapter.ts). Mostly an identity mapping (the
// board's own labels already match the adapter's pin ids), plus the one
// named alias every Pico board has for its onboard LED.
export const rp2040Board: BoardPinMap = {
  ...Object.fromEntries(Array.from({ length: 29 }, (_, i) => [`GP${i}`, `GP${i}`])),
  LED: "GP25",
};
