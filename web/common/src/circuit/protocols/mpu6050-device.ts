import type { I2CSubDevice } from "../i2c-sub-device.js";

// Minimal MPU6050 (accel/gyro) register-level I2C decoder, shared by both
// adapter packages (web/adapters/{avr8,rp2040}/src/i2c-bus.ts each bind
// one instance) - see i2c-sub-device.ts's own doc comment for why this
// one, unlike DS1307Device, is written once instead of duplicated.
//
// The MPU6050's real *default* bus address is 0x68 - also DS1307Device's
// real, fixed address, already shipped and tested in this project. Both
// defaults being 0x68 is a genuine real-hardware fact (a real MPU6050
// breakout's AD0 pin has to be tied high, selecting 0x69, to share a bus
// with a DS1307 or anything else already at 0x68), not something
// physicalsim invented. But I2CBus's dispatch (see that file) is
// first-match-by-address across a flat device list, not a real
// electrical bus where an unresolvable address conflict would just mean
// both chips answer (or neither reliably does) - so leaving both devices
// registered at 0x68 here would make MPU6050Device permanently
// unreachable behind the already-registered DS1307Device, not "whichever
// one a sketch addresses" the way real hardware would at least attempt.
// Since DS1307 was here first, this binds MPU6050 at its real AD0-high
// alternate address (0x69) instead - a sketch using a library's
// `MPU6050_ADDRESS_AD0_HIGH`/explicit-0x69 constant (which every
// mainstream MPU6050 library ships, precisely for this real-world
// scenario) addresses it correctly.
const MPU6050_BUS_ADDRESS = 0x69;
// WHO_AM_I is a fixed, burned-in chip identity - real hardware returns
// 0x68 here regardless of which address (0x68 or 0x69) the chip is
// actually wired to answer on (a real, documented MPU6050 quirk, not a
// simplification), so this is intentionally a different constant from
// the bus address above, not a copy/paste of it.
const WHO_AM_I_VALUE = 0x68;
//
// What this actually buys, given iot-mpu6050 has no tilt/shake
// interaction to sample from (see COMPONENTS.md - the placed element is
// only a static illustration plus one boolean-driven LED, unlike a
// joystick's real analog axes): register-protocol correctness for a
// genuine MPU6050/I2Cdev-style Arduino library. WHO_AM_I (0x75) returns
// the chip's real, documented ID, which is exactly what these libraries'
// testConnection()/who-am-I checks assert before doing anything else;
// accelerometer/gyro reads return realistic "resting flat, not moving"
// values (Z axis ~+1g at the default +-2g sensitivity, everything else
// ~0) with a small jitter, rather than all-zero or garbage - a documented
// simplification (there's no physical motion to sample, the same posture
// DS1307Device's own live-wall-clock-instead-of-settable-time already
// takes), not a claim that this is a real, drivable sensor feed.
const WHO_AM_I = 0x75;
const PWR_MGMT_1 = 0x6b;
// Register map, datasheet section 6.1: six pairs of accel/gyro high/low
// bytes plus one temperature pair, all big-endian int16, starting here and
// running contiguously through 0x48.
const ACCEL_XOUT_H = 0x3b;
const BURST_REGISTER_COUNT = 14; // 0x3b..0x48 inclusive

function jitter(amplitude: number): number {
  return Math.round((Math.random() - 0.5) * 2 * amplitude);
}

// Index order matches the real register layout starting at ACCEL_XOUT_H:
// accel X/Y/Z, temperature, gyro X/Y/Z - one entry per 16-bit register
// pair.
const ACCEL_X = 0;
const ACCEL_Y = 1;
const ACCEL_Z = 2;
const TEMP = 3;
const SAMPLE_COUNT = 7;

export class MPU6050Device implements I2CSubDevice {
  readonly address = MPU6050_BUS_ADDRESS;
  private pointer = 0;
  private expectingPointerByte = true;
  // Real power-on default has the SLEEP bit set (0x40) - stored, not
  // acted on (nothing here models a sleeping vs. awake state), purely so
  // a sketch's own wake-up write (`writeByte(PWR_MGMT_1, 0)`, what every
  // MPU6050 library's begin()/initialize() does) reads back what it just
  // wrote instead of a value that never changes.
  private pwrMgmt1 = 0x40;
  // One coherent accel/gyro/temp snapshot, refreshed once per transaction
  // (onSelected(), below) rather than resampled on every individual byte
  // read - a real burst read (`Wire.requestFrom(MPU6050, 14)`, what every
  // library actually does) reads a high byte and its low byte as one
  // sample, and generating fresh random jitter separately for each half
  // of the same 16-bit value would produce an incoherent, garbage-looking
  // number when the two bytes are recombined. Int16Array (not a plain
  // number[]) so each entry is already correctly range-limited/two's-
  // complement-wrapped the moment it's assigned.
  private readonly sample = new Int16Array(SAMPLE_COUNT);

  constructor() {
    this.refreshSample();
  }

  onSelected(_write: boolean): void {
    this.expectingPointerByte = true;
    this.refreshSample();
  }

  private refreshSample(): void {
    this.sample[ACCEL_X] = jitter(50);
    this.sample[ACCEL_Y] = jitter(50);
    // Resting flat: +1g at the default +-2g sensitivity (16384 LSB/g).
    this.sample[ACCEL_Z] = 16384 + jitter(50);
    // Datasheet formula: Temp(degC) = raw/340 + 36.53 - informational,
    // not read by every library, but real enough to not be all-zero.
    this.sample[TEMP] = Math.round((25 - 36.53) * 340) + jitter(20);
    // Gyro X/Y/Z (indices 4-6): at rest, ~0 deg/s.
    this.sample[4] = jitter(20);
    this.sample[5] = jitter(20);
    this.sample[6] = jitter(20);
  }

  writeByte(value: number): void {
    if (this.expectingPointerByte) {
      this.pointer = value & 0x7f; // the MPU6050's register map is 7-bit (0x00-0x75)
      this.expectingPointerByte = false;
      return;
    }
    if (this.pointer === PWR_MGMT_1) this.pwrMgmt1 = value;
    this.pointer = (this.pointer + 1) & 0x7f;
  }

  readByte(): number {
    const value = this.registerValue(this.pointer);
    this.pointer = (this.pointer + 1) & 0x7f;
    return value;
  }

  private registerValue(register: number): number {
    if (register === WHO_AM_I) return WHO_AM_I_VALUE;
    if (register === PWR_MGMT_1) return this.pwrMgmt1;

    const offset = register - ACCEL_XOUT_H;
    if (offset < 0 || offset >= BURST_REGISTER_COUNT) {
      // Every other register (sample-rate divider, config, offsets, FIFO,
      // interrupt config, etc.) - accepted (writeByte() above never
      // rejects a byte), just not modeled: reads back 0.
      return 0;
    }

    const axisIndex = Math.floor(offset / 2);
    const isHighByte = offset % 2 === 0;
    const unsigned = this.sample[axisIndex] & 0xffff;
    return isHighByte ? (unsigned >> 8) & 0xff : unsigned & 0xff;
  }
}
