import type { RPI2C } from "rp2040js";

// RP2040 counterpart to web/adapters/avr8/src/ds1307.ts - the exact same
// DS1307 register-level behavior (0x00-0x06 BCD clock/calendar, 0x07
// control, 0x08-0x3F NVRAM), reimplemented against RPI2C's own callback
// shape (`onStart`/`onConnect`/`onWriteByte`/`onReadByte`/`onStop`)
// rather than avr8js's TWIEventHandler interface - genuinely different
// APIs (flat callbacks here vs. an interface object there), not worth a
// shared base for one device, so this is a deliberate near-duplicate of
// that file rather than a premature shared abstraction. See that file's
// own comment for why the clock registers are live-wall-clock-time-on-
// read rather than tracking whatever a sketch last wrote.
//
// Bound unconditionally to I2C0 in Rp2040Adapter's constructor - I2C is
// address-based, not wire-routed, so "the chip is present" doesn't
// depend on anything being placed on the canvas, same reasoning as the
// avr8 version.
const DS1307_ADDRESS = 0x68;
const REGISTER_COUNT = 64;

function toBcd(value: number): number {
  return ((Math.floor(value / 10) % 10) << 4) | (value % 10);
}

export class DS1307Device {
  private readonly registers = new Uint8Array(REGISTER_COUNT);
  private pointer = 0;
  private expectingPointerByte = true;
  private selected = false;

  constructor(private readonly i2c: RPI2C) {
    i2c.onStart = (_repeatedStart) => i2c.completeStart();
    i2c.onConnect = (address, _mode) => {
      this.selected = address === DS1307_ADDRESS;
      this.expectingPointerByte = true;
      i2c.completeConnect(this.selected);
    };
    i2c.onWriteByte = (value) => {
      if (!this.selected) {
        i2c.completeWrite(false);
        return;
      }
      if (this.expectingPointerByte) {
        this.pointer = value % REGISTER_COUNT;
        this.expectingPointerByte = false;
      } else {
        this.registers[this.pointer] = value;
        this.pointer = (this.pointer + 1) % REGISTER_COUNT;
      }
      i2c.completeWrite(true);
    };
    i2c.onReadByte = (_ack) => {
      if (!this.selected) {
        i2c.completeRead(0xff);
        return;
      }
      if (this.pointer < 7) this.refreshClockRegisters();
      const value = this.registers[this.pointer];
      this.pointer = (this.pointer + 1) % REGISTER_COUNT;
      i2c.completeRead(value);
    };
    i2c.onStop = () => i2c.completeStop();
  }

  private refreshClockRegisters(): void {
    const now = new Date();
    this.registers[0] = toBcd(now.getSeconds());
    this.registers[1] = toBcd(now.getMinutes());
    this.registers[2] = toBcd(now.getHours());
    this.registers[3] = now.getDay() + 1;
    this.registers[4] = toBcd(now.getDate());
    this.registers[5] = toBcd(now.getMonth() + 1);
    this.registers[6] = toBcd(now.getFullYear() % 100);
  }
}
