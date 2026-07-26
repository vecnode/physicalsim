import { getElectricalValue } from "@physicalsim/common";
import type { Wire } from "./wiring.js";
import type { PinPowerInfo } from "./wire-validator.js";

// Turns WiringLayer's own Wire[] (a visual line between two pin names -
// see that file's own doc comment) into an actual electrical netlist:
// which pins are the same node, and which resistor/capacitor sits
// between which two nodes. Deliberately narrow, matching every other
// "resolve wires into something typed" file this project already has
// (canvas/signal-net.ts, canvas/wire-validator.ts) - pure logic, no DOM,
// no Scene, no solver. Building on wire-validator.ts's own pin-power
// classification (GND/VCC, read from a placed element's real pinInfo)
// rather than duplicating it - a ground pin here is exactly the same
// thing a short-circuit check there already had to identify.
//
// What this does NOT do (see ARCHITECTURE.md's "Signal chain" plan):
// solve anything (no Modified Nodal Analysis, no matrix, not even Ohm's
// law) - that's the next, separate piece, built on top of this file's
// output, not inside it. It also doesn't decide how a fixed-voltage node
// with no ground reference in its own connected group should be treated
// - that's a solver-level judgment call (M3), not a netlist-construction
// one; this file just reports the facts (isGround, fixedVoltage) as
// found.
export interface NetlistEntityInfo {
  kind: "board" | "component";
  type: string;
  // A component's PlacedComponent.attrs (circuit.ts) - undefined for a
  // board (CircuitBoard has no attrs field) or a component placed with
  // none set, in which case getElectricalValue()'s own default applies.
  attrs?: Record<string, string>;
}

export interface NetlistPinRef {
  entityId: string;
  pin: string;
}

export interface NetlistNode {
  id: string;
  // Every pin (wired or, for an electrical element's own two terminals,
  // even entirely unwired) grouped into this node.
  pins: NetlistPinRef[];
  // True if any pin in this node is GND-classified (wire-validator.ts's
  // pinPowerInfo()) - a real 0V reference for whichever connected
  // subgraph this node belongs to. Two electrically separate subgraphs
  // (never wired to each other) that each happen to include a ground pin
  // get two different nodes, both isGround: true, not merged into one -
  // they aren't actually the same physical reference.
  isGround: boolean;
  // Set only when this node isn't the ground node itself and at least
  // one of its pins is a VCC-classified pin with a declared voltage (a
  // board's 5V/3V3 rail, say - a real, static source independent of any
  // firmware, unlike a GPIO pin's level, which depends on pinMode()/
  // digitalWrite() at runtime and isn't resolved by this file at all -
  // see ARCHITECTURE.md's M5 for why that's later, separate work).
  fixedVoltage?: number;
}

export type NetlistElementKind = "resistor" | "capacitor";

export interface NetlistElement {
  componentId: string;
  kind: NetlistElementKind;
  value: number; // ohms for a resistor, farads for a capacitor
  nodeA: string;
  nodeB: string;
}

export interface Netlist {
  nodes: NetlistNode[];
  elements: NetlistElement[];
}

function pinKey(entityId: string, pin: string): string {
  return `${entityId}:${pin}`;
}

// A minimal union-find over pin keys - wires are the only edges. Path
// compression only (no union-by-rank): the pin counts involved here are
// always small (this app's whole canvas, not an arbitrary graph), so the
// simpler implementation is the right one, not a premature optimization.
class UnionFind {
  private readonly parent = new Map<string, string>();

  private root(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    let cur = x;
    while (this.parent.get(cur) !== r) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, r);
      cur = next;
    }
    return r;
  }

  union(a: string, b: string): void {
    const ra = this.root(a);
    const rb = this.root(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }

  find(x: string): string {
    return this.root(x);
  }
}

// Every component componentElectricalParams (@physicalsim/common) knows
// about - ResistorElement/CapacitorElement - has exactly two electrical
// terminals, always named "1"/"2" (see each element's own pinInfo). Not
// a general "any of N pins" lookup (unlike componentSignalPins' role-
// based matching) since neither part has a third terminal.
const ELEMENT_PIN_A = "1";
const ELEMENT_PIN_B = "2";

export function buildNetlist(
  wires: readonly Wire[],
  entities: ReadonlyMap<string, NetlistEntityInfo>,
  getPinPower: (entityId: string, pin: string) => PinPowerInfo | undefined,
  // Optional (M5 of the analog signal-chain roadmap): a firmware-driven
  // GPIO output pin is a real, if runtime-determined, voltage source -
  // something pinPowerInfo's static @wokwi/elements metadata alone can
  // never know (a plain GPIO pin's signals array is empty; direction and
  // level only exist at runtime, inside a running adapter). Callers that
  // can resolve this (analog-net-chain.ts polls the adapter for it) pass
  // it here so it merges into node.fixedVoltage the same way a static
  // VCC pin already does; callers that can't (or a purely static
  // analysis, like every M1-M4 test) simply omit it. Takes priority over
  // a static VCC classification on the same node if both are somehow
  // present, since a live-firmware-driven value is more current than
  // whatever the element's own pinInfo declares.
  getRuntimeVoltage?: (entityId: string, pin: string) => number | undefined,
): Netlist {
  const uf = new UnionFind();
  for (const wire of wires) {
    uf.union(pinKey(wire.a.entityId, wire.a.pin), pinKey(wire.b.entityId, wire.b.pin));
  }

  const electricalComponents: Array<{ entityId: string; kind: NetlistElementKind; value: number }> = [];
  for (const [entityId, info] of entities) {
    if (info.kind !== "component") continue;
    const value = getElectricalValue(info.type, info.attrs);
    if (value === undefined) continue; // not an electrical component (most of the catalog)
    electricalComponents.push({ entityId, kind: info.type as NetlistElementKind, value });
  }

  // Every pin that needs a node: every wire endpoint, plus every
  // electrical element's own two terminals (even a fully floating
  // resistor still has two real, if isolated, nodes).
  const allPins: NetlistPinRef[] = [];
  for (const wire of wires) {
    allPins.push({ entityId: wire.a.entityId, pin: wire.a.pin });
    allPins.push({ entityId: wire.b.entityId, pin: wire.b.pin });
  }
  for (const c of electricalComponents) {
    allPins.push({ entityId: c.entityId, pin: ELEMENT_PIN_A });
    allPins.push({ entityId: c.entityId, pin: ELEMENT_PIN_B });
  }

  const groups = new Map<string, NetlistPinRef[]>();
  for (const p of allPins) {
    const root = uf.find(pinKey(p.entityId, p.pin));
    let group = groups.get(root);
    if (!group) {
      group = [];
      groups.set(root, group);
    }
    if (!group.some((q) => q.entityId === p.entityId && q.pin === p.pin)) group.push(p);
  }

  const rootToId = new Map<string, string>();
  const nodes: NetlistNode[] = [];
  let nextIndex = 1;
  for (const [root, pins] of groups) {
    let isGround = false;
    let fixedVoltage: number | undefined;
    for (const p of pins) {
      const power = getPinPower(p.entityId, p.pin);
      if (power) {
        if (power.kind === "gnd") isGround = true;
        if (power.kind === "vcc" && power.voltage !== undefined) fixedVoltage = power.voltage;
      }
      const runtimeVoltage = getRuntimeVoltage?.(p.entityId, p.pin);
      if (runtimeVoltage !== undefined) fixedVoltage = runtimeVoltage;
    }
    // Ids are always sequential, never a shared "gnd" string - two
    // electrically separate grounded subgraphs are two different nodes
    // (see isGround's own doc comment above), so the id can't double as
    // the ground marker; isGround does that instead.
    const id = `n${nextIndex++}`;
    rootToId.set(root, id);
    nodes.push({ id, pins, isGround, fixedVoltage: isGround ? undefined : fixedVoltage });
  }

  const elements: NetlistElement[] = electricalComponents.map((c) => ({
    componentId: c.entityId,
    kind: c.kind,
    value: c.value,
    nodeA: rootToId.get(uf.find(pinKey(c.entityId, ELEMENT_PIN_A)))!,
    nodeB: rootToId.get(uf.find(pinKey(c.entityId, ELEMENT_PIN_B)))!,
  }));

  return { nodes, elements };
}

// Finds which node a given pin ended up in - the counterpart callers need
// to map a Wire's own two endpoints (which, by definition, are always the
// same node - that's what a wire *is*) back to a solved voltage. A linear
// scan, not a lookup table returned from buildNetlist() itself: node/pin
// counts here are always small (this app's whole canvas, not an
// arbitrary graph), so a second table just for this would be premature.
export function findNodeForPin(netlist: Netlist, entityId: string, pin: string): NetlistNode | undefined {
  return netlist.nodes.find((n) => n.pins.some((p) => p.entityId === entityId && p.pin === pin));
}
