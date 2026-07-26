import { beforeEach, describe, expect, it, vi } from "vitest";
import { Rp2040Adapter } from "./adapter.js";

// rp2040js's index.ts doesn't export FUNCTION_SIO (see gpio-pin.ts) - inline
// its value rather than reaching into the submodule's internal module path.
const FUNCTION_SIO = 5;

// RP2040 internals accessed directly to drive a pin as SIO would (the same
// path real firmware doing gpio_put()/gpio_set_dir() takes), exercising the
// exact hook subscribePin() wires onPinChange through, without needing a
// compiled firmware image.
function mcuOf(adapter: Rp2040Adapter) {
  return (
    adapter as unknown as {
      mcu: {
        gpio: { ctrl: number; checkForUpdates(): void }[];
        sio: { gpioOutputEnable: number; gpioValue: number };
      };
    }
  ).mcu;
}

describe("Rp2040Adapter pin I/O", () => {
  let adapter: Rp2040Adapter;

  beforeEach(async () => {
    adapter = new Rp2040Adapter();
    await adapter.init(undefined);
  });

  it("writePin drives an input pin's value, readable via readPin", () => {
    expect(adapter.readPin("GP2")).toBe(0);
    adapter.writePin("GP2", 1);
    expect(adapter.readPin("GP2")).toBe(1);
    adapter.writePin("GP2", 0);
    expect(adapter.readPin("GP2")).toBe(0);
  });

  it("onPinChange fires when writePin changes a pin's value, not when it doesn't", () => {
    const cb = vi.fn();
    const unsubscribe = adapter.onPinChange("GP2", cb);

    adapter.writePin("GP2", 1);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(1);

    adapter.writePin("GP2", 1); // no change
    expect(cb).toHaveBeenCalledTimes(1);

    unsubscribe();
    adapter.writePin("GP2", 0);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("onPinChange fires when firmware drives an output pin via SIO (simulated firmware write)", () => {
    const cb = vi.fn();
    adapter.onPinChange("GP25", cb);

    const mcu = mcuOf(adapter);
    const bit = 1 << 25;
    mcu.gpio[25].ctrl = FUNCTION_SIO;
    mcu.sio.gpioOutputEnable |= bit;
    mcu.sio.gpioValue |= bit;
    mcu.gpio[25].checkForUpdates();

    expect(cb).toHaveBeenCalledWith(1);
    expect(adapter.readPin("GP25")).toBe(1);

    mcu.sio.gpioValue &= ~bit;
    mcu.gpio[25].checkForUpdates();
    expect(cb).toHaveBeenLastCalledWith(0);
  });

  it("readPinDirection reports input by default (real hardware reset state) and output once firmware enables it via SIO", () => {
    expect(adapter.readPinDirection("GP25")).toBe("input");

    const mcu = mcuOf(adapter);
    const bit = 1 << 25;
    mcu.gpio[25].ctrl = FUNCTION_SIO;
    mcu.sio.gpioOutputEnable |= bit;
    mcu.gpio[25].checkForUpdates();

    expect(adapter.readPinDirection("GP25")).toBe("output");
    // A different, untouched pin stays input - direction is per-pin.
    expect(adapter.readPinDirection("GP2")).toBe("input");
  });

  it("resolvePin rejects malformed or out-of-range pin ids", () => {
    expect(() => adapter.readPin("B5")).toThrow();
    expect(() => adapter.readPin("GP99")).toThrow();
  });
});

function adcOf(adapter: Rp2040Adapter) {
  return (adapter as unknown as { mcu: { adc: { channelValues: number[] } } }).mcu.adc;
}

describe("Rp2040Adapter analog input (GPIO26-29)", () => {
  let adapter: Rp2040Adapter;

  beforeEach(async () => {
    adapter = new Rp2040Adapter();
    await adapter.init(undefined);
  });

  it("writeAnalogPin scales 0..3.3V onto the ADC's raw 12-bit channelValues", () => {
    adapter.writeAnalogPin("GP26", 3.3); // channel 0, full scale
    expect(adcOf(adapter).channelValues[0]).toBe(0xfff);

    adapter.writeAnalogPin("GP27", 0); // channel 1
    expect(adcOf(adapter).channelValues[1]).toBe(0);

    adapter.writeAnalogPin("GP29", 1.65); // channel 3, mid-rail
    expect(adcOf(adapter).channelValues[3]).toBeCloseTo(0x800, -1);
  });

  it("clamps out-of-range voltages to 0..3.3", () => {
    adapter.writeAnalogPin("GP26", 10);
    expect(adcOf(adapter).channelValues[0]).toBe(0xfff);
    adapter.writeAnalogPin("GP26", -1);
    expect(adcOf(adapter).channelValues[0]).toBe(0);
  });

  it("rejects a pin outside GP26-29", () => {
    expect(() => adapter.writeAnalogPin("GP2", 1)).toThrow(/ADC-capable/);
  });
});

describe("Rp2040Adapter serial output (UART0)", () => {
  let adapter: Rp2040Adapter;

  beforeEach(async () => {
    adapter = new Rp2040Adapter();
    await adapter.init(undefined);
  });

  it("onSerialData fires with each byte written to UART0", () => {
    const cb = vi.fn();
    adapter.onSerialData(cb);

    const uart0 = (adapter as unknown as { mcu: { uart: { onByte?: (v: number) => void }[] } }).mcu.uart[0];
    uart0.onByte?.("A".charCodeAt(0));
    uart0.onByte?.("B".charCodeAt(0));

    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenNthCalledWith(1, "A".charCodeAt(0));
    expect(cb).toHaveBeenNthCalledWith(2, "B".charCodeAt(0));
  });

  it("unsubscribing stops further callbacks", () => {
    const cb = vi.fn();
    const unsubscribe = adapter.onSerialData(cb);
    const uart0 = (adapter as unknown as { mcu: { uart: { onByte?: (v: number) => void }[] } }).mcu.uart[0];

    uart0.onByte?.(1);
    unsubscribe();
    uart0.onByte?.(2);

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(1);
  });

  it("keeps forwarding after reset() - the mcu (and its UART) isn't recreated", () => {
    const cb = vi.fn();
    adapter.onSerialData(cb);

    adapter.reset();
    const uart0 = (adapter as unknown as { mcu: { uart: { onByte?: (v: number) => void }[] } }).mcu.uart[0];
    uart0.onByte?.(42);

    expect(cb).toHaveBeenCalledWith(42);
  });
});

// Regression test for a real bug found and fixed 2026-07-24 (see
// ARCHITECTURE.md's "RP2040 firmware pipeline" section): rp2040js's own
// `RP2040.step()` (src/rp2040.ts) is *only* `core.executeInstruction()` -
// it never calls `clock.tick()`, so nothing that depends on the
// simulation clock advancing (scheduled alarms, WFI wake-up - which is
// what `sleep_ms()` and, transitively, plenty of other pico-sdk startup/
// runtime code eventually blocks on) ever progresses when driven through
// a bare `mcu.step()` loop, the way this adapter used to be written.
// Confirmed by hand (compiled real pico-sdk sketches through
// physicalsim's own /compile endpoint) that this was the actual root
// cause of two previously-documented, seemingly separate limitations
// (`sleep_ms()` hanging forever, and GPIO input never reaching compiled
// firmware) - one fix (`stepOnce()`, mirroring rp2040js's own reference
// `Simulator.execute()`) resolved both. This test doesn't need a
// compiled sketch to catch a regression here: a plain scheduled clock
// alarm (the same primitive `sleep_ms()` itself uses) is enough to prove
// `step()` actually advances the clock, not just the CPU.
describe("Rp2040Adapter clock advancement (regression: sleep_ms()/WFI hang)", () => {
  it("step() advances the simulation clock, not just CPU instructions", async () => {
    const adapter = new Rp2040Adapter();
    await adapter.init(undefined);

    const clock = (
      adapter as unknown as {
        mcu: { clock: { createAlarm(cb: () => void): { schedule(nanos: number): void } } };
      }
    ).mcu.clock;

    let fired = false;
    // 1000ns - short enough that even a handful of adapter.step() calls
    // (each advancing the clock by one instruction's worth of real time)
    // should cross it well within a small step budget, if step() is
    // advancing the clock at all.
    clock.createAlarm(() => {
      fired = true;
    }).schedule(1000);

    adapter.step(1000);

    expect(fired).toBe(true);
  });
});
