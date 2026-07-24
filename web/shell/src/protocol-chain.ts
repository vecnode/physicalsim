import { CircuitPin, Hd44780Decoder, boardPinMaps, resolveBoardPinName } from "@physicalsim/common";
import type { AdapterId, SimClient } from "./adapter-registry.js";
import type { Scene } from "./canvas/scene.js";
import { resolveProtocolLinks, type ProtocolLink } from "./canvas/protocol-net.js";
import type { EntityLookup } from "./canvas/signal-net.js";

interface ProtocolAttachment {
  dispose: () => void;
}

// One factory per componentProtocols entry (web/common) - given real
// CircuitPins for every role and the placed element's own DOM node,
// builds whatever decoder actually drives it and returns a disposer.
// This is the one place a decoder gets bound to a specific @wokwi/
// elements property; Hd44780Decoder itself has no idea "characters" is
// a DOM property, and protocol-chain.ts has no idea what an HD44780 is -
// adding a second protocol component later (a relay needing its own
// multi-pin driver, say) is one more entry here plus one more
// componentProtocols entry, nothing else in this file changes.
const PROTOCOL_ATTACHERS: Record<
  string,
  (pins: Record<string, CircuitPin>, el: HTMLElement) => ProtocolAttachment
> = {
  lcd1602: (pins, el) => {
    const decoder = new Hd44780Decoder(
      { rs: pins.rs, e: pins.e, d4: pins.d4, d5: pins.d5, d6: pins.d6, d7: pins.d7 },
      (characters) => {
        (el as unknown as { characters: Uint8Array }).characters = characters;
      },
    );
    return { dispose: () => decoder.dispose() };
  },
};

// The multi-pin counterpart to signal-chain.ts's SignalChain - glues
// protocol-net.ts's resolved ProtocolLinks to real adapter pin I/O.
// Structurally the same shape as SignalChain (recompute on wire-set
// changes, attach/dispose per link, board-agnostic via boardPinMaps/
// resolveBoardPinName/CircuitPin.forBoardPin - the exact same three
// pieces SignalChain already uses, so a future board type needs no
// change here either), just keyed by componentId instead of wireId,
// since one protocol link now spans several wires at once.
export class ProtocolChain {
  private readonly active = new Map<string, ProtocolAttachment>();

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
    const links = resolveProtocolLinks(this.scene.wiring.getWires(), (id) => this.findEntity(id));
    const liveComponentIds = new Set(links.map((link) => link.componentId));

    for (const [componentId, attachment] of this.active) {
      if (!liveComponentIds.has(componentId)) {
        attachment.dispose();
        this.active.delete(componentId);
      }
    }

    for (const link of links) {
      if (this.active.has(link.componentId)) continue;
      const attachment = this.attach(link);
      if (attachment) this.active.set(link.componentId, attachment);
    }
  }

  // Resolves one link down to live CircuitPins (one per role) and hands
  // them to whichever attacher matches its component type. Returns null
  // (a no-op, not a throw) for anything not yet supported - an unknown
  // board type or an unresolvable board pin - the same "optional
  // capability, don't throw" posture SignalChain.attach() already has.
  private attach(link: ProtocolLink): ProtocolAttachment | null {
    const board = this.scene.circuit.boards.find((b) => b.id === link.boardId);
    const boardPinMap = board && boardPinMaps[board.type];
    const dom = this.scene.getDom(link.componentId);
    const attacher = PROTOCOL_ATTACHERS[link.componentType];
    if (!board || !boardPinMap || !dom || !attacher) return null;

    try {
      const client = this.getAdapterClient(board.adapterId);
      const pins: Record<string, CircuitPin> = {};
      for (const [role, { boardPinName }] of Object.entries(link.pins)) {
        const pinName = resolveBoardPinName(board.type, boardPinName);
        pins[role] = CircuitPin.forBoardPin(client, boardPinMap, pinName);
      }
      return attacher(pins, dom.boardEl);
    } catch {
      return null;
    }
  }
}
