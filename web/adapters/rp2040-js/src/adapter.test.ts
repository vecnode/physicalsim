import { beforeEach, describe, expect, it } from "vitest";
import { Rp2040JsAdapter } from "./adapter.js";

const BLINK_SKETCH = `
function setup() {
  gpio_init(25);
  gpio_set_dir(25, GPIO_OUT);
}
function loop() {
  gpio_put(25, 1);
  gpio_put(25, 0);
}
`;

describe("Rp2040JsAdapter", () => {
  let adapter: Rp2040JsAdapter;

  beforeEach(async () => {
    adapter = new Rp2040JsAdapter();
    await adapter.init(undefined);
  });

  it("loadFirmware compiles the sketch source and step() runs setup()+loop()", () => {
    adapter.loadFirmware(new TextEncoder().encode(BLINK_SKETCH));
    expect(adapter.readPinDirection("GP25")).toBe("input"); // setup() hasn't run yet
    adapter.step(1);
    expect(adapter.readPinDirection("GP25")).toBe("output");
    expect(adapter.readPin("GP25")).toBe(0); // loop() ends LOW
  });

  it("onPinChange fires as the interpreted sketch toggles a pin", () => {
    adapter.loadFirmware(new TextEncoder().encode(BLINK_SKETCH));
    const values: number[] = [];
    adapter.onPinChange("GP25", (v) => values.push(v));
    adapter.step(1);
    expect(values).toEqual([1, 0]);
  });

  it("writePin drives an external input, readable via readPin", () => {
    const sketch = `function setup() { gpio_init(2); } function loop() {}`;
    adapter.loadFirmware(new TextEncoder().encode(sketch));
    adapter.step(1);
    expect(adapter.readPin("GP2")).toBe(0);
    adapter.writePin("GP2", 1);
    expect(adapter.readPin("GP2")).toBe(1);
  });

  it("reset() re-runs against a fresh runtime, clearing prior pin state", () => {
    adapter.loadFirmware(new TextEncoder().encode(BLINK_SKETCH));
    adapter.step(1);
    expect(adapter.readPinDirection("GP25")).toBe("output");
    adapter.reset();
    expect(adapter.readPinDirection("GP25")).toBe("input");
    adapter.step(1);
    expect(adapter.readPinDirection("GP25")).toBe("output");
  });

  it("start()/stop() schedule loop() iterations and can be halted", async () => {
    adapter.loadFirmware(new TextEncoder().encode(BLINK_SKETCH));
    const values: number[] = [];
    adapter.onPinChange("GP25", (v) => values.push(v));

    adapter.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    adapter.stop();

    const countAfterStop = values.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(values.length).toBe(countAfterStop);
    expect(values.length).toBeGreaterThan(0);
  });

  it("rejects an invalid pin id, an out-of-range GPIO number, and unmodeled analog input", () => {
    adapter.loadFirmware(new TextEncoder().encode(BLINK_SKETCH));
    expect(() => adapter.readPin("D2")).toThrow();
    expect(() => adapter.readPin("GP99")).toThrow(); // PicoRuntime's default is 30 pins (GP0-GP29)
    expect(() => adapter.writeAnalogPin("GP26", 3)).toThrow(/not modeled/);
  });
});
