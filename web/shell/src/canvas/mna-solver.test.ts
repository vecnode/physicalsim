import { describe, expect, it } from "vitest";
import { solveDc, solveTransientStep } from "./mna-solver.js";
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

  it("an LED driven well above its forward voltage through a current-limiting resistor conducts, dropping close to its forward voltage", () => {
    // 5V --- R(220) --- anode --[LED, Vf=2V]-- cathode --- GND
    const netlist: Netlist = {
      nodes: [
        { id: "gnd", pins: [], isGround: true },
        { id: "src", pins: [], isGround: false, fixedVoltage: 5 },
        { id: "anode", pins: [], isGround: false },
      ],
      elements: [
        { componentId: "r1", kind: "resistor", value: 220, nodeA: "src", nodeB: "anode" },
        { componentId: "led1", kind: "led", value: 2, nodeA: "anode", nodeB: "gnd" },
      ],
    };
    const { nodeVoltages } = solveDc(netlist);
    // The anode should land close to the LED's own forward voltage (2V) -
    // comfortably above the 0V it would be if the LED were still being
    // stamped as off (no source current), and comfortably below the
    // ~4.9V it would be if it were stamped as a plain high resistance
    // never re-linearized upward.
    expect(nodeVoltages.get("anode")!).toBeGreaterThan(1.9);
    expect(nodeVoltages.get("anode")!).toBeLessThan(2.5);
  });

  it("an LED driven by a source voltage below its forward voltage stays off (dark), not clamped up to the threshold", () => {
    // 1V is not enough to forward-bias a 2V-Vf LED - it should stay dark,
    // the anode sitting near the source voltage (no significant current
    // flowing through the LED's own off-state near-open conductance).
    const netlist: Netlist = {
      nodes: [
        { id: "gnd", pins: [], isGround: true },
        { id: "src", pins: [], isGround: false, fixedVoltage: 1 },
        { id: "anode", pins: [], isGround: false },
      ],
      elements: [
        { componentId: "r1", kind: "resistor", value: 220, nodeA: "src", nodeB: "anode" },
        { componentId: "led1", kind: "led", value: 2, nodeA: "anode", nodeB: "gnd" },
      ],
    };
    const { nodeVoltages } = solveDc(netlist);
    expect(nodeVoltages.get("anode")!).toBeCloseTo(1, 1);
  });
});

describe("solveTransientStep", () => {
  it("an RC charging circuit tracks the closed-form exponential curve (V = Vs * (1 - e^-t/tau))", () => {
    const R = 1000;
    const C = 1e-6; // 1 microfarad
    const tau = R * C; // 1ms
    const Vsource = 5;
    const netlist: Netlist = {
      nodes: [
        { id: "gnd", pins: [], isGround: true },
        { id: "src", pins: [], isGround: false, fixedVoltage: Vsource },
        { id: "cap", pins: [], isGround: false },
      ],
      elements: [
        { componentId: "r1", kind: "resistor", value: R, nodeA: "src", nodeB: "cap" },
        { componentId: "c1", kind: "capacitor", value: C, nodeA: "cap", nodeB: "gnd" },
      ],
    };

    const dt = tau / 100; // small relative to tau - backward-Euler's O(dt) error stays tight
    let voltages: ReadonlyMap<string, number | undefined> = new Map([["cap", 0]]); // starts uncharged
    const steps = Math.round((tau * 5) / dt);
    for (let i = 0; i < steps; i++) {
      voltages = solveTransientStep(netlist, dt, voltages).nodeVoltages;
    }

    const expected = Vsource * (1 - Math.exp(-5)); // t = 5*tau
    expect(voltages.get("cap")!).toBeCloseTo(expected, 1);
  });

  it("an RC discharging circuit (no source, just a charged capacitor and a resistor to ground) decays as V = V0 * e^-t/tau", () => {
    const R = 1000;
    const C = 1e-6;
    const tau = R * C;
    const netlist: Netlist = {
      nodes: [
        { id: "gnd", pins: [], isGround: true },
        { id: "cap", pins: [], isGround: false },
      ],
      elements: [
        { componentId: "r1", kind: "resistor", value: R, nodeA: "cap", nodeB: "gnd" },
        { componentId: "c1", kind: "capacitor", value: C, nodeA: "cap", nodeB: "gnd" },
      ],
    };

    const dt = tau / 100;
    let voltages: ReadonlyMap<string, number | undefined> = new Map([["cap", 5]]); // starts charged to 5V
    const steps = Math.round((tau * 3) / dt);
    for (let i = 0; i < steps; i++) {
      voltages = solveTransientStep(netlist, dt, voltages).nodeVoltages;
    }

    const expected = 5 * Math.exp(-3); // t = 3*tau
    expect(voltages.get("cap")!).toBeCloseTo(expected, 1);
  });

  it("a capacitor with no discharge path holds its previous voltage exactly (ideal memory)", () => {
    const netlist: Netlist = {
      nodes: [
        { id: "gnd", pins: [], isGround: true },
        { id: "cap", pins: [], isGround: false },
      ],
      elements: [{ componentId: "c1", kind: "capacitor", value: 1e-6, nodeA: "cap", nodeB: "gnd" }],
    };
    const voltages = solveTransientStep(netlist, 1e-5, new Map([["cap", 3.3]])).nodeVoltages;
    expect(voltages.get("cap")).toBeCloseTo(3.3);
  });

  it("treats a missing previous-voltage entry as an uncharged (0V) capacitor", () => {
    const netlist: Netlist = {
      nodes: [
        { id: "gnd", pins: [], isGround: true },
        { id: "cap", pins: [], isGround: false },
      ],
      elements: [{ componentId: "c1", kind: "capacitor", value: 1e-6, nodeA: "cap", nodeB: "gnd" }],
    };
    const voltages = solveTransientStep(netlist, 1e-5, new Map()).nodeVoltages;
    expect(voltages.get("cap")).toBeCloseTo(0);
  });

  it("a capacitor (unlike solveDc) does create a conducting path - it's not treated as an open circuit here", () => {
    // Same shape as solveDc's own "treats a capacitor as an open
    // circuit" test - the opposite assertion, confirming the two
    // functions genuinely differ in this one specific way.
    const netlist: Netlist = {
      nodes: [
        { id: "gnd", pins: [], isGround: true },
        { id: "src", pins: [], isGround: false, fixedVoltage: 5 },
        { id: "reachedOnlyViaCapacitor", pins: [], isGround: false },
      ],
      elements: [
        { componentId: "r1", kind: "resistor", value: 1000, nodeA: "src", nodeB: "gnd" },
        { componentId: "c1", kind: "capacitor", value: 1e-7, nodeA: "src", nodeB: "reachedOnlyViaCapacitor" },
      ],
    };
    const voltages = solveTransientStep(netlist, 1e-6, new Map()).nodeVoltages;
    expect(voltages.get("reachedOnlyViaCapacitor")).not.toBeUndefined();
  });
});
