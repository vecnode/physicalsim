import type { I2CSubDevice } from "@physicalsim/common";

// A minimal DS1307 RTC, emulated as an I2C slave - decoded from the
// datasheet's own register map (0x00-0x06 BCD clock/calendar, 0x07
// control, 0x08-0x3F battery-backed NVRAM), not general RTClib folklore.
//
// Deliberately simplified, not cycle-accurate, matching the posture
// AVRUSART's own onByteTransmit already takes (see adapter.ts's comment
// on it): the clock registers (0x00-0x06) are always computed live from
// the *host machine's* wall-clock time on every read, never from
// whatever a sketch last wrote there. A sketch that calls rtc.adjust()
// to set a specific time will see its write accepted and ack'd
// correctly (the I2C protocol itself is real), but a subsequent read
// still reports real wall-clock time, not the time it just set - a
// documented tradeoff, not a silent gap. NVRAM (0x08-0x3F) has no such
// caveat: it's plain read/write storage, exactly like the real chip's.
//
// Bound unconditionally, at this real fixed address, in
// Avr8Adapter.attachPeripherals() (via I2CBus - see i2c-bus.ts) - I2C is
// address-based, not wire-routed (a real I2C bus has every device
// listening for its own address on the same two wires), so "the chip is
// present" doesn't depend on whether a wokwi-ds1307 element happens to
// be placed and wired on the canvas, the same way Serial output doesn't
// depend on whether the Serial Monitor pane is open.
const DS1307_ADDRESS = 0x68;
const REGISTER_COUNT = 64; // 0x00-0x3F: 8 clock/control bytes + 56 NVRAM bytes

function toBcd(value: number): number {
  return ((Math.floor(value / 10) % 10) << 4) | (value % 10);
}

export class DS1307Device implements I2CSubDevice {
  readonly address = DS1307_ADDRESS;
  private readonly registers = new Uint8Array(REGISTER_COUNT);
  private pointer = 0;
  // The DS1307 protocol always starts a transaction with the master
  // sending a register-pointer byte before any data byte - this tracks
  // which of those two writeByte() means, reset every time this device is
  // freshly selected, the same way the real chip's own state machine does.
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
    this.registers[2] = toBcd(now.getHours()); // bit6=0: 24-hour mode
    this.registers[3] = now.getDay() + 1; // DS1307 counts 1-7
    this.registers[4] = toBcd(now.getDate());
    this.registers[5] = toBcd(now.getMonth() + 1);
    this.registers[6] = toBcd(now.getFullYear() % 100);
  }
}
