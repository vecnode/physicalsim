import { componentAnalogPins } from "@physicalsim/common";
import type { Wire } from "./wiring.js";
import type { EntityLookup } from "./signal-net.js";

// Analog counterpart to signal-net.ts's resolveSignalLinks(): a wire
// between a board pin and a specific named analog pin on a placed
// component (componentAnalogPins, not componentSignalPins - see that
// file for why they're separate tables). Unlike SignalLink, this also
// carries which componentAnalogPins entry matched, since a component can
// have several independent analog pins (analog-joystick's VERT/HORZ)
// each needing its own toVoltage() - one entity id alone isn't enough to
// know which.
export interface AnalogLink {
  wireId: string;
  boardId: string;
  boardPinName: string;
  componentId: string;
  componentType: string;
  componentPinName: string;
}

export function resolveAnalogLinks(
  wires: readonly Wire[],
  findEntity: (entityId: string) => EntityLookup | undefined,
): AnalogLink[] {
  const links: AnalogLink[] = [];
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
): AnalogLink | null {
  const board = findEntity(boardSide.entityId);
  const component = findEntity(componentSide.entityId);
  if (!board || board.kind !== "board") return null;
  if (!component || component.kind !== "component") return null;

  const pins = componentAnalogPins[component.type];
  const pin = pins?.find((p) => p.pinName === componentSide.pin);
  if (!pin) return null;

  return {
    wireId,
    boardId: boardSide.entityId,
    boardPinName: boardSide.pin,
    componentId: componentSide.entityId,
    componentType: component.type,
    componentPinName: pin.pinName,
  };
}
