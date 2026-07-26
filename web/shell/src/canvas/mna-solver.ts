import type { Netlist, NetlistElement, NetlistNode } from "./netlist.js";

// Solves a netlist via Modified Nodal Analysis - dense Gaussian
// elimination with partial pivoting (component counts here are always
// small, tens not thousands, so no sparse solver is warranted). Two
// entry points share the same core (solveNetwork() below):
//
// - solveDc() - steady-state DC. Only resistors (and, per below, LEDs)
//   conduct; a capacitor is an open circuit, its real, textbook-correct
//   behavior in DC steady state (a charged capacitor blocks DC current),
//   not a simplification.
// - solveTransientStep() - one fixed-timestep backward-Euler step (M4 of
//   the analog signal-chain roadmap - see ARCHITECTURE.md's "Signal
//   chain" plan): a capacitor becomes a companion conductance (C/dt) in
//   parallel with a current source derived from the *previous* step's
//   voltage across it - the standard implicit-integration treatment,
//   stamped fresh every call (no state kept in this file; the caller
//   owns the voltage history and timestep cadence).
//
// An LED is genuinely nonlinear (its real I-V curve is exponential), and
// this file deliberately doesn't implement a Newton-Raphson loop to
// convergence for it - see stampLeds()'s own doc comment for the
// two-pass piecewise-linear approximation used instead.
//
// A fixed-voltage node (netlist.ts's NetlistNode.fixedVoltage) only means
// something relative to a ground reference. Both entry points partition
// the netlist into connected components first (nodes joined by at least
// one conducting edge) and solve each independently: a component with a
// ground node solves normally with that as its 0V reference; a component
// with no ground node anywhere in it (a network dangling off nothing, or
// an entirely separate unwired sub-circuit) has every one of its node
// voltages reported as undefined, rather than solved against an
// arbitrary, meaningless reference.
export interface DcSolution {
  nodeVoltages: Map<string, number | undefined>;
}

export interface TransientSolution {
  nodeVoltages: Map<string, number | undefined>;
}

// One conducting edge between two nodes, already reduced to its linear
// companion model - a plain resistor (sourceCurrent 0) or a capacitor's
// backward-Euler companion (conductance = C/dt, sourceCurrent derived
// from its previous voltage). `sourceCurrent` flows into nodeA and out
// of nodeB, matching the standard MNA independent-current-source
// convention.
interface StampedEdge {
  nodeA: string;
  nodeB: string;
  conductance: number;
  sourceCurrent: number;
}

// LED companion-model constants (see stampLeds()). LED_ON_RESISTANCE_OHMS
// is a typical small-signal dynamic resistance once a real LED is
// conducting above its forward-voltage knee - not zero (a real diode
// isn't an ideal switch) but small enough that a series current-limiting
// resistor still dominates the divider, exactly like a real circuit.
// LED_OFF_CONDUCTANCE is "not quite an open circuit" (a literal 0 would
// risk an isolated/singular node in gaussianSolve()) while still being
// negligible next to any real resistor value this app's examples use.
const LED_ON_RESISTANCE_OHMS = 10;
const LED_OFF_CONDUCTANCE = 1e-9;

function stampResistors(elements: readonly NetlistElement[]): StampedEdge[] {
  return elements
    .filter((e): e is NetlistElement & { kind: "resistor" } => e.kind === "resistor")
    .map((r) => ({ nodeA: r.nodeA, nodeB: r.nodeB, conductance: 1 / r.value, sourceCurrent: 0 }));
}

function voltageAcross(voltages: ReadonlyMap<string, number | undefined>, nodeA: string, nodeB: string): number {
  return (voltages.get(nodeA) ?? 0) - (voltages.get(nodeB) ?? 0);
}

// An LED as a two-segment piecewise-linear diode: below its forward-
// voltage threshold (e.value) it's LED_OFF_CONDUCTANCE (dark, effectively
// open); at or above it, it's a small on-resistance in series with an
// ideal `e.value`-volt drop, expressed the same way the capacitor's own
// companion model already is here (a conductance stamp plus a current
// source: G*e.value reproduces exactly a `value`-volt drop across
// LED_ON_RESISTANCE_OHMS once conducting). Which segment applies depends
// on the very voltage this element hasn't solved yet - the classic
// diode chicken-and-egg problem a real SPICE engine resolves with
// Newton-Raphson iteration to numerical convergence. This file instead
// takes `guessVoltage` from the caller (0V, i.e. "assume off", for a
// first pass; the first pass's own solved answer for a second) - one
// re-linearization is enough to get the right segment for the steady,
// non-borderline states a GPIO pin driving an LED actually produces
// (comfortably above or below the threshold, never balanced exactly on
// it), without the added complexity of iterating to a convergence
// tolerance.
function stampLed(e: NetlistElement, guessVoltage: number): StampedEdge {
  const forwardVoltage = e.value;
  if (guessVoltage >= forwardVoltage) {
    const conductance = 1 / LED_ON_RESISTANCE_OHMS;
    return { nodeA: e.nodeA, nodeB: e.nodeB, conductance, sourceCurrent: conductance * forwardVoltage };
  }
  return { nodeA: e.nodeA, nodeB: e.nodeB, conductance: LED_OFF_CONDUCTANCE, sourceCurrent: 0 };
}

// Resolves every LED in `netlist` against `baseEdges` (whatever resistor/
// capacitor edges the caller already stamped) via the two-pass
// re-linearization stampLed() itself documents. Returns the same
// Map<string, number | undefined> shape solveNetwork() always does;
// callers with no LEDs at all skip straight to a single solveNetwork()
// call instead (there's nothing to re-linearize).
function solveWithLeds(nodes: Netlist["nodes"], baseEdges: readonly StampedEdge[], leds: readonly NetlistElement[]): Map<string, number | undefined> {
  if (leds.length === 0) return solveNetwork(nodes, baseEdges);
  const pass1 = solveNetwork(nodes, [...baseEdges, ...leds.map((e) => stampLed(e, 0))]);
  const pass2Edges = [...baseEdges, ...leds.map((e) => stampLed(e, voltageAcross(pass1, e.nodeA, e.nodeB)))];
  return solveNetwork(nodes, pass2Edges);
}

export function solveDc(netlist: Netlist): DcSolution {
  const resistorEdges = stampResistors(netlist.elements);
  const leds = netlist.elements.filter((e) => e.kind === "led");
  return { nodeVoltages: solveWithLeds(netlist.nodes, resistorEdges, leds) };
}

// One backward-Euler step at a fixed timestep `dt` (seconds). Every
// resistor is stamped exactly as in solveDc(); every capacitor is
// stamped as its companion conductance + a current source built from
// `previousVoltages` (the prior step's solved voltages, e.g. this
// function's own last return value, or solveDc()'s result for the very
// first step if the caller wants to start from a resistive steady state
// rather than "capacitors uncharged" - that policy choice belongs to the
// caller, not this function). A node missing from `previousVoltages`
// (never solved yet, or previously unresolved) is treated as 0V - a
// capacitor with no prior history starts uncharged, the same real,
// physically correct default most SPICE engines use.
export function solveTransientStep(
  netlist: Netlist,
  dt: number,
  previousVoltages: ReadonlyMap<string, number | undefined>,
): TransientSolution {
  const voltageAt = (nodeId: string): number => previousVoltages.get(nodeId) ?? 0;

  const edges: StampedEdge[] = [];
  const leds: NetlistElement[] = [];
  for (const e of netlist.elements) {
    if (e.kind === "resistor") {
      edges.push({ nodeA: e.nodeA, nodeB: e.nodeB, conductance: 1 / e.value, sourceCurrent: 0 });
      continue;
    }
    if (e.kind === "led") {
      leds.push(e); // resolved below, alongside solveDc()'s own LED handling - not a companion model of its own
      continue;
    }
    // Capacitor, backward-Euler companion model: G_eq = C/dt, in
    // parallel with a current source I_eq = G_eq * v_prev (v_prev = the
    // previous step's V(nodeA) - V(nodeB)) - with only this element
    // between the two nodes, solving G_eq*(VA-VB) = I_eq reproduces
    // VA-VB = v_prev exactly, which is the "memory" a capacitor's
    // voltage can't change instantaneously without current actually
    // flowing.
    const conductance = e.value / dt;
    const vPrev = voltageAt(e.nodeA) - voltageAt(e.nodeB);
    edges.push({ nodeA: e.nodeA, nodeB: e.nodeB, conductance, sourceCurrent: conductance * vPrev });
  }
  return { nodeVoltages: solveWithLeds(netlist.nodes, edges, leds) };
}

function solveNetwork(nodes: readonly NetlistNode[], edges: readonly StampedEdge[]): Map<string, number | undefined> {
  const nodeIds = nodes.map((n) => n.id);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const adjacency = new Map<string, Set<string>>();
  for (const id of nodeIds) adjacency.set(id, new Set());
  for (const edge of edges) {
    adjacency.get(edge.nodeA)?.add(edge.nodeB);
    adjacency.get(edge.nodeB)?.add(edge.nodeA);
  }

  const visited = new Set<string>();
  const components: string[][] = [];
  for (const id of nodeIds) {
    if (visited.has(id)) continue;
    const component: string[] = [];
    const queue = [id];
    visited.add(id);
    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      for (const next of adjacency.get(current) ?? []) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    components.push(component);
  }

  const nodeVoltages = new Map<string, number | undefined>();
  for (const component of components) {
    const groundId = component.find((id) => nodeById.get(id)?.isGround);
    if (!groundId) {
      for (const id of component) nodeVoltages.set(id, undefined);
      continue;
    }
    const solved = solveGroundedComponent(component, groundId, edges, nodeById);
    for (const [id, v] of solved) nodeVoltages.set(id, v);
  }

  return nodeVoltages;
}

function solveGroundedComponent(
  componentNodeIds: string[],
  groundId: string,
  edges: readonly StampedEdge[],
  nodeById: ReadonlyMap<string, NetlistNode>,
): Map<string, number | undefined> {
  // Unknowns: every non-ground node's voltage, plus one extra unknown per
  // fixed-voltage node's own source current - the standard MNA
  // augmentation for an ideal voltage source (a plain conductance stamp
  // can't represent "this node is pinned to exactly this voltage" on its
  // own).
  const unknownNodeIds = componentNodeIds.filter((id) => id !== groundId);
  const voltageSourceNodeIds = unknownNodeIds.filter((id) => nodeById.get(id)?.fixedVoltage !== undefined);

  const nodeIndex = new Map<string, number>();
  unknownNodeIds.forEach((id, i) => nodeIndex.set(id, i));
  const sourceIndex = new Map<string, number>();
  voltageSourceNodeIds.forEach((id, i) => sourceIndex.set(id, unknownNodeIds.length + i));

  const size = unknownNodeIds.length + voltageSourceNodeIds.length;
  const A: number[][] = Array.from({ length: size }, () => new Array(size).fill(0));
  const b: number[] = new Array(size).fill(0);

  const indexOf = (id: string): number => (id === groundId ? -1 : nodeIndex.get(id)!);

  const componentSet = new Set(componentNodeIds);
  for (const edge of edges) {
    if (!componentSet.has(edge.nodeA) || !componentSet.has(edge.nodeB)) continue;
    const ia = indexOf(edge.nodeA);
    const ib = indexOf(edge.nodeB);
    if (ia >= 0) A[ia][ia] += edge.conductance;
    if (ib >= 0) A[ib][ib] += edge.conductance;
    if (ia >= 0 && ib >= 0) {
      A[ia][ib] -= edge.conductance;
      A[ib][ia] -= edge.conductance;
    }
    // Independent current source: flows into nodeA, out of nodeB (see
    // StampedEdge's own doc comment) - contributes directly to the RHS,
    // not the coefficient matrix.
    if (edge.sourceCurrent !== 0) {
      if (ia >= 0) b[ia] += edge.sourceCurrent;
      if (ib >= 0) b[ib] -= edge.sourceCurrent;
    }
  }

  for (const id of voltageSourceNodeIds) {
    const ni = nodeIndex.get(id)!;
    const si = sourceIndex.get(id)!;
    A[ni][si] += 1;
    A[si][ni] += 1;
    b[si] = nodeById.get(id)!.fixedVoltage!;
  }

  const voltages = new Map<string, number | undefined>();
  voltages.set(groundId, 0);

  const x = gaussianSolve(A, b);
  if (!x) {
    // Singular system - not expected to arise from any netlist.ts shape
    // in practice (see this file's own reasoning), but defensive rather
    // than silently returning garbage if it ever does: every non-ground
    // node in this component is reported unresolved, same as "no ground
    // reachable at all".
    for (const id of unknownNodeIds) voltages.set(id, undefined);
    return voltages;
  }
  for (const id of unknownNodeIds) voltages.set(id, x[nodeIndex.get(id)!]);
  return voltages;
}

// Gaussian elimination with partial pivoting - returns null for a
// singular (unsolvable) matrix rather than dividing by ~0 and returning
// garbage.
function gaussianSolve(A: readonly number[][], b: readonly number[]): number[] | null {
  const n = b.length;
  if (n === 0) return [];
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[pivotRow][col])) pivotRow = row;
    }
    if (Math.abs(M[pivotRow][col]) < 1e-12) return null;
    [M[col], M[pivotRow]] = [M[pivotRow], M[col]];

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = M[row][col] / M[col][col];
      for (let c = col; c <= n; c++) M[row][c] -= factor * M[col][c];
    }
  }

  return M.map((row, i) => row[n] / row[i]);
}
