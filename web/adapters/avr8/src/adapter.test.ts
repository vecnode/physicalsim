import { beforeEach, describe, expect, it, vi } from "vitest";
import { Avr8Adapter } from "./adapter.js";

// AVRIOPort internals accessed directly to drive the CPU's write hooks the
// same way real AVR instructions (e.g. SBI DDRB,5 / OUT PORTB,r) would -
// exercising the exact path attachPeripherals() wires onPinChange through,
// without needing to hand-assemble a firmware image.
function cpuOf(adapter: Avr8Adapter) {
  return (adapter as unknown as { cpu: { writeData(addr: number, value: number): void; data: Uint8Array } }).cpu;
}
function portBOf(adapter: Avr8Adapter) {
  return (adapter as unknown as { portB: { portConfig: { DDR: number; PORT: number } } }).portB;
}

describe("Avr8Adapter pin I/O", () => {
  let adapter: Avr8Adapter;

  beforeEach(async () => {
    adapter = new Avr8Adapter();
    await adapter.init(undefined);
  });

  it("writePin drives an input pin's value, readable via readPin", () => {
    expect(adapter.readPin("B5")).toBe(0);
    adapter.writePin("B5", 1);
    expect(adapter.readPin("B5")).toBe(1);
    adapter.writePin("B5", 0);
    expect(adapter.readPin("B5")).toBe(0);
  });

  it("onPinChange fires when writePin changes a pin's value, not when it doesn't", () => {
    const cb = vi.fn();
    const unsubscribe = adapter.onPinChange("B5", cb);

    adapter.writePin("B5", 1);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(1);

    adapter.writePin("B5", 1); // no change
    expect(cb).toHaveBeenCalledTimes(1);

    unsubscribe();
    adapter.writePin("B5", 0);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("onPinChange fires when the CPU drives an output pin (simulated firmware write)", () => {
    const cb = vi.fn();
    adapter.onPinChange("B5", cb);

    const cpu = cpuOf(adapter);
    const { DDR, PORT } = portBOf(adapter).portConfig;
    cpu.writeData(DDR, 0b0010_0000); // set B5 as output
    cpu.writeData(PORT, 0b0010_0000); // drive B5 high

    expect(cb).toHaveBeenCalledWith(1);
    expect(adapter.readPin("B5")).toBe(1);

    cpu.writeData(PORT, 0b0000_0000); // drive B5 low
    expect(cb).toHaveBeenLastCalledWith(0);
  });

  it("resolvePin rejects unknown ports and out-of-range bits", () => {
    expect(() => adapter.readPin("Z0")).toThrow();
    expect(() => adapter.readPin("B8")).toThrow();
  });
});
