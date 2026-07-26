import { boardPinMaps, resolveBoardPinName, resolvePin } from "@physicalsim/common";
import type { ElementPin } from "@wokwi/elements";
import type { AdapterId, SimClient } from "./adapter-registry.js";
import type { Scene } from "./canvas/scene.js";
import { buildNetlist, findNodeForPin, type NetlistEntityInfo } from "./canvas/netlist.js";
import { pinPowerInfo } from "./canvas/wire-validator.js";
import type { Wire } from "./canvas/wiring.js";
import { solveDc } from "./canvas/mna-solver.js";
import { boardPowerProfile } from "./energy.js";

// How often to re-poll running adapters for GPIO pin state - a
// firmware-driven pin's level can change continuously while a board is
// running, not just when a wire is added/removed (unlike SignalChain/
// WireValidation, which only ever need to recompute on wire-set
// changes). Loose enough not to flood the Worker postMessage channel
// with RPC traffic for every placed pin, tight enough that a solved
// voltage still reads as "live," not stale.
const POLL_INTERVAL_MS = 150;

// Drives the analog netlist/solver (canvas/netlist.ts, canvas/mna-
// solver.ts) from the live canvas - M5 of the analog signal-chain
// roadmap (ARCHITECTURE.md's "Signal chain" plan). Recomputes on every
// wire-set change and on a fixed timer, pushing solved per-wire voltages
// into WiringLayer as a hover tooltip (see wiring.ts's setWireVoltages()).
//
// Deliberately DC steady-state only (solveDc()), not the M4 transient
// (backward-Euler) solve, even though solveTransientStep() already
// exists and is fully tested: wiring a genuinely time-stepped solve into
// a real polling loop - choosing a timestep, persisting voltage history
// across ticks whose own wall-clock spacing isn't perfectly regular -
// is a further, separate piece of integration work, not done here. A
// documented next step, not a silent gap: a resistor network's voltage
// still updates correctly and immediately as GPIO pins change; a
// capacitor's charge/discharge curve over time does not yet animate in
// the running app.
export class AnalogNetChain {
  private timer: ReturnType<typeof setInterval> | null = null;
  // Never overlap two solves - a slow RPC round-trip (or a burst of wire
  // changes right as the timer also fires) could otherwise start a
  // second recompute before the first finishes, racing to call
  // setWireVoltages() with stale results last.
  private recomputing = false;

  constructor(
    private readonly scene: Scene,
    private readonly getAdapterClient: (id: AdapterId) => SimClient,
  ) {
    scene.wiring.onWiresChanged(() => void this.recompute());
    this.timer = setInterval(() => void this.recompute(), POLL_INTERVAL_MS);
  }

  dispose(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private buildEntities(): Map<string, NetlistEntityInfo> {
    const map = new Map<string, NetlistEntityInfo>();
    for (const b of this.scene.circuit.boards) map.set(b.id, { kind: "board", type: b.type });
    for (const c of this.scene.circuit.components) map.set(c.id, { kind: "component", type: c.type, attrs: c.attrs });
    return map;
  }

  private getPinPower(entityId: string, pin: string) {
    const dom = this.scene.getDom(entityId);
    const pinInfo = (dom?.boardEl as unknown as { pinInfo?: ElementPin[] } | undefined)?.pinInfo;
    return pinPowerInfo(pinInfo, pin);
  }

  // Queries every board pin actually wired into the circuit for its
  // current direction/level - the one genuinely async part of this file
  // (real adapter RPC, not local data). Built once up front into a plain
  // map rather than queried lazily from inside buildNetlist() itself,
  // which has to stay synchronous - see netlist.ts's own
  // getRuntimeVoltage? doc comment for why.
  private async resolveGpioVoltages(wires: readonly Wire[]): Promise<Map<string, Map<string, number>>> {
    const result = new Map<string, Map<string, number>>();

    interface PinRef {
      entityId: string;
      pin: string;
    }
    const pinsToQuery = new Map<string, PinRef>();
    for (const wire of wires) {
      for (const ref of [wire.a, wire.b]) {
        pinsToQuery.set(`${ref.entityId}::${ref.pin}`, ref);
      }
    }

    await Promise.all(
      [...pinsToQuery.values()].map(async ({ entityId, pin }) => {
        const board = this.scene.circuit.boards.find((b) => b.id === entityId);
        if (!board) return; // a component's pin, not a board's - not this function's concern

        let rawPin: string;
        try {
          const boardPinName = resolveBoardPinName(board.type, pin);
          rawPin = resolvePin(boardPinMaps[board.type] ?? {}, boardPinName);
        } catch {
          return; // not a mapped GPIO name (e.g. a power/GND silkscreen marker) - pinPowerInfo already covers those
        }

        const client = this.getAdapterClient(board.adapterId);
        let direction: unknown;
        try {
          direction = await client.call("readPinDirection", { pin: rawPin });
        } catch {
          return; // this adapter kind doesn't support it (e.g. cortex-m/esp32 - no real pin I/O there yet)
        }
        if (direction !== "output") return; // an input pin drives nothing - leave it to other elements/sources

        let level: unknown;
        try {
          level = await client.call("readPin", { pin: rawPin });
        } catch {
          return;
        }
        if (typeof level !== "number") return;

        const profile = boardPowerProfile[board.type];
        const voltage = level ? (profile?.supplyVoltage ?? 5) : 0;
        let byPin = result.get(entityId);
        if (!byPin) {
          byPin = new Map();
          result.set(entityId, byPin);
        }
        byPin.set(pin, voltage);
      }),
    );

    return result;
  }

  private async recompute(): Promise<void> {
    if (this.recomputing) return;
    this.recomputing = true;
    try {
      const wires = this.scene.wiring.getWires();
      const entities = this.buildEntities();
      const gpioVoltages = await this.resolveGpioVoltages(wires);

      const netlist = buildNetlist(
        wires,
        entities,
        (entityId, pin) => this.getPinPower(entityId, pin),
        (entityId, pin) => gpioVoltages.get(entityId)?.get(pin),
      );
      const { nodeVoltages } = solveDc(netlist);

      const wireVoltages = new Map<string, number>();
      for (const wire of wires) {
        // A wire's two endpoints are always the same node, by
        // definition - either one resolves to it.
        const node = findNodeForPin(netlist, wire.a.entityId, wire.a.pin);
        const voltage = node ? nodeVoltages.get(node.id) : undefined;
        if (voltage !== undefined) wireVoltages.set(wire.id, voltage);
      }
      this.scene.wiring.setWireVoltages(wireVoltages);
    } finally {
      this.recomputing = false;
    }
  }
}
