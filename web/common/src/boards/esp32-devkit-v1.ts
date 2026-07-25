import type { BoardPinMap } from "./board.js";

// wokwi-esp32-devkit-v1's own pin markers (esp32-devkit-v1-element.ts,
// vendored from upstream wokwi/wokwi-elements) are already "D<n>" - an
// identity mapping, same shape as rp2040-board.ts's "GP<n>" one.
// src/esp32_qemu_adapter.cpp's parse_gpio_number() strips any leading
// non-digit characters itself, so passing "D18" straight through as both
// the marker and the resolved pin id is enough for it to read GPIO18.
export const esp32DevkitV1Board: BoardPinMap = {
  ...Object.fromEntries(
    [2, 4, 5, 12, 13, 14, 15, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 34, 35].map((n) => [
      `D${n}`,
      `D${n}`,
    ]),
  ),
};
