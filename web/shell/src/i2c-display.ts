// Converts an SSD1306Device-decoded GDDRAM buffer (@physicalsim/common's
// circuit/protocols/ssd1306-device.ts - 1 bit/pixel, page-addressed, see
// that file's own doc comment for the real addressing convention this
// matches) into pixel writes on an existing ImageData - the shell-side
// half of the I2C display feature; the adapter/common side never touches
// the DOM at all (see adapter-types.ts's onI2CFrame? doc comment).
//
// Takes a narrow, ImageData-shaped parameter rather than the real
// ImageData type, so this stays testable in this project's node-only
// vitest environment (see i2c-display.test.ts) without constructing a
// real one.
export interface PixelBuffer {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export function paintSsd1306Frame(target: PixelBuffer, gddram: Uint8Array): void {
  const { data, width, height } = target;
  const pages = height / 8;
  for (let page = 0; page < pages; page++) {
    for (let col = 0; col < width; col++) {
      const byte = gddram[page * width + col] ?? 0;
      for (let bit = 0; bit < 8; bit++) {
        const on = (byte >> bit) & 1;
        const y = page * 8 + bit;
        const idx = (y * width + col) * 4;
        const value = on ? 255 : 0;
        data[idx] = value;
        data[idx + 1] = value;
        data[idx + 2] = value;
        data[idx + 3] = 255;
      }
    }
  }
}
