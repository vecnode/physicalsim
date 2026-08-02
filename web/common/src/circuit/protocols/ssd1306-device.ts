import type { I2CSubDevice } from "../i2c-sub-device.js";

// Real SSD1306 I2C protocol decoder, shared by both adapter packages -
// see i2c-sub-device.ts's own doc comment for why this one (unlike
// DS1307Device) is written once instead of duplicated per package.
//
// Per the datasheet (section 8.1.5.2) and confirmed against what
// mainstream Arduino OLED libraries (Adafruit_SSD1306, u8g2) actually
// send: the first byte of every write transaction is a "control byte"
// (Co / D-C# bits) saying whether what follows is commands (0x00) or
// GDDRAM pixel data (0x40) - decoded below into a running 1024-byte
// (128x64, monochrome, 1 bit/pixel) buffer. onFrame() fires with a copy
// of that buffer on every I2C STOP that followed at least one data byte -
// the shell side (web/shell/src/i2c-display-chain.ts) turns it into the
// placed iot-ssd1306 element's own ImageData.
//
// Two deliberate simplifications, both documented rather than silent:
// - Doesn't implement the Co=1 "one byte, then another control byte"
//   mode - rare in practice; every mainstream library sends one control
//   byte per whole transaction (Co=0), which is what's implemented here.
// - Doesn't track independent column/page address *ranges* from
//   SETCOLUMNADDR(0x21)/SETPAGEADDR(0x22) - Adafruit_SSD1306's own
//   display() always sets the full 0-127/0-7 range before sending data
//   (confirmed against its source), so resetting the write pointer to 0
//   specifically on that pair of commands (see below) reproduces the
//   real, common-case addressing behavior without a full command
//   interpreter, the same posture Hd44780Decoder's own un-implemented
//   CGRAM/scroll commands take.
const SSD1306_ADDRESS = 0x3c;
export const SSD1306_WIDTH = 128;
export const SSD1306_HEIGHT = 64;
const GDDRAM_BYTES = (SSD1306_WIDTH * SSD1306_HEIGHT) / 8; // 1024 - 1 bit/pixel

const COLUMNADDR = 0x21;
const PAGEADDR = 0x22;

export class SSD1306Device implements I2CSubDevice {
  readonly address = SSD1306_ADDRESS;
  private readonly gddram = new Uint8Array(GDDRAM_BYTES);
  // The running GDDRAM write pointer (0..1023) - real hardware auto-
  // increments this on every data byte and wraps at the addressing
  // range's end; since the range is always assumed to be the full screen
  // (see class doc), it simply wraps at the buffer's own length.
  private pointer = 0;
  private mode: "command" | "data" = "command";
  private expectingControlByte = true;
  // Tracks a COLUMNADDR/PAGEADDR command's two argument bytes (start,
  // end) while they're being received, so they're consumed as arguments
  // rather than mis-read as the next command's opcode.
  private pendingRangeCommand: { op: number; args: number[] } | null = null;
  private wroteDataThisTransaction = false;

  constructor(private readonly onFrame: (gddram: Uint8Array) => void) {}

  onSelected(_write: boolean): void {
    this.expectingControlByte = true;
    this.pendingRangeCommand = null;
    this.wroteDataThisTransaction = false;
  }

  writeByte(value: number): void {
    if (this.expectingControlByte) {
      this.mode = (value & 0x40) !== 0 ? "data" : "command";
      this.expectingControlByte = false;
      return;
    }

    if (this.mode === "data") {
      this.gddram[this.pointer] = value;
      this.pointer = (this.pointer + 1) % GDDRAM_BYTES;
      this.wroteDataThisTransaction = true;
      return;
    }

    if (this.pendingRangeCommand) {
      this.pendingRangeCommand.args.push(value);
      if (this.pendingRangeCommand.args.length === 2) {
        if (this.pendingRangeCommand.op === PAGEADDR && this.pendingRangeCommand.args[0] === 0) {
          this.pointer = 0;
        }
        this.pendingRangeCommand = null;
      }
      return;
    }
    if (value === COLUMNADDR || value === PAGEADDR) {
      this.pendingRangeCommand = { op: value, args: [] };
      return;
    }
    // Every other command byte (display on/off, contrast, memory mode,
    // etc.) - accepted, not interpreted (see class doc).
  }

  readByte(): number {
    // Every real driver this project targets only ever writes to an
    // SSD1306 over I2C - there's no meaningful byte to return.
    return 0xff;
  }

  onStop(): void {
    // A copy, not the live buffer - onFrame()'s caller may hold onto this
    // beyond the synchronous callback (postMessage across a Worker
    // boundary already copies it via structured clone, but a same-thread
    // caller shouldn't have to know that to be safe against this buffer
    // mutating again on the next transaction).
    if (this.wroteDataThisTransaction) this.onFrame(this.gddram.slice());
  }
}
