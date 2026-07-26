import { describe, expect, it } from "vitest";
import { componentElectricalParams, getElectricalValue } from "./component-electrical-params.js";

describe("componentElectricalParams", () => {
  it("registers resistor and capacitor with real SI base units", () => {
    expect(componentElectricalParams.resistor).toEqual({
      attrKey: "value",
      displayName: "Resistance",
      unit: "ohm",
      defaultValue: 1000,
      terminals: ["1", "2"],
    });
    expect(componentElectricalParams.capacitor.unit).toBe("F");
  });

  it("registers an LED with a forward-voltage default and its real anode/cathode terminal names", () => {
    expect(componentElectricalParams.led).toEqual({
      attrKey: "forwardVoltage",
      displayName: "Forward voltage",
      unit: "V",
      defaultValue: 2,
      terminals: ["A", "C"],
    });
  });
});

describe("getElectricalValue", () => {
  it("reads a plain decimal value from attrs", () => {
    expect(getElectricalValue("resistor", { value: "220" })).toBe(220);
  });

  it("reads exponential-notation values (a capacitor's own convention)", () => {
    expect(getElectricalValue("capacitor", { value: "1e-7" })).toBeCloseTo(1e-7);
  });

  it("falls back to the type's default when attrs is missing entirely", () => {
    expect(getElectricalValue("resistor", undefined)).toBe(1000);
  });

  it("falls back to the default when the key is missing from attrs", () => {
    expect(getElectricalValue("resistor", { color: "red" })).toBe(1000);
  });

  it("falls back to the default for an unparseable value", () => {
    expect(getElectricalValue("resistor", { value: "not-a-number" })).toBe(1000);
  });

  it("falls back to the default for a zero or negative value", () => {
    expect(getElectricalValue("resistor", { value: "0" })).toBe(1000);
    expect(getElectricalValue("resistor", { value: "-5" })).toBe(1000);
  });

  it("returns undefined for a component type with no electrical param at all", () => {
    expect(getElectricalValue("pushbutton", { value: "123" })).toBeUndefined();
  });

  it("reads an LED's forward-voltage attr, defaulting to 2V", () => {
    expect(getElectricalValue("led", { forwardVoltage: "1.8" })).toBeCloseTo(1.8);
    expect(getElectricalValue("led", undefined)).toBe(2);
  });
});
