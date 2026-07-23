import { componentSignalPins } from "@physicalsim/common";
import type { Wire } from "./wiring.js";

// A second, separate model from WiringLayer's own Wire[] - bridged only
// by entity id, the same pattern energy.ts/circuit.ts already established
// (see wiring.ts's own doc comment). WiringLayer stays completely
// ignorant of "board" vs "component" vs "electrical" anything; this file
// is the only place that interprets a Wire as carrying a signal.
//
// Deliberately narrow for this first slice: a SignalLink is exactly one
// component pin wired to exactly one board pin, nothing else. A wire
// between two boards, two components, or a component with no entry in
// componentSignalPins stays purely visual, same as every wire is today.
export interface EntityLookup {
  kind: "board" | "component";
  type: string;
}

export interface SignalLink {
  wireId: string;
  boardId: string;
  boardPinName: string;
  componentId: string;
  componentType: string;
}

export function resolveSignalLinks(
  wires: readonly Wire[],
  findEntity: (entityId: string) => EntityLookup | undefined,
): SignalLink[] {
  const links: SignalLink[] = [];
  for (const wire of wires) {
    const link =
      resolveDirected(wire.id, wire.a, wire.b, findEntity) ??
      resolveDirected(wire.id, wire.b, wire.a, findEntity);
    if (link) links.push(link);
  }
  return links;
}

function resolveDirected(
  wireId: string,
  boardSide: Wire["a"],
  componentSide: Wire["b"],
  findEntity: (entityId: string) => EntityLookup | undefined,
): SignalLink | null {
  const board = findEntity(boardSide.entityId);
  const component = findEntity(componentSide.entityId);
  if (!board || board.kind !== "board") return null;
  if (!component || component.kind !== "component") return null;

  const spec = componentSignalPins[component.type];
  if (!spec || !spec.pinNames.includes(componentSide.pin)) return null;

  return {
    wireId,
    boardId: boardSide.entityId,
    boardPinName: boardSide.pin,
    componentId: componentSide.entityId,
    componentType: component.type,
  };
}
