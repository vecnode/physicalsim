import type { I2CSubDevice } from "@physicalsim/common";
import type { I2CController } from "rp2040js/pico";

// Dispatches rp2040js/pico's i2c_write_blocking()/i2c_read_blocking() (a
// whole-buffer-at-a-time call, unlike avr8js's own interrupt-driven,
// byte-at-a-time AVRTWI protocol - see web/adapters/avr8/src/i2c-bus.ts's
// own start/stop/connectToSlave/writeByte/readByte shape) to whichever
// registered device's address matches, the same way multiple real chips
// share one physical bus. Devices only need to implement the adapter-
// agnostic I2CSubDevice shape (@physicalsim/common) - SSD1306Device and
// MPU6050Device are already written against it and reused here unchanged.
export class I2CBus implements I2CController {
  constructor(private readonly devices: readonly I2CSubDevice[]) {}

  writeBlocking(addr: number, bytes: readonly number[], nostop: boolean): number {
    const device = this.devices.find((d) => d.address === addr);
    if (!device) return -1; // No device acked - PICO_ERROR_GENERIC-shaped, matching real i2c_write_blocking()'s return convention.
    device.onSelected?.(true);
    for (const byte of bytes) device.writeByte(byte);
    if (!nostop) device.onStop?.();
    return bytes.length;
  }

  readBlocking(addr: number, length: number, nostop: boolean): number[] {
    const device = this.devices.find((d) => d.address === addr);
    if (!device) return [];
    device.onSelected?.(false);
    const result: number[] = [];
    for (let i = 0; i < length; i++) result.push(device.readByte());
    if (!nostop) device.onStop?.();
    return result;
  }
}
