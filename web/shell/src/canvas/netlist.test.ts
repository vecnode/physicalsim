import { describe, expect, it } from "vitest";
import { buildNetlist, findNodeForPin, type NetlistEntityInfo } from "./netlist.js";
import type { Wire } from "./wiring.js";
import type { PinPowerInfo } from "./wire-validator.js";

function wire(id: string, aEntity: string, aPin: string, bEntity: string, bPin: string): Wire {
  return { id, a: { entityId: aEntity, pin: aPin }, b: { entityId: bEntity, pin: bPin }, elbow: {} };
}

function entities(map: Record<string, NetlistEntityInfo>): ReadonlyMap<string, NetlistEntityInfo> {
  return new Map(Object.entries(map));
}

function power(map: Record<string, PinPowerInfo | undefined>) {
  return (entityId: string, pin: string) => map[`${entityId}:${pin}`];
}

// Finds the node containing a given pin - test convenience, since node
// ids are assigned in iteration order and shouldn't be asserted on
// directly (that would test Map iteration order, not netlist behavior).
function nodeOf(netlist: ReturnType<typeof buildNetlist>, entityId: string, pin: string) {
  return netlist.nodes.find((n) => n.pins.some((p) => p.entityId === entityId && p.pin === pin));
}

describe("buildNetlist", () => {
  it("resolves a single resistor wired between two board pins into one element with two distinct nodes", () => {
    const wires = [wire("w1", "r1", "1", "uno", "13"), wire("w2", "r1", "2", "uno", "GND")];
    const netlist = buildNetlist(
      wires,
      entities({
        r1: { kind: "component", type: "resistor", attrs: { value: "220" } },
        uno: { kind: "board", type: "arduino-uno" },
      }),
      power({}),
    );
    expect(netlist.elements).toHaveLength(1);
    const el = netlist.elements[0];
    expect(el).toMatchObject({ componentId: "r1", kind: "resistor", value: 220 });
    expect(el.nodeA).not.toBe(el.nodeB);
    expect(nodeOf(netlist, "r1", "1")!.id).toBe(el.nodeA);
    expect(nodeOf(netlist, "uno", "GND")!.id).toBe(el.nodeB);
  });

  it("two resistors sharing a wired midpoint land on the same middle node (series)", () => {
    const wires = [
      wire("w1", "uno", "13", "r1", "1"),
      wire("w2", "r1", "2", "r2", "1"), // shared midpoint
      wire("w3", "r2", "2", "uno", "GND"),
    ];
    const netlist = buildNetlist(
      wires,
      entities({
        uno: { kind: "board", type: "arduino-uno" },
        r1: { kind: "component", type: "resistor", attrs: { value: "1000" } },
        r2: { kind: "component", type: "resistor", attrs: { value: "2000" } },
      }),
      power({}),
    );
    const [er1, er2] = netlist.elements;
    expect(er1.nodeB).toBe(er2.nodeA); // the shared midpoint is one node
    expect(er1.nodeA).not.toBe(er1.nodeB);
    expect(er2.nodeA).not.toBe(er2.nodeB);
  });

  it("two resistors wired to the exact same pair of pins land on the same two nodes (parallel)", () => {
    const wires = [
      wire("w1", "r1", "1", "uno", "13"),
      wire("w2", "r1", "2", "uno", "GND"),
      wire("w3", "r2", "1", "uno", "13"),
      wire("w4", "r2", "2", "uno", "GND"),
    ];
    const netlist = buildNetlist(
      wires,
      entities({
        uno: { kind: "board", type: "arduino-uno" },
        r1: { kind: "component", type: "resistor", attrs: { value: "1000" } },
        r2: { kind: "component", type: "resistor", attrs: { value: "1000" } },
      }),
      power({}),
    );
    const [er1, er2] = netlist.elements;
    expect(er1.nodeA).toBe(er2.nodeA);
    expect(er1.nodeB).toBe(er2.nodeB);
  });

  it("a fully unwired resistor still gets two real, isolated nodes", () => {
    const netlist = buildNetlist(
      [],
      entities({ r1: { kind: "component", type: "resistor", attrs: { value: "500" } } }),
      power({}),
    );
    expect(netlist.elements).toHaveLength(1);
    expect(netlist.elements[0].nodeA).not.toBe(netlist.elements[0].nodeB);
    expect(netlist.nodes).toHaveLength(2);
  });

  it("resolves a capacitor the same way, in farads", () => {
    const wires = [wire("w1", "c1", "1", "uno", "13"), wire("w2", "c1", "2", "uno", "GND")];
    const netlist = buildNetlist(
      wires,
      entities({
        uno: { kind: "board", type: "arduino-uno" },
        c1: { kind: "component", type: "capacitor", attrs: { value: "1e-7" } },
      }),
      power({}),
    );
    expect(netlist.elements[0]).toMatchObject({ kind: "capacitor", value: 1e-7 });
  });

  it("marks a node isGround when a wired pin is GND-classified", () => {
    const wires = [wire("w1", "r1", "2", "uno", "GND")];
    const netlist = buildNetlist(
      wires,
      entities({
        uno: { kind: "board", type: "arduino-uno" },
        r1: { kind: "component", type: "resistor", attrs: { value: "1000" } },
      }),
      power({ "uno:GND": { kind: "gnd" } }),
    );
    expect(nodeOf(netlist, "uno", "GND")!.isGround).toBe(true);
    expect(nodeOf(netlist, "r1", "1")!.isGround).toBe(false);
  });

  it("keeps two never-wired-together ground pins as two separate ground nodes, not merged", () => {
    // Each board's GND is wired to its own resistor (not to each other) -
    // a pin mentioned in zero wires and zero electrical components has
    // no reason to appear in the netlist at all (nothing depends on it),
    // so each ground pin needs to actually participate in some element
    // for this scenario to be meaningful.
    const wires = [wire("w1", "uno1", "GND", "r1", "2"), wire("w2", "uno2", "GND", "r2", "2")];
    const netlist = buildNetlist(
      wires,
      entities({
        uno1: { kind: "board", type: "arduino-uno" },
        uno2: { kind: "board", type: "arduino-uno" },
        r1: { kind: "component", type: "resistor", attrs: { value: "1000" } },
        r2: { kind: "component", type: "resistor", attrs: { value: "1000" } },
      }),
      power({ "uno1:GND": { kind: "gnd" }, "uno2:GND": { kind: "gnd" } }),
    );
    const g1 = nodeOf(netlist, "uno1", "GND")!;
    const g2 = nodeOf(netlist, "uno2", "GND")!;
    expect(g1.isGround).toBe(true);
    expect(g2.isGround).toBe(true);
    expect(g1.id).not.toBe(g2.id);
  });

  it("records a declared fixed voltage on a non-ground node (a board's 5V rail)", () => {
    const wires = [wire("w1", "r1", "1", "uno", "5V")];
    const netlist = buildNetlist(
      wires,
      entities({
        uno: { kind: "board", type: "arduino-uno" },
        r1: { kind: "component", type: "resistor", attrs: { value: "1000" } },
      }),
      power({ "uno:5V": { kind: "vcc", voltage: 5 } }),
    );
    const node = nodeOf(netlist, "uno", "5V")!;
    expect(node.isGround).toBe(false);
    expect(node.fixedVoltage).toBe(5);
  });

  it("never sets fixedVoltage on a node that's also ground, even if a pin oddly reports both", () => {
    const netlist = buildNetlist(
      [wire("w1", "a", "1", "b", "1")],
      entities({ a: { kind: "board", type: "x" }, b: { kind: "board", type: "y" } }),
      power({ "a:1": { kind: "gnd" }, "b:1": { kind: "vcc", voltage: 5 } }),
    );
    const node = nodeOf(netlist, "a", "1")!;
    expect(node.isGround).toBe(true);
    expect(node.fixedVoltage).toBeUndefined();
  });

  it("skips components with no electrical param entry (e.g. an LED)", () => {
    const netlist = buildNetlist(
      [wire("w1", "led1", "A", "uno", "13")],
      entities({
        uno: { kind: "board", type: "arduino-uno" },
        led1: { kind: "component", type: "led" },
      }),
      power({}),
    );
    expect(netlist.elements).toHaveLength(0);
  });

  it("falls back to the resistor default value when attrs has none set", () => {
    const netlist = buildNetlist(
      [],
      entities({ r1: { kind: "component", type: "resistor" } }),
      power({}),
    );
    expect(netlist.elements[0].value).toBe(1000);
  });

  it("a runtime voltage (a firmware-driven GPIO output) sets fixedVoltage on that node", () => {
    const wires = [wire("w1", "uno", "13", "r1", "1")];
    const netlist = buildNetlist(
      wires,
      entities({
        uno: { kind: "board", type: "arduino-uno" },
        r1: { kind: "component", type: "resistor", attrs: { value: "1000" } },
      }),
      power({}),
      (entityId, pin) => (entityId === "uno" && pin === "13" ? 5 : undefined),
    );
    expect(nodeOf(netlist, "uno", "13")!.fixedVoltage).toBe(5);
  });

  it("a runtime voltage takes priority over a static VCC classification on the same node", () => {
    const wires = [wire("w1", "uno", "5V", "r1", "1")];
    const netlist = buildNetlist(
      wires,
      entities({
        uno: { kind: "board", type: "arduino-uno" },
        r1: { kind: "component", type: "resistor", attrs: { value: "1000" } },
      }),
      power({ "uno:5V": { kind: "vcc", voltage: 5 } }),
      (entityId, pin) => (entityId === "uno" && pin === "5V" ? 3.7 : undefined),
    );
    expect(nodeOf(netlist, "uno", "5V")!.fixedVoltage).toBe(3.7);
  });
});

describe("findNodeForPin", () => {
  it("finds the node a given pin ended up grouped into", () => {
    const wires = [wire("w1", "r1", "1", "uno", "13")];
    const netlist = buildNetlist(
      wires,
      entities({
        uno: { kind: "board", type: "arduino-uno" },
        r1: { kind: "component", type: "resistor", attrs: { value: "1000" } },
      }),
      power({}),
    );
    const node = findNodeForPin(netlist, "uno", "13");
    expect(node).toBeDefined();
    expect(node!.pins.some((p) => p.entityId === "r1" && p.pin === "1")).toBe(true);
  });

  it("returns undefined for a pin that isn't part of the netlist at all", () => {
    const netlist = buildNetlist([], entities({}), power({}));
    expect(findNodeForPin(netlist, "nonexistent", "1")).toBeUndefined();
  });
});
