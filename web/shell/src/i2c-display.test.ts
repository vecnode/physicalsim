import { describe, expect, it } from "vitest";
import { paintSsd1306Frame, type PixelBuffer } from "./i2c-display.js";

function blankBuffer(width: number, height: number): PixelBuffer {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

describe("paintSsd1306Frame", () => {
  it("paints a set bit as opaque white and a clear bit as opaque black", () => {
    const target = blankBuffer(8, 8);
    const gddram = new Uint8Array(8); // 8x8 = one page, 8 columns
    gddram[0] = 0b00000001; // column 0: only bit 0 (y=0) set

    paintSsd1306Frame(target, gddram);

    const at = (x: number, y: number) => {
      const idx = (y * target.width + x) * 4;
      return [target.data[idx], target.data[idx + 1], target.data[idx + 2], target.data[idx + 3]];
    };
    expect(at(0, 0)).toEqual([255, 255, 255, 255]); // bit 0 set - on
    expect(at(0, 1)).toEqual([0, 0, 0, 255]); // bit 1 clear - off, still opaque
  });

  it("maps GDDRAM byte index to (page, column) in row-major page order", () => {
    const target = blankBuffer(128, 16); // 2 pages
    const gddram = new Uint8Array((128 * 16) / 8);
    gddram[128] = 0xff; // first byte of page 1, column 0 -> y = 8..15 all on

    paintSsd1306Frame(target, gddram);

    const idxAt = (x: number, y: number) => (y * target.width + x) * 4;
    expect(target.data[idxAt(0, 8)]).toBe(255);
    expect(target.data[idxAt(0, 0)]).toBe(0); // page 0, untouched
  });

  it("treats a missing (out-of-range) GDDRAM byte as all-off rather than throwing", () => {
    const target = blankBuffer(8, 8);
    const gddram = new Uint8Array(0); // deliberately too short
    expect(() => paintSsd1306Frame(target, gddram)).not.toThrow();
    expect(target.data[3]).toBe(255); // still opaque
    expect(target.data[0]).toBe(0);
  });
});
