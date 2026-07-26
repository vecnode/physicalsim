import { boardPinMaps, resolveBoardPinName, resolvePin } from "@physicalsim/common";
import type { ElementPin } from "@wokwi/elements";
import type { AdapterId, SimClient } from "./adapter-registry.js";
import type { CircuitBoard } from "./circuit.js";
import type { Scene } from "./canvas/scene.js";
import { buildNetlist, findNodeForPin, type NetlistEntityInfo } from "./canvas/netlist.js";
import { pinPowerInfo } from "./canvas/wire-validator.js";
import type { Wire } from "./canvas/wiring.js";
import { solveDc } from "./canvas/mna-solver.js";
import { boardPowerProfile } from "./energy.js";

// A slow safety-net re-scan, not the primary trigger - see the class doc
// comment below for why onPinChange (reactive, near-instant) does almost
// all of the real work now. This only exists to catch a pin's *direction*
// changing (pinMode()/gpio_set_dir()) mid-run, which onPinChange can't
// see (it only fires on a pin's electrical *value* changing, not its
// direction), and to give a freshly-wired board its first solve before
// anything has changed yet.
const SAFETY_NET_INTERVAL_MS = 2000;

interface WiredBoardPin {
  entityId: string;
  pin: string; // the board's own silkscreen/marker name, matching a Wire's own pin ref
  board: CircuitBoard;
  rawPin: string; // resolved through boardPinMaps - what the adapter itself understands
}

// Drives the analog netlist/solver (canvas/netlist.ts, canvas/mna-
// solver.ts) from the live canvas - M5+ of the analog signal-chain
// roadmap (ARCHITECTURE.md's "Signal chain" plan). Two things happen
// every recompute:
//
// 1. Read: a firmware-driven GPIO *output* pin becomes a real voltage
//    source in the netlist (see netlist.ts's getRuntimeVoltage?), and the
//    solved voltage at every wire's own node is pushed into WiringLayer
//    as a hover tooltip (setWireVoltages()).
// 2. Write: closes the loop the other way - a GPIO pin currently
//    configured as an *input* and wired to a node with a solved voltage
//    gets that voltage written back into the adapter, both as a digital
//    level (writePin(), thresholded at half the receiving board's own
//    supply voltage - matching a real input buffer's Vih/Vil, not the
//    voltage's board of origin) and, where the pin is ADC-capable, as a
//    real analog voltage (writeAnalogPin()) - whichever one the sketch
//    actually reads (digitalRead() vs analogRead()) sees a real answer,
//    since this file has no way to know which the firmware intends and
//    writing both is harmless (writeAnalogPin() itself already rejects a
//    non-ADC pin - caught, not thrown further). Without this, a resistor
//    divider or another board's output pin wired into an input pin would
//    have a solved voltage that nothing ever reads back - a one-way
//    readout, not an actual signal chain.
//
// Recomputes are triggered by wire-set changes (like every other chain
// here) and, reactively, by onPinChange on any wired pin actually
// changing - not a tight polling loop. A pin's *value* changing is
// exactly what onPinChange already reports (no extra RPC round-trip
// needed to learn it), so this is strictly more responsive *and* far
// less RPC traffic than polling every pin on a fixed short interval; a
// slow SAFETY_NET_INTERVAL_MS re-scan alone catches the one thing
// onPinChange can't see (a pin's direction changing).
export class AnalogNetChain {
  private safetyNetTimer: ReturnType<typeof setInterval> | null = null;
  // Never overlap two solves - a burst of wire/pin-change events firing
  // in quick succession could otherwise start a second recompute before
  // the first finishes, racing to write stale results last (both to
  // WiringLayer and, now, back into a running adapter).
  private recomputing = false;
  private recomputeQueued = false;

  // One onPinChange unsubscribe per (entityId, pin) already subscribed -
  // subscribing is not idempotent client-side the way the underlying
  // "subscribePin" RPC call is (see worker-host.ts), so this avoids
  // piling up a second, third, ... listener for the same pin across
  // repeated recomputes.
  private readonly pinSubscriptions = new Map<string, () => void>();

  constructor(
    private readonly scene: Scene,
    private readonly getAdapterClient: (id: AdapterId) => SimClient,
  ) {
    scene.wiring.onWiresChanged(() => this.scheduleRecompute());
    this.safetyNetTimer = setInterval(() => this.scheduleRecompute(), SAFETY_NET_INTERVAL_MS);
  }

  dispose(): void {
    if (this.safetyNetTimer !== null) clearInterval(this.safetyNetTimer);
    this.safetyNetTimer = null;
    for (const unsubscribe of this.pinSubscriptions.values()) unsubscribe();
    this.pinSubscriptions.clear();
  }

  private scheduleRecompute(): void {
    if (this.recomputing) {
      this.recomputeQueued = true;
      return;
    }
    void this.recompute();
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

  // Every board pin actually wired into the circuit right now, with its
  // adapter-level raw pin id already resolved - the common groundwork
  // both the source-voltage read and the input-pin write-back below need.
  private wiredBoardPins(wires: readonly Wire[]): WiredBoardPin[] {
    const seen = new Map<string, WiredBoardPin>();
    for (const wire of wires) {
      for (const ref of [wire.a, wire.b]) {
        const key = `${ref.entityId}::${ref.pin}`;
        if (seen.has(key)) continue;
        const board = this.scene.circuit.boards.find((b) => b.id === ref.entityId);
        if (!board) continue; // a component's pin, not a board's
        try {
          const boardPinName = resolveBoardPinName(board.type, ref.pin);
          const rawPin = resolvePin(boardPinMaps[board.type] ?? {}, boardPinName);
          seen.set(key, { entityId: ref.entityId, pin: ref.pin, board, rawPin });
        } catch {
          // Not a mapped GPIO name (e.g. a power/GND silkscreen marker) -
          // pinPowerInfo already covers those; nothing for this function
          // to resolve.
        }
      }
    }
    return [...seen.values()];
  }

  // Ensures every currently-wired board pin has a live onPinChange
  // subscription (idempotent - see pinSubscriptions' own doc comment),
  // and drops subscriptions for pins that are no longer wired to
  // anything, so this doesn't leak a growing set of stale listeners as
  // wires get added/removed over a session.
  private syncPinSubscriptions(wiredPins: readonly WiredBoardPin[]): void {
    const liveKeys = new Set(wiredPins.map((p) => `${p.entityId}::${p.pin}`));
    for (const [key, unsubscribe] of this.pinSubscriptions) {
      if (!liveKeys.has(key)) {
        unsubscribe();
        this.pinSubscriptions.delete(key);
      }
    }
    for (const wired of wiredPins) {
      const key = `${wired.entityId}::${wired.pin}`;
      if (this.pinSubscriptions.has(key)) continue;
      const client = this.getAdapterClient(wired.board.adapterId);
      if (!client.onPinChange) continue; // this adapter kind doesn't push pin changes at all
      const unsubscribe = client.onPinChange((changedPin) => {
        if (changedPin === wired.rawPin) this.scheduleRecompute();
      });
      void client.call("subscribePin", { pin: wired.rawPin }).catch(() => {});
      this.pinSubscriptions.set(key, unsubscribe);
    }
  }

  // Reads every wired pin's current direction/level - the one genuinely
  // async step (real adapter RPC, not local data), run once per
  // recompute rather than once per wire (already deduplicated by
  // wiredBoardPins() above).
  private async readPinStates(
    wiredPins: readonly WiredBoardPin[],
  ): Promise<Map<string, { direction: unknown; level: unknown }>> {
    const result = new Map<string, { direction: unknown; level: unknown }>();
    await Promise.all(
      wiredPins.map(async (wired) => {
        const client = this.getAdapterClient(wired.board.adapterId);
        const key = `${wired.entityId}::${wired.pin}`;
        try {
          const direction = await client.call("readPinDirection", { pin: wired.rawPin });
          const level = await client.call("readPin", { pin: wired.rawPin });
          result.set(key, { direction, level });
        } catch {
          // This adapter kind doesn't support one or both (e.g. cortex-m/
          // esp32 - no real pin I/O there yet) - leave it unresolved
          // rather than throwing the whole recompute away.
        }
      }),
    );
    return result;
  }

  private async recompute(): Promise<void> {
    this.recomputing = true;
    try {
      const wires = this.scene.wiring.getWires();
      const entities = this.buildEntities();
      const wiredPins = this.wiredBoardPins(wires);
      this.syncPinSubscriptions(wiredPins);
      const pinStates = await this.readPinStates(wiredPins);

      // Only a pin currently configured as an output is a real voltage
      // source (see this file's own doc comment) - an input pin's
      // "level" here is whatever it last read, not something it drives.
      const sourceVoltages = new Map<string, Map<string, number>>();
      for (const wired of wiredPins) {
        const state = pinStates.get(`${wired.entityId}::${wired.pin}`);
        if (!state || state.direction !== "output" || typeof state.level !== "number") continue;
        const profile = boardPowerProfile[wired.board.type];
        const voltage = state.level ? (profile?.supplyVoltage ?? 5) : 0;
        let byPin = sourceVoltages.get(wired.entityId);
        if (!byPin) {
          byPin = new Map();
          sourceVoltages.set(wired.entityId, byPin);
        }
        byPin.set(wired.pin, voltage);
      }

      const netlist = buildNetlist(
        wires,
        entities,
        (entityId, pin) => this.getPinPower(entityId, pin),
        (entityId, pin) => sourceVoltages.get(entityId)?.get(pin),
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

      // Write the solved voltage back into every *input*-configured wired
      // pin - the other half of closing the loop (see this file's own
      // doc comment). An output pin is never written back here (it's the
      // source, not a receiver); a pin whose node never resolved (no
      // ground reachable at all) is left untouched rather than injecting
      // a meaningless value.
      for (const wired of wiredPins) {
        const state = pinStates.get(`${wired.entityId}::${wired.pin}`);
        if (!state || state.direction !== "input") continue;
        const node = findNodeForPin(netlist, wired.entityId, wired.pin);
        const voltage = node ? nodeVoltages.get(node.id) : undefined;
        if (voltage === undefined) continue;

        const client = this.getAdapterClient(wired.board.adapterId);
        const profile = boardPowerProfile[wired.board.type];
        const supply = profile?.supplyVoltage ?? 5;
        const digitalLevel = voltage > supply / 2 ? 1 : 0;
        void client.call("writePin", { pin: wired.rawPin, value: digitalLevel }).catch(() => {});
        // writeAnalogPin() already rejects a non-ADC-capable pin on its
        // own (Avr8Adapter/Rp2040Adapter both validate this) - caught,
        // not propagated, since most wired pins aren't ADC-capable and
        // that's an entirely expected, not exceptional, outcome here.
        void client.call("writeAnalogPin", { pin: wired.rawPin, voltage }).catch(() => {});
      }
    } finally {
      this.recomputing = false;
      if (this.recomputeQueued) {
        this.recomputeQueued = false;
        void this.recompute();
      }
    }
  }
}
