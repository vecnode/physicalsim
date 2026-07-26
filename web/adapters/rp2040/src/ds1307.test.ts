import { describe, expect, it, vi } from "vitest";
import { DS1307Device } from "./ds1307.js";
import { I2CBus } from "./i2c-bus.js";

// A minimal fake of the exact RPI2C surface I2CBus actually uses (the 5
// on*/complete* callback pairs) rather than the real RPI2C - that class is
// a full DesignWare-style I2C controller with its own FIFO/register state
// machine (see i2c.ts), which would make driving a register-level test
// here mostly an exercise in re-deriving RPI2C's own internals rather than
// testing I2CBus/DS1307Device's protocol logic. This fake plays the same
// role a real RPI2C would from I2CBus's point of view: it's the thing
// I2CBus installs callbacks onto and calls complete*() back into.
//
// DS1307Device itself no longer touches any of this directly (see that
// file's own updated doc comment) - this test now exercises I2CBus +
// DS1307Device together, which is a closer match to how
// Rp2040Adapter's constructor actually wires them.
function fakeI2C() {
  return {
    onStart: undefined as ((repeatedStart: boolean) => void) | undefined,
    onConnect: undefined as ((address: number, mode: number) => void) | undefined,
    onWriteByte: undefined as ((value: number) => void) | undefined,
    onReadByte: undefined as ((ack: boolean) => void) | undefined,
    onStop: undefined as (() => void) | undefined,
    completeStart: vi.fn(),
    completeConnect: vi.fn(),
    completeWrite: vi.fn(),
    completeRead: vi.fn(),
    completeStop: vi.fn(),
  };
}

// Drives the same real-world sequence adapter.test.ts's avr8 DS1307
// tests do (START, connect SLA+W, pointer byte, repeated START, connect
// SLA+R, read byte(s)) - just through direct callback invocation instead
// of CPU register pokes, since there's no CPU here to speak of.
function readRegister(i2c: ReturnType<typeof fakeI2C>, reg: number): number {
  i2c.onStart?.(false);
  i2c.onConnect?.(0x68, 0 /* I2CMode.Write */);
  i2c.onWriteByte?.(reg);
  i2c.onStart?.(true); // repeated start
  i2c.onConnect?.(0x68, 1 /* I2CMode.Read */);
  i2c.onReadByte?.(true);
  return i2c.completeRead.mock.calls.at(-1)![0] as number;
}

describe("DS1307Device (rp2040)", () => {
  it("acks a start unconditionally", () => {
    const i2c = fakeI2C();
    new I2CBus(i2c as never, [new DS1307Device()]);
    i2c.onStart?.(false);
    expect(i2c.completeStart).toHaveBeenCalledTimes(1);
  });

  it("acks its own address (0x68) and NACKs any other", () => {
    const i2c = fakeI2C();
    new I2CBus(i2c as never, [new DS1307Device()]);

    i2c.onConnect?.(0x68, 0);
    expect(i2c.completeConnect).toHaveBeenLastCalledWith(true);

    i2c.onConnect?.(0x50, 0);
    expect(i2c.completeConnect).toHaveBeenLastCalledWith(false);
  });

  it("register 0 (seconds) reads back a valid BCD seconds value", () => {
    const i2c = fakeI2C();
    new I2CBus(i2c as never, [new DS1307Device()]);

    const value = readRegister(i2c, 0);
    const high = value >> 4;
    const low = value & 0xf;
    expect(high).toBeLessThanOrEqual(5);
    expect(low).toBeLessThanOrEqual(9);
    expect(high * 10 + low).toBeLessThanOrEqual(59);
  });

  it("NVRAM (register 0x08+) round-trips a written byte", () => {
    const i2c = fakeI2C();
    new I2CBus(i2c as never, [new DS1307Device()]);

    i2c.onStart?.(false);
    i2c.onConnect?.(0x68, 0);
    i2c.onWriteByte?.(0x08); // pointer
    i2c.onWriteByte?.(0x42); // data
    i2c.onStop?.();

    expect(readRegister(i2c, 0x08)).toBe(0x42);
  });

  it("ignores writes while not addressed (deselected after a NACK'd connect)", () => {
    const i2c = fakeI2C();
    new I2CBus(i2c as never, [new DS1307Device()]);

    i2c.onConnect?.(0x50, 0); // not the DS1307 - NACK'd
    i2c.onWriteByte?.(0x99);
    expect(i2c.completeWrite).toHaveBeenLastCalledWith(false);
  });
});
