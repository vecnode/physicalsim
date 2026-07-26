import { describe, expect, it } from "vitest";
import { solveDc } from "./mna-solver.js";
import type { Netlist } from "./netlist.js";

describe("solveDc", () => {
  it("solves a symmetric voltage divider to exactly half the source voltage", () => {
    // 5V --- R1(1k) --- mid --- R2(1k) --- GND
    const netlist: Netlist = {
      nodes: [
        { id: "gnd", pins: [], isGround: true },
        { id: "src", pins: [], isGround: false, fixedVoltage: 5 },
        { id: "mid", pins: [], isGround: false },
      ],
      elements: [
        { componentId: "r1", kind: "resistor", value: 1000, nodeA: "src", nodeB: "mid" },
        { componentId: "r2", kind: "resistor", value: 1000, nodeA: "mid", nodeB: "gnd" },
      ],
    };
    const { nodeVoltages } = solveDc(netlist);
    expect(nodeVoltages.get("gnd")).toBe(0);
    expect(nodeVoltages.get("src")).toBeCloseTo(5);
    expect(nodeVoltages.get("mid")).toBeCloseTo(2.5);
  });

  it("solves an asymmetric divider matching the textbook R2/(R1+R2) formula", () => {
    // 9V --- R1(3k) --- mid --- R2(1k) --- GND -> Vmid = 9 * 1/(3+1) = 2.25V
    const netlist: Netlist = {
      nodes: [
        { id: "gnd", pins: [], isGround: true },
        { id: "src", pins: [], isGround: false, fixedVoltage: 9 },
        { id: "mid", pins: [], isGround: false },
      ],
      elements: [
        { componentId: "r1", kind: "resistor", value: 3000, nodeA: "src", nodeB: "mid" },
        { componentId: "r2", kind: "resistor", value: 1000, nodeA: "mid", nodeB: "gnd" },
      ],
    };
    const { nodeVoltages } = solveDc(netlist);
    expect(nodeVoltages.get("mid")).toBeCloseTo(2.25);
  });

  it("two resistors in series between source and ground behave as one combined resistor (divider math still holds)", () => {
    // Same shape as the divider above, phrased as "three equal resistors
    // in series" - Vmid1 should be 2/3 of source, Vmid2 should be 1/3.
    const netlist: Netlist = {
      nodes: [
        { id: "gnd", pins: [], isGround: true },
        { id: "src", pins: [], isGround: false, fixedVoltage: 6 },
        { id: "mid1", pins: [], isGround: false },
        { id: "mid2", pins: [], isGround: false },
      ],
      elements: [
        { componentId: "r1", kind: "resistor", value: 1000, nodeA: "src", nodeB: "mid1" },
        { componentId: "r2", kind: "resistor", value: 1000, nodeA: "mid1", nodeB: "mid2" },
        { componentId: "r3", kind: "resistor", value: 1000, nodeA: "mid2", nodeB: "gnd" },
      ],
    };
    const { nodeVoltages } = solveDc(netlist);
    expect(nodeVoltages.get("mid1")).toBeCloseTo(4); // 2/3 of 6V
    expect(nodeVoltages.get("mid2")).toBeCloseTo(2); // 1/3 of 6V
  });

  it("two resistors in parallel between the same two nodes combine conductance (half the effective resistance)", () => {
    // 5V --- [R1(1k) || R2(1k)] --- GND, in series with R3(1k) to a midpoint.
    // Effective parallel resistance = 500 ohm, so mid = 5 * 500/(1000+500) = 5/3.
    const netlist: Netlist = {
      nodes: [
        { id: "gnd", pins: [], isGround: true },
        { id: "src", pins: [], isGround: false, fixedVoltage: 5 },
        { id: "mid", pins: [], isGround: false },
      ],
      elements: [
        { componentId: "r3", kind: "resistor", value: 1000, nodeA: "src", nodeB: "mid" },
        { componentId: "r1", kind: "resistor", value: 1000, nodeA: "mid", nodeB: "gnd" },
        { componentId: "r2", kind: "resistor", value: 1000, nodeA: "mid", nodeB: "gnd" },
      ],
    };
    const { nodeVoltages } = solveDc(netlist);
    expect(nodeVoltages.get("mid")).toBeCloseTo(5 / 3);
  });

  it("a resistor network with no ground anywhere in its own component is entirely unresolved", () => {
    const netlist: Netlist = {
      nodes: [
        { id: "a", pins: [], isGround: false, fixedVoltage: 5 },
        { id: "b", pins: [], isGround: false },
      ],
      elements: [{ componentId: "r1", kind: "resistor", value: 1000, nodeA: "a", nodeB: "b" }],
    };
    const { nodeVoltages } = solveDc(netlist);
    expect(nodeVoltages.get("a")).toBeUndefined();
    expect(nodeVoltages.get("b")).toBeUndefined();
  });

  it("solves a grounded component and leaves a separate, disconnected floating component unresolved, independently", () => {
    const netlist: Netlist = {
      nodes: [
        { id: "gnd", pins: [], isGround: true },
        { id: "src", pins: [], isGround: false, fixedVoltage: 5 },
        { id: "mid", pins: [], isGround: false },
        { id: "floatingA", pins: [], isGround: false },
        { id: "floatingB", pins: [], isGround: false },
      ],
      elements: [
        { componentId: "r1", kind: "resistor", value: 1000, nodeA: "src", nodeB: "mid" },
        { componentId: "r2", kind: "resistor", value: 1000, nodeA: "mid", nodeB: "gnd" },
        { componentId: "r3", kind: "resistor", value: 500, nodeA: "floatingA", nodeB: "floatingB" },
      ],
    };
    const { nodeVoltages } = solveDc(netlist);
    expect(nodeVoltages.get("mid")).toBeCloseTo(2.5);
    expect(nodeVoltages.get("floatingA")).toBeUndefined();
    expect(nodeVoltages.get("floatingB")).toBeUndefined();
  });

  it("treats a capacitor as an open circuit - it doesn't connect two nodes for DC purposes", () => {
    const netlist: Netlist = {
      nodes: [
        { id: "gnd", pins: [], isGround: true },
        { id: "src", pins: [], isGround: false, fixedVoltage: 5 },
        { id: "isolated", pins: [], isGround: false },
      ],
      elements: [
        { componentId: "r1", kind: "resistor", value: 1000, nodeA: "src", nodeB: "gnd" },
        { componentId: "c1", kind: "capacitor", value: 1e-7, nodeA: "src", nodeB: "isolated" },
      ],
    };
    const { nodeVoltages } = solveDc(netlist);
    expect(nodeVoltages.get("src")).toBeCloseTo(5);
    // "isolated" is only ever reached via the capacitor, which is not a
    // DC path - it must not be solved as if the capacitor were a wire.
    expect(nodeVoltages.get("isolated")).toBeUndefined();
  });

  it("supports two independent voltage sources feeding one shared node", () => {
    // 5V --- R1(1k) --- mid --- R2(1k) --- 1V, both referenced to GND.
    // Vmid = (5/R1 + 1/R2) / (1/R1 + 1/R2) = (5+1)/2 = 3V when R1=R2.
    const netlist: Netlist = {
      nodes: [
        { id: "gnd", pins: [], isGround: true },
        { id: "srcHigh", pins: [], isGround: false, fixedVoltage: 5 },
        { id: "srcLow", pins: [], isGround: false, fixedVoltage: 1 },
        { id: "mid", pins: [], isGround: false },
      ],
      elements: [
        { componentId: "r1", kind: "resistor", value: 1000, nodeA: "srcHigh", nodeB: "mid" },
        { componentId: "r2", kind: "resistor", value: 1000, nodeA: "srcLow", nodeB: "mid" },
        // gnd is only reachable through the two source nodes for this
        // component - no direct resistor to gnd is needed since both
        // sources already reference it via their own fixedVoltage stamp,
        // but a real BFS-reachability path to *some* ground node is
        // still required for the component to be solved at all, so tie
        // srcHigh to gnd with a large "sense" resistor that doesn't
        // meaningfully affect the divider math.
        { componentId: "rGndPath", kind: "resistor", value: 1e9, nodeA: "srcHigh", nodeB: "gnd" },
      ],
    };
    const { nodeVoltages } = solveDc(netlist);
    expect(nodeVoltages.get("mid")).toBeCloseTo(3, 2);
  });
});
