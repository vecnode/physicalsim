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

  it("resolvePin rejects malformed or out-of-range pin ids", () => {
    expect(() => adapter.readPin("B5")).toThrow();
    expect(() => adapter.readPin("GP99")).toThrow();
  });
});
