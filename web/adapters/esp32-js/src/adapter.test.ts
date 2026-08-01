import { beforeEach, describe, expect, it } from "vitest";
import { Esp32JsAdapter } from "./adapter.js";

const BLINK_SKETCH = `
const GPIO_OUTPUT_IO_0 = 18;
function setup() {
  const io_conf = {};
  io_conf.mode = GPIO_MODE_OUTPUT;
  io_conf.pin_bit_mask = (1 << GPIO_OUTPUT_IO_0);
  gpio_config(io_conf);
}
let cnt = 0;
function loop() {
  vTaskDelay(1000 / portTICK_PERIOD_MS);
  gpio_set_level(GPIO_OUTPUT_IO_0, cnt % 2);
  cnt++;
}
`;

describe("Esp32JsAdapter", () => {
  let adapter: Esp32JsAdapter;

  beforeEach(async () => {
    adapter = new Esp32JsAdapter();
    await adapter.init(undefined);
  });

  it("loadFirmware compiles the sketch source and step() runs setup()+loop()", () => {
    adapter.loadFirmware(new TextEncoder().encode(BLINK_SKETCH));
    expect(adapter.readPinDirection("D18")).toBe("input"); // setup() hasn't run yet
    adapter.step(1);
    expect(adapter.readPinDirection("D18")).toBe("output");
    expect(adapter.readPin("D18")).toBe(0); // cnt=0 -> level 0
    adapter.step(1);
    expect(adapter.readPin("D18")).toBe(1); // cnt=1 -> level 1
  });

  it("accepts both 'D<n>' and bare '<n>' pin ids for the same GPIO", () => {
    adapter.loadFirmware(new TextEncoder().encode(BLINK_SKETCH));
    adapter.step(1);
    expect(adapter.readPin("D18")).toBe(adapter.readPin("18"));
  });

  it("onPinChange fires as the interpreted sketch toggles a pin", () => {
    adapter.loadFirmware(new TextEncoder().encode(BLINK_SKETCH));
    const values: number[] = [];
    adapter.onPinChange("D18", (v) => values.push(v));
    adapter.step(1);
    adapter.step(1);
    // First step's cnt=0 write is a no-op (D18 already reads 0 by
    // default - EspIdfRuntime.setValue() only fires on an actual change,
    // same dedup semantics avr8js/arduino's and rp2040js/pico's runtimes
    // use). Only the second step's cnt=1 write is a real transition.
    expect(values).toEqual([1]);
  });

  it("writePin drives an external input, readable via readPin", () => {
    const sketch = `function setup() {} function loop() {}`;
    adapter.loadFirmware(new TextEncoder().encode(sketch));
    adapter.step(1);
    expect(adapter.readPin("D4")).toBe(0);
    adapter.writePin("D4", 1);
    expect(adapter.readPin("D4")).toBe(1);
  });

  it("reset() re-runs against a fresh runtime, clearing prior pin state", () => {
    adapter.loadFirmware(new TextEncoder().encode(BLINK_SKETCH));
    adapter.step(1);
    expect(adapter.readPinDirection("D18")).toBe("output");
    adapter.reset();
    expect(adapter.readPinDirection("D18")).toBe("input");
    adapter.step(1);
    expect(adapter.readPinDirection("D18")).toBe("output");
  });

  it("start()/stop() schedule loop() iterations and can be halted", async () => {
    adapter.loadFirmware(new TextEncoder().encode(BLINK_SKETCH));
    const values: number[] = [];
    adapter.onPinChange("D18", (v) => values.push(v));

    adapter.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    adapter.stop();

    const countAfterStop = values.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(values.length).toBe(countAfterStop);
  });

  it("rejects an invalid pin id and unmodeled analog input", () => {
    adapter.loadFirmware(new TextEncoder().encode(BLINK_SKETCH));
    expect(() => adapter.readPin("D99")).toThrow();
    expect(() => adapter.readPin("Z0")).toThrow();
    expect(() => adapter.writeAnalogPin("D32", 3)).toThrow(/not an ADC-capable pin/);
  });
});
