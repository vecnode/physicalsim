import type { BoardPinMap } from "./board.js";

// iot-esp32-cam's own pin markers (esp32-cam-element.ts, vendored from
// upstream wokwi/wokwi-boards) are bare GPIO numbers - this board's own
// real silkscreen. Identity mapping, same shape as esp32-devkit-v1.ts's
// own. GPIO0 (boot-mode strapping pin) is excluded, same precedent as
// esp32-devkit-v1.ts/esp32-devkit-c-v4.ts already excluding their own
// boot/flash pins - GPIO1/GPIO3 (TX/RX) aren't included either, matching
// esp32-devkit-v1.ts's own board map (serial pins aren't part of the
// digitalWrite-style wireable pin set there either, despite being drawn on
// the element).
export const esp32CamBoard: BoardPinMap = {
  ...Object.fromEntries([2, 4, 12, 13, 14, 15, 16].map((n) => [`${n}`, `${n}`])),
};
