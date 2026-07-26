import { boardPinMaps, resolveBoardPinName, resolvePin } from "@physicalsim/common";
import type { ElementPin } from "@wokwi/elements";
import type { AdapterId, SimClient } from "./adapter-registry.js";
import type { CircuitBoard } from "./circuit.js";
import type { Scene } from "./canvas/scene.js";
import { buildNetlist, findNodeForPin, type Netlist, type NetlistEntityInfo } from "./canvas/netlist.js";
import { pinPowerInfo } from "./canvas/wire-validator.js";
import type { Wire } from "./canvas/wiring.js";
import { solveDc, solveTransientStep } from "./canvas/mna-solver.js";
import { boardPowerProfile } from "./energy.js";

// Drives both the reactive re-solve (a wire/pin changing) and the real
// physics clock a capacitor needs to charge/discharge visibly over actual
// elapsed time (see solve() below) - 10Hz is fast enough to animate an
// RC circuit with a human-visible (sub-few-second) time constant
// smoothly, without turning every wired pin's readPinDirection/readPin
// RPC calls (readPinStates()) into a tight per-frame polling loop. Also
// still catches a pin's *direction* changing (pinMode()/gpio_set_dir())
// mid-run, which onPinChange can't see (it only fires on a pin's
// electrical *value* changing, not its direction) - this single interval
// now covers what used to be two separate concerns (a slow safety-net
// re-scan and, previously, nothing at all for transient time).
const TICK_INTERVAL_MS = 100;

// A floor on the timestep handed to solveTransientStep() - guards against
// a capacitor's companion conductance (value/dt) blowing up if two ticks
// ever land back-to-back with ~0ms between them (e.g. a burst of
// scheduleRecompute() calls collapsing into one queued recompute right
// after the previous one finished).
const MIN_TRANSIENT_DT_SECONDS = 0.001;

interface WiredBoardPin {
  entityId: string;
  pin: string; // the board's own silkscreen/marker name, matching a Wire's own pin ref
  board: CircuitBoard;
  rawPin: string; // resolved through boardPinMaps - what the adapter itself understands
}

// Drives the analog netlist/solver (canvas/netlist.ts, canvas/mna-
// solver.ts) from the live canvas - M5+ of the analog signal-chain
// roadmap (ARCHITECTURE.md's "Signal chain" plan). Three things happen
// every recompute:
//
// 1. Read: a firmware-driven GPIO *output* pin becomes a real voltage
//    source in the netlist (see netlist.ts's getRuntimeVoltage?), and the
//    solved voltage at every wire's own node is pushed into WiringLayer
//    as a hover tooltip and a wire color (setWireVoltages()), and out to
//    any onVoltagesChanged() listener (main.ts's persistent readout).
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
// 3. LED display: any LED whose solved forward voltage actually resolves
//    (see updateLedDisplays()) gets its visual on/off state overridden
//    from that real voltage, not just whatever raw digital bit
//    SignalChain (signal-chain.ts) already wrote to it.
//
// Recomputes are triggered by wire-set changes (like every other chain
// here), reactively by onPinChange on any wired pin actually changing,
// and by TICK_INTERVAL_MS - not a tight per-frame polling loop, but no
// longer just a slow safety net either: solve() steps solveTransientStep()
// forward by real elapsed wall-clock time every tick, which is what
// actually makes a capacitor mid-circuit charge/discharge visibly instead
// of only ever showing solveDc()'s instantaneous steady state.
export class AnalogNetChain {
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  // Never overlap two solves - a burst of wire/pin-change events firing
  // in quick succession could otherwise start a second recompute before
  // the first finishes, racing to write stale results last (both to
  // WiringLayer and, now, back into a running adapter).
  private recomputing = false;
  private recomputeQueued = false;

  // The transient solver's own voltage history (mna-solver.ts's
  // solveTransientStep() keeps none itself - "the caller owns the
  // voltage history and timestep cadence", per its own doc comment) plus
  // the wall-clock time of the last solve, used to compute a real `dt`
  // between recomputes. null until the first solve ever runs - see
  // solve()'s own doc comment for how that first call bootstraps.
  private previousVoltages: ReadonlyMap<string, number | undefined> = new Map();
  private lastSolveAt: number | null = null;

  // One onPinChange unsubscribe per (entityId, pin) already subscribed -
  // subscribing is not idempotent client-side the way the underlying
  // "subscribePin" RPC call is (see worker-host.ts), so this avoids
  // piling up a second, third, ... listener for the same pin across
  // repeated recomputes.
  private readonly pinSubscriptions = new Map<string, () => void>();

  // Every solved wireVoltages map, pushed out after each recompute - lets
  // a UI (main.ts's persistent voltage readout) show real solved node
  // voltages without reaching into this class's own private solve state.
  private readonly voltageListeners = new Set<(wireVoltages: ReadonlyMap<string, number>) => void>();

  constructor(
    private readonly scene: Scene,
    private readonly getAdapterClient: (id: AdapterId) => SimClient,
  ) {
    scene.wiring.onWiresChanged(() => this.scheduleRecompute());
    this.tickTimer = setInterval(() => this.scheduleRecompute(), TICK_INTERVAL_MS);
  }

  dispose(): void {
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    this.tickTimer = null;
    for (const unsubscribe of this.pinSubscriptions.values()) unsubscribe();
    this.pinSubscriptions.clear();
  }

  // Pushes every solve's wireVoltages to `listener` going forward.
  // Returns an unsubscribe function, the same shape every other
  // subscription in this codebase (onPinChange, onWiresChanged, ...) uses.
  onVoltagesChanged(listener: (wireVoltages: ReadonlyMap<string, number>) => void): () => void {
    this.voltageListeners.add(listener);
    return () => this.voltageListeners.delete(listener);
  }

  // One step of the real transient clock (M4+ of the analog signal-chain
  // roadmap, now actually wired into the running app instead of only unit-
  // tested): the very first solve ever has no voltage history to step
  // forward from, so it bootstraps from solveDc()'s resistive steady
  // state (capacitors as open circuits) - a freshly-wired circuit's first
  // recompute should already reflect its resistor network, not a
  // "everything starts at 0V" one-tick-later correction. Every solve after
  // that steps solveTransientStep() forward by the real wall-clock time
  // since the last one, so a capacitor mid-circuit actually charges/
  // discharges over real elapsed time instead of snapping straight to a
  // DC steady state.
  private solve(netlist: Netlist): { nodeVoltages: Map<string, number | undefined> } {
    const now = performance.now();
    if (this.lastSolveAt === null) {
      this.lastSolveAt = now;
      const solution = solveDc(netlist);
      this.previousVoltages = solution.nodeVoltages;
      return solution;
    }
    const dt = Math.max((now - this.lastSolveAt) / 1000, MIN_TRANSIENT_DT_SECONDS);
    this.lastSolveAt = now;
    const solution = solveTransientStep(netlist, dt, this.previousVoltages);
    this.previousVoltages = solution.nodeVoltages;
    return solution;
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
      const { nodeVoltages } = this.solve(netlist);
      this.updateLedDisplays(netlist, nodeVoltages);

      const wireVoltages = new Map<string, number>();
      for (const wire of wires) {
        // A wire's two endpoints are always the same node, by
        // definition - either one resolves to it.
        const node = findNodeForPin(netlist, wire.a.entityId, wire.a.pin);
        const voltage = node ? nodeVoltages.get(node.id) : undefined;
        if (voltage !== undefined) wireVoltages.set(wire.id, voltage);
      }
      this.scene.wiring.setWireVoltages(wireVoltages);
      for (const listener of this.voltageListeners) listener(wireVoltages);

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

  // Overrides an LED's visual on/off state with a real forward-voltage
  // judgment wherever the netlist actually resolves a voltage across it
  // (both terminals reach a ground reference somewhere in their connected
  // subgraph - see mna-solver.ts's own doc comment on why an unresolved
  // node reports undefined rather than a guess). Most of main.ts's
  // EXAMPLES entries wire an LED's anode straight to a GPIO pin and leave
  // its cathode floating (never resolved here), so those are left alone -
  // SignalChain's own raw-digital-bit `.value` write (signal-chain.ts)
  // still drives them, same as before. Only a fully-wired circuit (e.g.
  // "rp2040-blink"'s LED + current-limiting resistor to GND) gets the
  // real thing: an LED whose solved forward voltage never actually clears
  // its threshold (say, a GPIO pin driving it through a resistor too
  // large to reach 2V) now correctly stays dark, which a raw digital-bit
  // read could never express.
  private updateLedDisplays(netlist: Netlist, nodeVoltages: ReadonlyMap<string, number | undefined>): void {
    for (const element of netlist.elements) {
      if (element.kind !== "led") continue;
      const vA = nodeVoltages.get(element.nodeA);
      const vB = nodeVoltages.get(element.nodeB);
      if (vA === undefined || vB === undefined) continue;
      const dom = this.scene.getDom(element.componentId);
      if (!dom) continue;
      const isOn = vA - vB >= element.value; // element.value is the LED's forward-voltage threshold (netlist.ts)
      (dom.boardEl as unknown as { value: boolean }).value = isOn;
    }
  }
}
