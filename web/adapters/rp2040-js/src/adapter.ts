import { compileSketch, createSketchGlobals, PicoRuntime, i2c0, type CompiledSketch } from "rp2040js/pico";
import { MPU6050Device, SSD1306Device, type SimState, type SimulatorAdapter } from "@physicalsim/common";
import { I2CBus } from "./i2c-bus.js";

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
  private serialListeners = new Set<(byte: number) => void>();
  private i2cFrameListeners = new Set<(device: string, data: Uint8Array) => void>();

  // Two devices behind i2c0 (see wireRuntimeListeners() below) - the same
  // adapter-agnostic I2CSubDevice classes web/adapters/avr8/src/adapter.ts
  // already reuses. Built once, not per-reset/per-loadFirmware: neither
  // device has any state that needs to survive a sketch reload any
  // differently than the runtime pins themselves do, and re-wiring only
  // the SSD1306Device's frame callback (see wireRuntimeListeners()) would
  // otherwise leave stale closures accumulating.
  private readonly i2cBus = new I2CBus([
    new MPU6050Device(),
    new SSD1306Device((data) => {
      for (const cb of this.i2cFrameListeners) cb("ssd1306", data);
    }),
  ]);

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

  // GP26-29 are the RP2040's real ADC-capable pins (see PicoRuntime's own
  // ADC_BASE_PIN doc comment) - every other pin rejects, same "reject a
  // non-ADC pin, caught not thrown" posture SimulatorAdapter's own doc
  // comment requires of every adapter, matching Avr8JsAdapter's identical
  // digitalPinCount-based gate.
  writeAnalogPin(pin: string, voltage: number): void {
    const numericPin = parsePinName(pin);
    if (numericPin < ADC_BASE_PIN || numericPin >= ADC_BASE_PIN + ADC_CHANNEL_COUNT) {
      throw new Error(`Pin "${pin}" is not an ADC-capable pin`);
    }
    // 0-3.3V, matching the RP2040's real ADC reference range (its logic
    // level, see energy.ts's "pi-pico"/"nano-rp2040-connect" supplyVoltage).
    const clampedVoltage = Math.min(3.3, Math.max(0, voltage));
    this.runtime.setAnalogInput(numericPin, Math.round((clampedVoltage / 3.3) * ADC_MAX));
  }

  onSerialData(cb: (byte: number) => void): () => void {
    this.serialListeners.add(cb);
    return () => this.serialListeners.delete(cb);
  }

  onI2CFrame(cb: (device: string, data: Uint8Array) => void): () => void {
    this.i2cFrameListeners.add(cb);
    return () => this.i2cFrameListeners.delete(cb);
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
    this.runtime.onSerialWrite((byte) => {
      for (const cb of this.serialListeners) cb(byte);
    });
    // i2c0 only - GP4/GP5, real hardware's own default I2C pins and the
    // pin pair every example sketch here actually uses; a sketch calling
    // i2c_write_blocking(i2c1, ...) instead gets PicoRuntime's own
    // "no controller installed" fallback (-1/empty), same as an
    // unaddressed device would.
    this.runtime.setI2CController(i2c0, this.i2cBus);
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

// GP26-29, the RP2040's real ADC-capable pins - mirrors PicoRuntime's own
// (private) ADC_BASE_PIN/ADC_CHANNEL_COUNT/ADC_MAX, needed here too for
// writeAnalogPin()'s own range check and voltage-to-code scaling.
const ADC_BASE_PIN = 26;
const ADC_CHANNEL_COUNT = 4;
const ADC_MAX = 4095;

// "GP<n>" -> n. Lives here, not in rp2040js, the same way avr8-js's own
// parsePinName() lives in its adapter, not avr8js.
function parsePinName(pin: string): number {
  const match = /^GP(\d+)$/.exec(pin);
  if (!match) {
    throw new Error(`Invalid pin id "${pin}"`);
  }
  return Number(match[1]);
}
