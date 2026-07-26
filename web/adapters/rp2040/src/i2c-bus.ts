import type { RPI2C } from "rp2040js";
import { I2CMode } from "rp2040js";
import type { I2CSubDevice } from "@physicalsim/common";

// RP2040 counterpart to web/adapters/avr8/src/i2c-bus.ts - same address-
// dispatching idea, wired against RPI2C's flat callback shape
// (`onStart`/`onConnect`/`onWriteByte`/`onReadByte`/`onStop`) instead of
// avr8js's TWIEventHandler interface object. Genuinely different enough
// APIs that sharing one implementation isn't a clean fit (the same reason
// ds1307.ts is a deliberate near-duplicate per adapter, not a shared
// class) - but the *devices* behind it (DS1307Device, MPU6050Device,
// SSD1306Device) only ever implement the shared, adapter-agnostic
// I2CSubDevice shape, so those really are shared (see @physicalsim/
// common's circuit/i2c-sub-device.ts).
export class I2CBus {
  private selected: I2CSubDevice | undefined;

  constructor(
    private readonly i2c: RPI2C,
    private readonly devices: readonly I2CSubDevice[],
  ) {
    i2c.onStart = (_repeatedStart) => i2c.completeStart();
    i2c.onConnect = (address, mode) => {
      this.selected = this.devices.find((d) => d.address === address);
      this.selected?.onSelected?.(mode === I2CMode.Write);
      i2c.completeConnect(this.selected !== undefined);
    };
    i2c.onWriteByte = (value) => {
      if (!this.selected) {
        i2c.completeWrite(false);
        return;
      }
      this.selected.writeByte(value);
      i2c.completeWrite(true);
    };
    i2c.onReadByte = (_ack) => {
      i2c.completeRead(this.selected ? this.selected.readByte() : 0xff);
    };
    i2c.onStop = () => {
      this.selected?.onStop?.();
      i2c.completeStop();
    };
  }
}
