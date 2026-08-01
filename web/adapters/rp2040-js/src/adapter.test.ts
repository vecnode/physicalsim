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

  it("rejects an invalid pin id, an out-of-range GPIO number, and a non-ADC-capable pin", () => {
    adapter.loadFirmware(new TextEncoder().encode(BLINK_SKETCH));
    expect(() => adapter.readPin("D2")).toThrow();
    expect(() => adapter.readPin("GP99")).toThrow(); // PicoRuntime's default is 30 pins (GP0-GP29)
    expect(() => adapter.writeAnalogPin("GP2", 3)).toThrow(/not an ADC-capable pin/); // only GP26-29 are ADC-capable
  });

  it("writeAnalogPin drives adc_read() on a GP26-29 pin, 0-3.3V -> 0-4095", () => {
    const sketch = `
function setup() { adc_init(); adc_gpio_init(26); adc_select_input(0); }
let last = 0;
function loop() { last = adc_read(); }
`;
    adapter.loadFirmware(new TextEncoder().encode(sketch));
    adapter.step(1);
    adapter.writeAnalogPin("GP26", 3.3);
    adapter.step(1);
    expect(adapter.readPin("GP26")).toBe(1); // gpioGet() thresholds truthy, matching PicoRuntime's own digital/analog shared scale
  });

  it("onSerialData fires as the interpreted sketch calls printf()", () => {
    const sketch = `
function setup() { stdio_init_all(); printf("x=%d\\n", 42); }
function loop() {}
`;
    adapter.loadFirmware(new TextEncoder().encode(sketch));
    const bytes: number[] = [];
    adapter.onSerialData((b) => bytes.push(b));
    adapter.step(1);
    expect(String.fromCharCode(...bytes)).toBe("x=42\n");
  });

  it("pwm_set_gpio_level drives a fractional duty value readable back via readPin", () => {
    const sketch = `
function setup() {
  gpio_set_function(15, GPIO_FUNC_PWM);
  pwm_set_wrap(15, 100);
  pwm_set_gpio_level(15, 50);
}
function loop() {}
`;
    adapter.loadFirmware(new TextEncoder().encode(sketch));
    adapter.step(1);
    expect(adapter.readPinDirection("GP15")).toBe("output");
    expect(adapter.readPin("GP15")).toBe(0.5);
  });

  it("onI2CFrame fires when the interpreted sketch writes a full SSD1306 GDDRAM frame over I2C", () => {
    // SSD1306's own 0x3c address, one control byte (0x40 = data, not a
    // command - see SSD1306Device's own doc comment) then 1024 GDDRAM
    // bytes (128x64 / 8) - the same "write, don't just probe" shape a
    // real display-drawing sketch would call i2c_write_blocking() with.
    const sketch = `
function setup() {
  i2c_init(i2c0, 400000);
  const buf = [0x40];
  for (let i = 0; i < 1024; i++) buf.push(0xff);
  i2c_write_blocking(i2c0, 0x3c, buf, buf.length);
}
function loop() {}
`;
    adapter.loadFirmware(new TextEncoder().encode(sketch));
    const frames: Array<{ device: string; data: Uint8Array }> = [];
    adapter.onI2CFrame((device, data) => frames.push({ device, data }));
    adapter.step(1);
    expect(frames).toHaveLength(1);
    expect(frames[0].device).toBe("ssd1306");
    expect(frames[0].data).toHaveLength(1024);
  });
});
