import {
  Button,
  CircuitPin,
  boardPinMaps,
  componentSignalPins,
  resolveBoardPinName,
} from "@physicalsim/common";
import type { AdapterId, SimClient } from "./adapter-registry.js";
import type { Scene } from "./canvas/scene.js";
import { resolveSignalLinks, type EntityLookup, type SignalLink } from "./canvas/signal-net.js";

interface Attachment {
  dispose: () => void;
}

// Glues canvas/signal-net.ts's resolved SignalLinks to real adapter pin
// I/O - the signal-chain equivalent of energy.ts's role gluing model +
// adapter + DOM together, minus energy.ts's own concerns (this file knows
// nothing about voltage/current). Board-agnostic: everything it reads
// (boardPinMaps, componentSignalPins, the board's own adapterId) is a
// per-type lookup table, so a second board type needs no change here -
// only a new boardPinMaps entry (see board-registry.ts).
//
// Recomputes on every wire-set change (not polled, not on every render())
// - see WiringLayer.onWiresChanged().
export class SignalChain {
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
    const links = resolveSignalLinks(this.scene.wiring.getWires(), (id) => this.findEntity(id));
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

  // Resolves one link down to a live CircuitPin and hooks it up in
  // whichever direction its component's role calls for. Returns null (a
  // no-op, not a throw) for anything not yet supported - an unknown board
  // type, an unresolvable board pin name, or a component with no signal
  // role - the same "optional capability, log don't throw" posture
  // SimulatorAdapter's own readPin?/writePin? already establish.
  private attach(link: SignalLink): Attachment | null {
    const board = this.scene.circuit.boards.find((b) => b.id === link.boardId);
    const boardPinMap = board && boardPinMaps[board.type];
    const spec = componentSignalPins[link.componentType];
    const dom = this.scene.getDom(link.componentId);
    if (!board || !boardPinMap || !spec || !dom) return null;

    let pin: CircuitPin;
    try {
      const pinName = resolveBoardPinName(board.type, link.boardPinName);
      pin = CircuitPin.forBoardPin(this.getAdapterClient(board.adapterId), boardPinMap, pinName);
    } catch {
      return null;
    }

    if (spec.role === "write") {
      const button = new Button(pin);
      const onPress = () => void button.press();
      const onRelease = () => void button.release();
      dom.boardEl.addEventListener("button-press", onPress);
      dom.boardEl.addEventListener("button-release", onRelease);
      return {
        dispose: () => {
          dom.boardEl.removeEventListener("button-press", onPress);
          dom.boardEl.removeEventListener("button-release", onRelease);
        },
      };
    }

    // role === "read": drive the placed element's own `value` property
    // (e.g. wokwi-led's) from the pin - Led (web/common) models the same
    // "reflect, don't drive" relationship but has no external change hook
    // to redraw a DOM property from, so this talks to CircuitPin directly
    // rather than wrapping it.
    const apply = (value: number) => {
      (dom.boardEl as unknown as { value: boolean }).value = !!value;
    };
    void pin.read().then(apply);
    const unsubscribe = pin.onChange(apply);
    return { dispose: unsubscribe };
  }
}
