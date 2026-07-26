// The narrow shape a single I2C "device" needs to implement to sit behind
// an address-dispatching bus (web/adapters/{avr8,rp2040}/src/i2c-bus.ts) -
// deliberately agnostic to avr8js's AVRTWI/TWIEventHandler and rp2040js's
// RPI2C callback shapes (the two real peripheral APIs DS1307Device is
// still written directly against per-package, since it predates this
// interface and those two APIs are genuinely different enough that
// sharing one implementation across them isn't a clean fit - see each
// adapter's own ds1307.ts). A device written only against *this* shape
// needs no adapter-specific knowledge at all, so - unlike DS1307Device -
// it's genuinely reusable: MPU6050Device and SSD1306Device below are
// implemented once here and used by both adapter packages' own I2CBus.
export interface I2CSubDevice {
  // The 7-bit address this device answers to - I2CBus (per-adapter)
  // dispatches an incoming transaction to whichever registered device's
  // address matches, the same way multiple real chips share one physical
  // bus.
  readonly address: number;
  // Called once per transaction, right after this device is selected
  // (address + R/W bit acknowledged) - `write` is the I2C direction the
  // master requested (true = master will write to this device). Optional:
  // a device with no per-transaction state to reset (none exist yet) can
  // omit it.
  onSelected?(write: boolean): void;
  // One byte written by the master while this device is selected. I2CBus
  // always ACKs once a device is selected (real I2C has no per-byte NACK
  // from a slave that's already been addressed successfully, for any
  // device modeled here) - this returns nothing because there's nothing
  // to report back.
  writeByte(value: number): void;
  // One byte requested by the master while this device is selected.
  readByte(): number;
  // Called on I2C STOP, only while this device was the selected one -
  // the natural point to commit/publish anything accumulated during the
  // transaction (SSD1306Device uses this to flush a completed GDDRAM
  // write out as a frame). Optional: most devices need no end-of-
  // transaction action.
  onStop?(): void;
}
