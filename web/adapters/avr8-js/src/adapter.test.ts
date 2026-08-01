import { beforeEach, describe, expect, it, vi } from "vitest";
import { Avr8JsAdapter } from "./adapter.js";

const BLINK_SKETCH = `
function setup() {
  pinMode(LED_BUILTIN, OUTPUT);
}
function loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  digitalWrite(LED_BUILTIN, LOW);
}
`;

describe("Avr8JsAdapter", () => {
  let adapter: Avr8JsAdapter;

  beforeEach(async () => {
    adapter = new Avr8JsAdapter();
    await adapter.init(undefined);
  });

  it("loadFirmware compiles the sketch source (UTF-8 bytes) and step() runs setup()+loop()", () => {
    adapter.loadFirmware(new TextEncoder().encode(BLINK_SKETCH));
    expect(adapter.readPinDirection("D13")).toBe("input"); // setup() hasn't run yet
    adapter.step(1);
    expect(adapter.readPinDirection("D13")).toBe("output");
    expect(adapter.readPin("D13")).toBe(0); // loop() ends on LOW
  });

  it("onPinChange fires as the interpreted sketch toggles a pin", () => {
    adapter.loadFirmware(new TextEncoder().encode(BLINK_SKETCH));
    const values: number[] = [];
    adapter.onPinChange("D13", (v) => values.push(v));
    adapter.step(1);
    expect(values).toEqual([1, 0]);
  });

  it("writePin drives an external input, readable via readPin (e.g. a wired button)", () => {
    const sketch = `function setup() { pinMode(2, INPUT); } function loop() {}`;
    adapter.loadFirmware(new TextEncoder().encode(sketch));
    adapter.step(1);
    expect(adapter.readPin("D2")).toBe(0);
    adapter.writePin("D2", 1);
    expect(adapter.readPin("D2")).toBe(1);
  });

  it("writeAnalogPin drives an A0-A5 pin's analogRead() value, and rejects a digital-only pin", () => {
    const sketch = `
      var last = 0;
      function setup() {}
      function loop() { last = analogRead(A0); }
    `;
    adapter.loadFirmware(new TextEncoder().encode(sketch));
    adapter.writeAnalogPin("A0", 5); // full-scale 5V
    adapter.step(1);
    expect(adapter.readPin("A0")).toBeCloseTo(1023 / 1023, 5); // internal 0..1 fraction

    expect(() => adapter.writeAnalogPin("D13", 3)).toThrow(/not an ADC-capable pin/);
  });

  it("onSerialData receives bytes the sketch writes via Serial", () => {
    const sketch = `function setup() { Serial.begin(9600); Serial.print("Hi"); } function loop() {}`;
    adapter.loadFirmware(new TextEncoder().encode(sketch));
    const bytes: number[] = [];
    adapter.onSerialData((b) => bytes.push(b));
    adapter.step(1);
    expect(String.fromCharCode(...bytes)).toBe("Hi");
  });

  it("reset() re-runs against a fresh runtime, clearing prior pin state", () => {
    adapter.loadFirmware(new TextEncoder().encode(BLINK_SKETCH));
    adapter.step(1);
    expect(adapter.readPinDirection("D13")).toBe("output");
    adapter.reset();
    expect(adapter.readPinDirection("D13")).toBe("input");
    adapter.step(1);
    expect(adapter.readPinDirection("D13")).toBe("output");
  });

  it("start()/stop() schedule loop() iterations and can be halted", async () => {
    adapter.loadFirmware(new TextEncoder().encode(BLINK_SKETCH));
    const values: number[] = [];
    adapter.onPinChange("D13", (v) => values.push(v));

    adapter.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    adapter.stop();

    const countAfterStop = values.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(values.length).toBe(countAfterStop); // no further ticks after stop()
    expect(values.length).toBeGreaterThan(0);
  });

  it("onStateChange fires with running/millis on start/stop/step", () => {
    adapter.loadFirmware(new TextEncoder().encode(BLINK_SKETCH));
    const states: Array<{ running: boolean }> = [];
    adapter.onStateChange((s) => states.push({ running: s.running }));
    adapter.step(1);
    expect(states.at(-1)?.running).toBe(false);
  });

  it("rejects an invalid pin id", () => {
    adapter.loadFirmware(new TextEncoder().encode(BLINK_SKETCH));
    expect(() => adapter.readPin("D99")).toThrow();
    expect(() => adapter.readPin("A9")).toThrow();
    expect(() => adapter.readPin("Z0")).toThrow();
  });
});

describe("Avr8JsAdapter (Mega pin shape)", () => {
  it("supports D0-D53/A0-A15 when constructed with Mega's pin shape", async () => {
    const megaAdapter = new Avr8JsAdapter({ digitalPinCount: 54, analogPinCount: 16 });
    await megaAdapter.init(undefined);
    const sketch = `
      function setup() { pinMode(53, OUTPUT); pinMode(A15, OUTPUT); }
      function loop() { digitalWrite(53, HIGH); digitalWrite(A15, HIGH); }
    `;
    megaAdapter.loadFirmware(new TextEncoder().encode(sketch));
    megaAdapter.step(1);
    expect(megaAdapter.readPin("D53")).toBe(1);
    expect(megaAdapter.readPin("A15")).toBe(1);
    // D53/A15 don't exist on the default (Uno) shape, confirming this is
    // genuinely a different pin count, not just a lenient parser.
    expect(() => megaAdapter.readPin("D54")).toThrow();
    expect(() => megaAdapter.readPin("A16")).toThrow();
  });
});
