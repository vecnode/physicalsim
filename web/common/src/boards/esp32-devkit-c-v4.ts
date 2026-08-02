import type { BoardPinMap } from "./board.js";

// iot-esp32-devkit-c-v4's own pin markers (esp32-devkit-c-v4-element.ts,
// vendored from upstream wokwi/wokwi-boards) are bare GPIO numbers - this
// board's own real silkscreen, unlike esp32-devkit-v1-element.ts's
// hand-picked "D<n>" convention. Identity mapping, same shape as
// esp32-devkit-v1.ts's own. GPIO6-11 (silkscreened CMD/CLK/D0-D3, the SPI
// flash pins) are deliberately excluded - physically on the header but not
// safe general-purpose GPIO, same reasoning as esp32-devkit-v1.ts already
// excluding them.
export const esp32DevkitCV4Board: BoardPinMap = {
  ...Object.fromEntries(
    [2, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 34, 35].map((n) => [
      `${n}`,
      `${n}`,
    ]),
  ),
};
