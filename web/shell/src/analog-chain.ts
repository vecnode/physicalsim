import { CircuitPin, boardPinMaps, componentAnalogPins, resolveBoardPinName } from "@physicalsim/common";
import type { AdapterId, SimClient } from "./adapter-registry.js";
import type { Scene } from "./canvas/scene.js";
import { resolveAnalogLinks, type AnalogLink } from "./canvas/analog-net.js";
import type { EntityLookup } from "./canvas/signal-net.js";

interface Attachment {
  dispose: () => void;
}

// Analog counterpart to signal-chain.ts's SignalChain: glues analog-
// net.ts's resolved AnalogLinks to a board's writeAnalogPin? (avr8 and
// rp2040 - see adapter-types.ts). Structurally the same
// shape as SignalChain/ProtocolChain (recompute on wire-set changes,
// attach/dispose per link, board-agnostic via boardPinMaps/
// resolveBoardPinName/CircuitPin.forBoardPin), keyed by wireId since one
// analog link is exactly one wire, same as SignalChain.
export class AnalogChain {
  private readonly active = new Map<string, Attachment>();

  constructor(
    private readonly scene: Scene,
    private readonly getAdapterClient: (id: AdapterId) => SimClient,
  ) {
    scene.wiring.onWiresChanged(() => this.recompute());
  }

  private findEntity(entityId: string): EntityLookup | undefined {
    const board = this.scene.circuit.boards.find((b) => b.id === entityId);
    if (board) return { kind: "board", type: board.type };
    const component = this.scene.circuit.components.find((c) => c.id === entityId);
    if (component) return { kind: "component", type: component.type };
    return undefined;
  }

  private recompute(): void {
    const links = resolveAnalogLinks(this.scene.wiring.getWires(), (id) => this.findEntity(id));
    const liveWireIds = new Set(links.map((link) => link.wireId));

    for (const [wireId, attachment] of this.active) {
      if (!liveWireIds.has(wireId)) {
        attachment.dispose();
        this.active.delete(wireId);
      }
    }

    for (const link of links) {
      if (this.active.has(link.wireId)) continue;
      const attachment = this.attach(link);
      if (attachment) this.active.set(link.wireId, attachment);
    }
  }

  // Resolves one link down to a live CircuitPin and re-applies its
  // voltage on every 'input' event the placed element fires (potentiometer-
  // element.ts/analog-joystick-element.ts's own dispatchEvent), plus once
  // immediately on attach so a pot that's already off-center before
  // wiring still reads correctly right away. Returns null (a no-op, not a
  // throw) for anything not yet resolvable - an unknown board type, or a
  // board whose adapter has no writeAnalogPin? (writeAnalog() rejects,
  // caught below) - same posture as SignalChain.attach()/ProtocolChain.
  // attach().
  private attach(link: AnalogLink): Attachment | null {
    const board = this.scene.circuit.boards.find((b) => b.id === link.boardId);
    const boardPinMap = board && boardPinMaps[board.type];
    const spec = componentAnalogPins[link.componentType]?.find(
      (p) => p.pinName === link.componentPinName,
    );
    const dom = this.scene.getDom(link.componentId);
    if (!board || !boardPinMap || !spec || !dom) return null;

    let pin: CircuitPin;
    try {
      const pinName = resolveBoardPinName(board.type, link.boardPinName);
      pin = CircuitPin.forBoardPin(this.getAdapterClient(board.adapterId), boardPinMap, pinName);
    } catch {
      return null;
    }

    const apply = () => {
      const el = dom.boardEl as unknown as Record<string, unknown>;
      void pin.writeAnalog(spec.toVoltage(el)).catch(() => {
        // This particular pin isn't ADC-capable (writeAnalogPin() rejects
        // it on its own - adapter-types.ts) - silently inert, same as an
        // unresolvable board pin elsewhere in this file.
      });
    };
    dom.boardEl.addEventListener("input", apply);
    apply();
    return {
      dispose: () => dom.boardEl.removeEventListener("input", apply),
    };
  }
}
