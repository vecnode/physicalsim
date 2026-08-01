import { compileSketch, createSketchGlobals, EspIdfRuntime, type CompiledSketch } from "esp32js/espidf";
import type { SimState, SimulatorAdapter } from "@physicalsim/common";

// A JS/TS-native ESP32 adapter: instead of compiling a real ESP-IDF C
// sketch with xtensa-esp-elf-gcc and running the resulting Xtensa
// machine code through esp32js's cycle-accurate CPU emulation (see
// ../esp32/src/adapter.ts), this interprets a JS/TS-authored sketch
// directly via esp32js's EspIdfRuntime - no C/C++ toolchain, no
// esp-idf vendoring involved at all. Same shape as adapters/avr8-js's
// Avr8JsAdapter and adapters/rp2040-js's Rp2040JsAdapter - see either
// for the fuller design rationale.
//
// Pin ids accept either "D<n>" (esp32-devkit-v1's own board map
// convention, matching the real esp32 adapter's pinIndex()) or a bare
// "<n>" (esp32-devkit-c-v4.ts's/esp32-cam.ts's own board maps, which
// use the boards' real bare-GPIO-number silkscreens directly) - both
// resolve to the same GPIO index, so this one adapter class backs all
// three ESP32 boards without needing per-board pin-id translation.
export class Esp32JsAdapter implements SimulatorAdapter {
  readonly id = "esp32-js";

  private runtime = new EspIdfRuntime();
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
    this.runtime = new EspIdfRuntime();
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
    return this.runtime.readPin(parsePinIndex(pin));
  }

  readPinDirection(pin: string): "input" | "output" {
    return this.runtime.readPinDirection(parsePinIndex(pin));
  }

  writePin(pin: string, value: number): void {
    this.runtime.setDigitalInput(parsePinIndex(pin), value ? 1 : 0);
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

  // No ADC modeled yet for this JS-native runtime (a real, documented
  // gap, matching every other JS-native adapter's own "caught, not
  // thrown" posture for a capability it doesn't have yet).
  writeAnalogPin(pin: string, _voltage: number): void {
    throw new Error(`Pin "${pin}" is not an ADC-capable pin`);
  }

  loadFirmware(bytes: Uint8Array): void {
    const source = new TextDecoder().decode(bytes);
    this.lastSource = source;
    this.runtime = new EspIdfRuntime();
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
    for (let pin = 0; pin < 40; pin++) {
      const name = `D${pin}`;
      this.runtime.onPinChange(pin, (value) => {
        for (const cb of this.pinListeners.get(name) ?? []) cb(value);
        // Also notify subscribers using the bare-digit id (esp32-cam.ts/
        // esp32-devkit-c-v4.ts's own board map convention - see
        // parsePinIndex()'s doc comment).
        for (const cb of this.pinListeners.get(String(pin)) ?? []) cb(value);
      });
    }
  }

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
      millis: this.runtime.millis(),
    };
    for (const listener of this.listeners) listener(state);
  }
}

// "D<n>" or bare "<n>" -> n - see this class's own header comment for
// why both conventions are accepted.
function parsePinIndex(pin: string): number {
  const match = /^D?(\d+)$/i.exec(pin);
  if (!match) {
    throw new Error(`Invalid pin id "${pin}"`);
  }
  const index = Number(match[1]);
  if (index < 0 || index > 39) {
    throw new Error(`Invalid pin id "${pin}"`);
  }
  return index;
}
