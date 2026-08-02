import { describe, expect, it } from "vitest";
import { pinPowerInfo, validateWires, type PinPowerInfo } from "./wire-validator.js";
import type { Wire } from "./wiring.js";
import type { ElementPin } from "iot-elements";

function wire(id: string, aEntity: string, aPin: string, bEntity: string, bPin: string): Wire {
  return { id, a: { entityId: aEntity, pin: aPin }, b: { entityId: bEntity, pin: bPin }, elbow: {}, waypoints: [] };
}

describe("pinPowerInfo", () => {
  const pins: ElementPin[] = [
    { name: "GND.1", x: 0, y: 0, signals: [{ type: "power", signal: "GND" }] },
    { name: "5V", x: 0, y: 0, signals: [{ type: "power", signal: "VCC", voltage: 5 }] },
    { name: "3V3", x: 0, y: 0, signals: [{ type: "power", signal: "VCC", voltage: 3.3 }] },
    { name: "VIN", x: 0, y: 0, signals: [{ type: "power", signal: "VCC" }] },
    { name: "13", x: 0, y: 0, signals: [] },
  ];

  it("classifies a GND pin", () => {
    expect(pinPowerInfo(pins, "GND.1")).toEqual({ kind: "gnd" });
  });

  it("classifies a VCC pin with a declared voltage", () => {
    expect(pinPowerInfo(pins, "5V")).toEqual({ kind: "vcc", voltage: 5 });
    expect(pinPowerInfo(pins, "3V3")).toEqual({ kind: "vcc", voltage: 3.3 });
  });

  it("classifies a VCC pin with no declared voltage", () => {
    expect(pinPowerInfo(pins, "VIN")).toEqual({ kind: "vcc", voltage: undefined });
  });

  it("returns undefined for a plain GPIO pin", () => {
    expect(pinPowerInfo(pins, "13")).toBeUndefined();
  });

  it("returns undefined for an unknown pin name", () => {
    expect(pinPowerInfo(pins, "nonexistent")).toBeUndefined();
  });

  it("returns undefined when there's no pinInfo at all", () => {
    expect(pinPowerInfo(undefined, "GND.1")).toBeUndefined();
  });
});

describe("validateWires", () => {
  function power(map: Record<string, PinPowerInfo | undefined>) {
    return (entityId: string, pin: string) => map[`${entityId}:${pin}`];
  }

  it("flags GND wired directly to a VCC rail", () => {
    const wires = [wire("wire-1", "uno", "GND.1", "led", "A")];
    const issues = validateWires(
      wires,
      power({ "uno:GND.1": { kind: "gnd" }, "led:A": { kind: "vcc", voltage: 5 } }),
    );
    expect(issues).toEqual([{ wireId: "wire-1", severity: "short", message: expect.stringContaining("short circuit") }]);
  });

  it("does not flag GND wired to GND (shared ground between boards)", () => {
    const wires = [wire("wire-1", "uno", "GND.1", "pico", "GND.1")];
    const issues = validateWires(wires, power({ "uno:GND.1": { kind: "gnd" }, "pico:GND.1": { kind: "gnd" } }));
    expect(issues).toEqual([]);
  });

  it("flags two different declared-voltage rails wired directly together", () => {
    const wires = [wire("wire-1", "uno", "5V", "pico", "3V3")];
    const issues = validateWires(
      wires,
      power({ "uno:5V": { kind: "vcc", voltage: 5 }, "pico:3V3": { kind: "vcc", voltage: 3.3 } }),
    );
    expect(issues).toEqual([
      { wireId: "wire-1", severity: "voltage-mismatch", message: expect.stringContaining("5V rail wired directly to a 3.3V rail") },
    ]);
  });

  it("does not flag two rails at the same declared voltage", () => {
    const wires = [wire("wire-1", "uno1", "5V", "uno2", "5V")];
    const issues = validateWires(
      wires,
      power({ "uno1:5V": { kind: "vcc", voltage: 5 }, "uno2:5V": { kind: "vcc", voltage: 5 } }),
    );
    expect(issues).toEqual([]);
  });

  it("does not flag a rail with no declared voltage against one that has one", () => {
    const wires = [wire("wire-1", "uno", "VIN", "pico", "3V3")];
    const issues = validateWires(
      wires,
      power({ "uno:VIN": { kind: "vcc", voltage: undefined }, "pico:3V3": { kind: "vcc", voltage: 3.3 } }),
    );
    expect(issues).toEqual([]);
  });

  it("ignores ordinary GPIO-to-GPIO wiring entirely", () => {
    const wires = [wire("wire-1", "uno", "13", "led", "A")];
    const issues = validateWires(wires, power({}));
    expect(issues).toEqual([]);
  });

  it("ignores a wire where only one endpoint is a power pin", () => {
    const wires = [wire("wire-1", "uno", "5V", "led", "A")];
    const issues = validateWires(wires, power({ "uno:5V": { kind: "vcc", voltage: 5 } }));
    expect(issues).toEqual([]);
  });
});
