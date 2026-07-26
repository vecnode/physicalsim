import type { ElementPin } from "@wokwi/elements";
import type { Scene } from "./canvas/scene.js";
import { pinPowerInfo, validateWires } from "./canvas/wire-validator.js";

// Glues canvas/wire-validator.ts's pure validateWires() to the actual
// placed elements' pinInfo, and pushes the result into WiringLayer for
// rendering - the same "resolve wires into something typed, driven by
// onWiresChanged()" shape SignalChain/AnalogChain/ProtocolChain already
// use, just simpler: there's no adapter I/O to attach/detach here, only a
// recompute-and-render on every wire-set change.
export class WireValidation {
  constructor(private readonly scene: Scene) {
    scene.wiring.onWiresChanged(() => this.recompute());
  }

  private getPinPower(entityId: string, pin: string) {
    const dom = this.scene.getDom(entityId);
    const pinInfo = (dom?.boardEl as unknown as { pinInfo?: ElementPin[] } | undefined)?.pinInfo;
    return pinPowerInfo(pinInfo, pin);
  }

  private recompute(): void {
    const issues = validateWires(this.scene.wiring.getWires(), (entityId, pin) => this.getPinPower(entityId, pin));
    this.scene.wiring.setWireIssues(issues);
  }
}
