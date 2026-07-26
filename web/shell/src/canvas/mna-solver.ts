import type { Netlist, NetlistElement } from "./netlist.js";

// Solves a netlist's resistive DC steady state via Modified Nodal
// Analysis - dense Gaussian elimination with partial pivoting (component
// counts here are always small, tens not thousands, so no sparse solver
// is warranted). DC-only for now (M3 of the analog signal-chain roadmap -
// see ARCHITECTURE.md's "Signal chain" plan): capacitors are treated as
// open circuits here, which is their real, textbook-correct behavior in
// DC steady state (a charged capacitor blocks DC current), not a
// simplification - M4 adds their actual transient (backward-Euler)
// behavior for a running, time-stepped solve.
//
// A fixed-voltage node (netlist.ts's NetlistNode.fixedVoltage) only means
// something relative to a ground reference. Rather than assume the whole
// netlist shares one, this partitions it into connected components first
// (nodes joined by at least one resistor path - see doc comment above on
// why capacitors don't create an edge here) and solves each
// independently: a component with a ground node solves normally with
// that as its 0V reference; a component with no ground node in it at all
// (a resistor network dangling off nothing, or an entirely separate
// unwired sub-circuit) has every one of its node voltages reported as
// undefined, rather than solved against an arbitrary, meaningless
// reference.
export interface DcSolution {
  nodeVoltages: Map<string, number | undefined>;
}

export function solveDc(netlist: Netlist): DcSolution {
  const nodeIds = netlist.nodes.map((n) => n.id);
  const nodeById = new Map(netlist.nodes.map((n) => [n.id, n]));
  const resistors = netlist.elements.filter((e) => e.kind === "resistor");

  const adjacency = new Map<string, Set<string>>();
  for (const id of nodeIds) adjacency.set(id, new Set());
  for (const r of resistors) {
    adjacency.get(r.nodeA)?.add(r.nodeB);
    adjacency.get(r.nodeB)?.add(r.nodeA);
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
    const solved = solveGroundedComponent(component, groundId, resistors, nodeById);
    for (const [id, v] of solved) nodeVoltages.set(id, v);
  }

  return { nodeVoltages };
}

function solveGroundedComponent(
  componentNodeIds: string[],
  groundId: string,
  resistors: readonly NetlistElement[],
  nodeById: ReadonlyMap<string, Netlist["nodes"][number]>,
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

  const stampConductance = (nodeA: string, nodeB: string, g: number): void => {
    const ia = nodeA === groundId ? -1 : nodeIndex.get(nodeA)!;
    const ib = nodeB === groundId ? -1 : nodeIndex.get(nodeB)!;
    if (ia >= 0) A[ia][ia] += g;
    if (ib >= 0) A[ib][ib] += g;
    if (ia >= 0 && ib >= 0) {
      A[ia][ib] -= g;
      A[ib][ia] -= g;
    }
  };

  const componentSet = new Set(componentNodeIds);
  for (const r of resistors) {
    if (!componentSet.has(r.nodeA) || !componentSet.has(r.nodeB)) continue;
    stampConductance(r.nodeA, r.nodeB, 1 / r.value);
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
