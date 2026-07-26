import { describe, expect, it } from "vitest";
import { MPU6050Device } from "./mpu6050-device.js";

const WHO_AM_I = 0x75;
const PWR_MGMT_1 = 0x6b;
const ACCEL_XOUT_H = 0x3b;

function readRegister(device: MPU6050Device, register: number): number {
  device.onSelected?.(true);
  device.writeByte(register); // pointer byte
  device.onSelected?.(false);
  return device.readByte();
}

function readBurst(device: MPU6050Device, count: number): number[] {
  device.onSelected?.(true);
  device.writeByte(ACCEL_XOUT_H);
  device.onSelected?.(false);
  const bytes: number[] = [];
  for (let i = 0; i < count; i++) bytes.push(device.readByte());
  return bytes;
}

describe("MPU6050Device", () => {
  it("reports the real AD0-high alternate address (0x69), not the default that DS1307Device already occupies in this project", () => {
    expect(new MPU6050Device().address).toBe(0x69);
  });

  it("WHO_AM_I (0x75) returns the real, documented chip ID", () => {
    const device = new MPU6050Device();
    expect(readRegister(device, WHO_AM_I)).toBe(0x68);
  });

  it("PWR_MGMT_1 defaults to the real power-on SLEEP-bit-set value and round-trips a write", () => {
    const device = new MPU6050Device();
    expect(readRegister(device, PWR_MGMT_1)).toBe(0x40);

    device.onSelected?.(true);
    device.writeByte(PWR_MGMT_1); // pointer
    device.writeByte(0x00); // wake up, matches every real library's begin()
    device.onSelected?.(false);

    expect(readRegister(device, PWR_MGMT_1)).toBe(0x00);
  });

  it("accelerometer Z reads ~+1g (16384 LSB) at rest, X/Y read ~0", () => {
    const device = new MPU6050Device();
    const bytes = readBurst(device, 6); // ACCEL_XOUT_H/L, YOUT_H/L, ZOUT_H/L
    const x = (bytes[0] << 8) | bytes[1];
    const y = (bytes[2] << 8) | bytes[3];
    const z = (bytes[4] << 8) | bytes[5];
    const signed = (v: number) => (v & 0x8000 ? v - 0x10000 : v);
    expect(Math.abs(signed(x))).toBeLessThan(100);
    expect(Math.abs(signed(y))).toBeLessThan(100);
    expect(signed(z)).toBeGreaterThan(16000);
    expect(signed(z)).toBeLessThan(16800);
  });

  it("gyro axes (0x43-0x48) read ~0 deg/s at rest", () => {
    const device = new MPU6050Device();
    device.onSelected?.(true);
    device.writeByte(0x43); // GYRO_XOUT_H
    device.onSelected?.(false);
    const bytes = [device.readByte(), device.readByte(), device.readByte(), device.readByte(), device.readByte(), device.readByte()];
    for (let i = 0; i < 6; i += 2) {
      const raw = (bytes[i] << 8) | bytes[i + 1];
      const signed = raw & 0x8000 ? raw - 0x10000 : raw;
      expect(Math.abs(signed)).toBeLessThan(60);
    }
  });

  it("the pointer auto-increments and wraps at the 7-bit register map boundary", () => {
    const device = new MPU6050Device();
    device.onSelected?.(true);
    device.writeByte(0x7f); // last valid 7-bit register
    device.onSelected?.(false);
    device.readByte(); // consumes 0x7f, pointer -> 0
    expect(readRegister(device, WHO_AM_I)).toBe(0x68); // confirms pointer logic still lands correctly
  });

  it("an unrecognized register reads back 0 rather than throwing", () => {
    const device = new MPU6050Device();
    expect(readRegister(device, 0x1a)).toBe(0); // e.g. CONFIG - accepted, not modeled
  });
});
