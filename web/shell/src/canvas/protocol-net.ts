import { componentProtocols } from "@physicalsim/common";
import type { Wire } from "./wiring.js";
import type { EntityLookup } from "./signal-net.js";

// The multi-pin counterpart to signal-net.ts's SignalLink - a second,
// separate resolution over the same WiringLayer.getWires(), for
// components whose behavior needs several correlated board pins rather
// than one. WiringLayer stays just as ignorant of this as it is of
// SignalLink; this file is the only place a Wire set gets interpreted as
// "an LCD's RS/E/D4-D7 bus", the same "one interpretation, one file"
// posture signal-net.ts already established.
export interface ProtocolLink {
  componentId: string;
  componentType: string;
  boardId: string;
  // role name -> which board pin (and which wire) satisfies it. Complete
  // only once every role componentProtocols[componentType] names has an
  // entry here - see resolveProtocolLinks() below.
  pins: Record<string, { boardPinName: string; wireId: string }>;
}

interface PartialLink {
  componentType: string;
  boardId: string;
  pins: Record<string, { boardPinName: string; wireId: string }>;
}

// Deliberately tolerant of a partially-wired component: it just never
// appears in the returned array until every required role is present,
// the same way an entirely unwired component never appeared in
// resolveSignalLinks() either.
export function resolveProtocolLinks(
  wires: readonly Wire[],
  findEntity: (entityId: string) => EntityLookup | undefined,
): ProtocolLink[] {
  const byComponent = new Map<string, PartialLink>();

  for (const wire of wires) {
    tryAssignRole(wire, wire.a, wire.b, findEntity, byComponent);
    tryAssignRole(wire, wire.b, wire.a, findEntity, byComponent);
  }

  const links: ProtocolLink[] = [];
  for (const [componentId, entry] of byComponent) {
    const protocol = componentProtocols[entry.componentType];
    if (!protocol) continue;
    const complete = Object.keys(protocol.roles).every((role) => role in entry.pins);
    if (complete) {
      links.push({
        componentId,
        componentType: entry.componentType,
        boardId: entry.boardId,
        pins: entry.pins,
      });
    }
  }
  return links;
}

function tryAssignRole(
  wire: Wire,
  boardSide: Wire["a"],
  componentSide: Wire["b"],
  findEntity: (entityId: string) => EntityLookup | undefined,
  byComponent: Map<string, PartialLink>,
): void {
  const board = findEntity(boardSide.entityId);
  const component = findEntity(componentSide.entityId);
  if (!board || board.kind !== "board") return;
  if (!component || component.kind !== "component") return;

  const protocol = componentProtocols[component.type];
  if (!protocol) return;

  for (const [roleName, spec] of Object.entries(protocol.roles)) {
    if (!spec.pinNames.includes(componentSide.pin)) continue;
    let entry = byComponent.get(componentSide.entityId);
    if (!entry) {
      entry = { componentType: component.type, boardId: boardSide.entityId, pins: {} };
      byComponent.set(componentSide.entityId, entry);
    }
    entry.pins[roleName] = { boardPinName: boardSide.pin, wireId: wire.id };
    return;
  }
}
