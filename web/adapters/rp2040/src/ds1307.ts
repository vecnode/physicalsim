import type { I2CSubDevice } from "@physicalsim/common";

// RP2040 counterpart to web/adapters/avr8/src/ds1307.ts - the exact same
// DS1307 register-level behavior (0x00-0x06 BCD clock/calendar, 0x07
// control, 0x08-0x3F NVRAM). Both packages' devices now implement the same
// shared I2CSubDevice shape (@physicalsim/common) - this one stayed a
// deliberate near-duplicate rather than moving into common alongside
// MPU6050Device/SSD1306Device, since it already existed and was already
// tested against this package's own ds1307.test.ts; the two files are
// identical logic now that both bus classes (i2c-bus.ts, avr8's and
// rp2040's) handle the peripheral-specific completeConnect()/
// completeWrite()/etc. calls instead of this class doing it directly.
// See that file's own comment for why the clock registers are live-wall-
// clock-time-on-read rather than tracking whatever a sketch last wrote.
//
// Bound unconditionally to I2C0 in Rp2040Adapter's constructor (via
// I2CBus - see i2c-bus.ts) - I2C is address-based, not wire-routed, so
// "the chip is present" doesn't depend on anything being placed on the
// canvas, same reasoning as the avr8 version.
const DS1307_ADDRESS = 0x68;
const REGISTER_COUNT = 64;

function toBcd(value: number): number {
  return ((Math.floor(value / 10) % 10) << 4) | (value % 10);
}

export class DS1307Device implements I2CSubDevice {
  readonly address = DS1307_ADDRESS;
  private readonly registers = new Uint8Array(REGISTER_COUNT);
  private pointer = 0;
  private expectingPointerByte = true;

  onSelected(): void {
    this.expectingPointerByte = true;
  }

  writeByte(value: number): void {
    if (this.expectingPointerByte) {
      this.pointer = value % REGISTER_COUNT;
      this.expectingPointerByte = false;
    } else {
      this.registers[this.pointer] = value;
      this.pointer = (this.pointer + 1) % REGISTER_COUNT;
    }
  }

  readByte(): number {
    if (this.pointer < 7) this.refreshClockRegisters();
    const value = this.registers[this.pointer];
    this.pointer = (this.pointer + 1) % REGISTER_COUNT;
    return value;
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
