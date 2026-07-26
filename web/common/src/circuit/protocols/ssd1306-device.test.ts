import { describe, expect, it, vi } from "vitest";
import { SSD1306Device, SSD1306_WIDTH, SSD1306_HEIGHT } from "./ssd1306-device.js";

const COMMAND_CONTROL_BYTE = 0x00;
const DATA_CONTROL_BYTE = 0x40;
const COLUMNADDR = 0x21;
const PAGEADDR = 0x22;

function sendCommands(device: SSD1306Device, commands: number[]): void {
  device.onSelected?.(true);
  device.writeByte(COMMAND_CONTROL_BYTE);
  for (const c of commands) device.writeByte(c);
  device.onStop?.();
}

function sendData(device: SSD1306Device, bytes: number[]): void {
  device.onSelected?.(true);
  device.writeByte(DATA_CONTROL_BYTE);
  for (const b of bytes) device.writeByte(b);
  device.onStop?.();
}

// Matches Adafruit_SSD1306's own display() sequence: always set the full
// column/page range before sending the framebuffer.
function fullRangeCommands(): number[] {
  return [COLUMNADDR, 0, SSD1306_WIDTH - 1, PAGEADDR, 0, SSD1306_HEIGHT / 8 - 1];
}

describe("SSD1306Device", () => {
  it("reports its own address (0x3c - the real SSD1306 default)", () => {
    expect(new SSD1306Device(() => {}).address).toBe(0x3c);
  });

  it("does not fire onFrame for a command-only transaction", () => {
    const onFrame = vi.fn();
    const device = new SSD1306Device(onFrame);
    sendCommands(device, [0xaf]); // DISPLAYON
    expect(onFrame).not.toHaveBeenCalled();
  });

  it("fires onFrame with a 1024-byte buffer after a data transaction", () => {
    const onFrame = vi.fn();
    const device = new SSD1306Device(onFrame);
    sendCommands(device, fullRangeCommands());
    sendData(device, [0xff, 0x00, 0x81]);
    expect(onFrame).toHaveBeenCalledTimes(1);
    const buffer = onFrame.mock.calls[0][0] as Uint8Array;
    expect(buffer.length).toBe((SSD1306_WIDTH * SSD1306_HEIGHT) / 8);
    expect(buffer[0]).toBe(0xff);
    expect(buffer[1]).toBe(0x00);
    expect(buffer[2]).toBe(0x81);
  });

  it("writes GDDRAM bytes sequentially starting from the reset pointer", () => {
    const onFrame = vi.fn();
    const device = new SSD1306Device(onFrame);
    // First frame moves the pointer forward.
    sendCommands(device, fullRangeCommands());
    sendData(device, [1, 2, 3]);
    // A second display() cycle re-issues the full-range commands, which
    // must reset the pointer back to 0 - matching real Adafruit_SSD1306
    // behavior (every display() call re-sets the addressing range).
    sendCommands(device, fullRangeCommands());
    sendData(device, [9, 9]);
    const buffer = onFrame.mock.calls.at(-1)![0] as Uint8Array;
    expect(buffer[0]).toBe(9);
    expect(buffer[1]).toBe(9);
    expect(buffer[2]).toBe(3); // untouched by the second, shorter write
  });

  it("wraps the write pointer at the buffer's own length without a range reset", () => {
    const onFrame = vi.fn();
    const device = new SSD1306Device(onFrame);
    const size = (SSD1306_WIDTH * SSD1306_HEIGHT) / 8;
    device.onSelected?.(true);
    device.writeByte(DATA_CONTROL_BYTE);
    for (let i = 0; i < size; i++) device.writeByte(0); // fill once
    device.writeByte(0x77); // one more byte - should wrap to index 0
    device.onStop?.();
    const buffer = onFrame.mock.calls.at(-1)![0] as Uint8Array;
    expect(buffer[0]).toBe(0x77);
  });

  it("accumulates across multiple chunked transactions of the same display() cycle", () => {
    const onFrame = vi.fn();
    const device = new SSD1306Device(onFrame);
    sendCommands(device, fullRangeCommands());
    sendData(device, [1, 2]); // chunk 1 - real libraries split large transfers
    sendData(device, [3, 4]); // chunk 2 - control byte re-sent, pointer persists
    const buffer = onFrame.mock.calls.at(-1)![0] as Uint8Array;
    expect([...buffer.slice(0, 4)]).toEqual([1, 2, 3, 4]);
  });

  it("readByte returns a fixed sentinel (write-only device in practice)", () => {
    const device = new SSD1306Device(() => {});
    expect(device.readByte()).toBe(0xff);
  });
});
