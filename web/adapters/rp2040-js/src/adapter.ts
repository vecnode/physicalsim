import { compileSketch, createSketchGlobals, PicoRuntime, type CompiledSketch } from "rp2040js/pico";
import type { SimState, SimulatorAdapter } from "@physicalsim/common";

// A JS/TS-native RP2040 adapter: instead of compiling a real pico-sdk C
// sketch with arm-none-eabi-gcc and running the resulting ARM Cortex-M0+
// machine code through rp2040js's cycle-accurate CPU emulation (see
// ../rp2040/src/adapter.ts), this interprets a JS/TS-authored sketch
// directly via rp2040js's PicoRuntime - no C/C++ toolchain, no pico-sdk
// vendoring involved at all. Same shape as adapters/avr8-js's
// Avr8JsAdapter for the AVR side - see that file for the fuller design
// rationale (a separate adapter, not a mode flag, because the execution
// model is different enough).
//
// Pin ids are "GP<n>" (rp2040js/pico's PicoRuntime numbers pins 0-29
// directly) - see boards/rp2040-board.ts's identity BoardPinMap and
// boards/nano-rp2040-connect.ts's own D<n>/A<n> -> GP<n> map, both
// already written in this scheme (shared with the real rp2040 adapter).
export class Rp2040JsAdapter implements SimulatorAdapter {
  readonly id = "rp2040-js";

  private runtime = new PicoRuntime();
  private sketch: CompiledSketch | null = null;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private setupRan = false;
  private lastSource: string | undefined;

  private listeners = new Set<(state: SimState) => void>();
  private pinListeners = new Map<string, Set<(value: number) => void>>();

  async init(_config: unknown): Promise<void> {
    this.wireRuntimeListeners();
  }

  start(): void {
    if (this.running || !this.sketch) return;
    this.running = true;
    this.runSetupOnce(this.sketch);
    this.scheduleLoop();
    this.emitState();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.emitState();
  }

  step(n: number): void {
    if (!this.sketch) return;
    this.runSetupOnce(this.sketch);
    for (let i = 0; i < n; i++) {
      this.sketch.loop();
    }
    this.emitState();
  }

  private runSetupOnce(sketch: CompiledSketch): void {
    if (this.setupRan) return;
    this.setupRan = true;
    try {
      sketch.setup();
    } catch (err) {
      this.running = false;
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  reset(): void {
    this.stop();
    this.runtime = new PicoRuntime();
    this.wireRuntimeListeners();
    this.setupRan = false;
    if (this.sketch) {
      this.sketch = compileSketch(this.lastSource ?? "", createSketchGlobals(this.runtime));
    }
    this.emitState();
  }

  onStateChange(cb: (state: SimState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  readPin(pin: string): number {
    return this.runtime.readPin(parsePinName(pin));
  }

  readPinDirection(pin: string): "input" | "output" {
    return this.runtime.readPinDirection(parsePinName(pin));
  }

  writePin(pin: string, value: number): void {
    this.runtime.setDigitalInput(parsePinName(pin), value ? 1 : 0);
  }

  onPinChange(pin: string, cb: (value: number) => void): () => void {
    let listeners = this.pinListeners.get(pin);
    if (!listeners) {
      listeners = new Set();
      this.pinListeners.set(pin, listeners);
    }
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  // RP2040 has no dedicated ADC-only pins the way the Uno does (GP26-29
  // are ADC-capable, the rest aren't) - same "reject a non-ADC pin,
  // caught not thrown" posture SimulatorAdapter's own doc comment
  // requires of every adapter, matching the real rp2040 adapter's own
  // ADC-channel gating.
  writeAnalogPin(_pin: string, _voltage: number): void {
    throw new Error("rp2040-js: analog input is not modeled yet");
  }

  // The sketch source's own JS/TS text, UTF-8 encoded - see
  // Avr8JsAdapter.loadFirmware()'s identical doc comment for why "bytes"
  // is a valid, adapter-specific interpretation here.
  loadFirmware(bytes: Uint8Array): void {
    const source = new TextDecoder().decode(bytes);
    this.lastSource = source;
    this.runtime = new PicoRuntime();
    this.wireRuntimeListeners();
    this.sketch = compileSketch(source, createSketchGlobals(this.runtime));
    this.running = false;
    this.setupRan = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.emitState();
  }

  private wireRuntimeListeners(): void {
    for (let pin = 0; pin < 30; pin++) {
      const name = `GP${pin}`;
      this.runtime.onPinChange(pin, (value) => {
        for (const cb of this.pinListeners.get(name) ?? []) cb(value);
      });
    }
  }

  // Same "one loop() iteration per scheduled tick, re-check running
  // before the next" shape as Avr8JsAdapter.scheduleLoop() - see its own
  // doc comment for the full reasoning (a Worker is single-threaded, so
  // stop() can only be honored between iterations, not mid-sleep_ms()).
  private scheduleLoop(): void {
    this.timer = setTimeout(() => {
      if (!this.running || !this.sketch) return;
      try {
        this.sketch.loop();
      } catch (err) {
        this.running = false;
        this.emitState();
        throw err instanceof Error ? err : new Error(String(err));
      }
      this.emitState();
      this.scheduleLoop();
    }, 0);
  }

  private emitState(): void {
    const state: SimState = {
      running: this.running,
      cycles: 0,
      millis: this.runtime.toMs(),
    };
    for (const listener of this.listeners) listener(state);
  }
}

// "GP<n>" -> n. Lives here, not in rp2040js, the same way avr8-js's own
// parsePinName() lives in its adapter, not avr8js.
function parsePinName(pin: string): number {
  const match = /^GP(\d+)$/.exec(pin);
  if (!match) {
    throw new Error(`Invalid pin id "${pin}"`);
  }
  return Number(match[1]);
}
