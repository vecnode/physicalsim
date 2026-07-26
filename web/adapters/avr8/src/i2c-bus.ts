import type { AVRTWI, TWIEventHandler } from "avr8js";
import type { I2CSubDevice } from "@physicalsim/common";

// Dispatches AVRTWI's single eventHandler slot across several devices by
// address - avr8js only has one `AVRTWI.eventHandler` at a time (see
// adapter.ts's attachPeripherals()), the same way a real MCU has one I2C
// peripheral shared by every chip on the bus. This is what lets DS1307Device
// (0x68) and SSD1306Device (0x3c) - and, address permitting, MPU6050Device
// (also 0x68 by default in real hardware - see that file's own comment on
// why that's a genuine, not invented, collision) - coexist behind that one
// slot, each implementing only the narrow I2CSubDevice shape (@physicalsim/
// common) rather than avr8js's own TWIEventHandler interface directly.
export class I2CBus implements TWIEventHandler {
  private selected: I2CSubDevice | undefined;

  constructor(
    private readonly twi: AVRTWI,
    private readonly devices: readonly I2CSubDevice[],
  ) {}

  start(_repeatedStart: boolean): void {
    this.twi.completeStart();
  }

  stop(): void {
    this.selected?.onStop?.();
    this.twi.completeStop();
  }

  connectToSlave(address: number, write: boolean): void {
    this.selected = this.devices.find((d) => d.address === address);
    this.selected?.onSelected?.(write);
    this.twi.completeConnect(this.selected !== undefined);
  }

  writeByte(value: number): void {
    if (!this.selected) {
      this.twi.completeWrite(false);
      return;
    }
    this.selected.writeByte(value);
    this.twi.completeWrite(true);
  }

  readByte(_ack: boolean): void {
    this.twi.completeRead(this.selected ? this.selected.readByte() : 0xff);
  }
}
