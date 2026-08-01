import { beforeEach, describe, expect, it } from "vitest";
import { Avr8JsAttiny85Adapter } from "./adapter-attiny85.js";

const BUTTON_LED_SKETCH = `
const buttonPin = 0;
const ledPin = 1;
function setup() {
  pinMode(buttonPin, INPUT);
  pinMode(ledPin, OUTPUT);
}
function loop() {
  digitalWrite(ledPin, digitalRead(buttonPin));
}
`;

describe("Avr8JsAttiny85Adapter", () => {
  let adapter: Avr8JsAttiny85Adapter;

  beforeEach(async () => {
    adapter = new Avr8JsAttiny85Adapter();
    await adapter.init(undefined);
  });

  it("loadFirmware + step() mirrors button state onto the LED pin (PB<n> ids)", () => {
    adapter.loadFirmware(new TextEncoder().encode(BUTTON_LED_SKETCH));
    adapter.step(1);
    expect(adapter.readPin("PB1")).toBe(0);
    adapter.writePin("PB0", 1);
    adapter.step(1);
    expect(adapter.readPin("PB1")).toBe(1);
  });

  it("onPinChange fires as the sketch mirrors the button", () => {
    adapter.loadFirmware(new TextEncoder().encode(BUTTON_LED_SKETCH));
    const values: number[] = [];
    adapter.onPinChange("PB1", (v) => values.push(v));
    adapter.step(1);
    adapter.writePin("PB0", 1);
    adapter.step(1);
    expect(values).toEqual([1]);
  });

  it("rejects a pin id outside PB0-PB5 (only 6 real GPIO pins on ATtiny85)", () => {
    adapter.loadFirmware(new TextEncoder().encode(BUTTON_LED_SKETCH));
    expect(() => adapter.readPin("PB6")).toThrow();
    expect(() => adapter.readPin("D0")).toThrow();
  });

  it("writeAnalogPin always rejects - no ADC modeled for this board", () => {
    adapter.loadFirmware(new TextEncoder().encode(BUTTON_LED_SKETCH));
    expect(() => adapter.writeAnalogPin("PB2", 3)).toThrow(/not an ADC-capable pin/);
  });

  it("reset() re-runs against a fresh runtime", () => {
    adapter.loadFirmware(new TextEncoder().encode(BUTTON_LED_SKETCH));
    adapter.step(1);
    expect(adapter.readPinDirection("PB1")).toBe("output");
    adapter.reset();
    expect(adapter.readPinDirection("PB1")).toBe("input");
    adapter.step(1);
    expect(adapter.readPinDirection("PB1")).toBe("output");
  });
});
