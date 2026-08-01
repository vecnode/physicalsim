import {
  ArduinoRuntime,
  compileSketch,
  createSketchGlobals,
  parsePinName,
  pinName,
  type CompiledSketch,
} from "avr8js/arduino";
import type { SimState, SimulatorAdapter } from "@physicalsim/common";

// A JS/TS-native Arduino adapter: instead of compiling a real C++
// sketch with avr-gcc and running the resulting machine code through
// avr8js's cycle-accurate CPU emulation (see ../avr8/src/adapter.ts),
// this interprets a JS/TS-authored sketch directly via avr8js's
// ArduinoRuntime - no C/C++ toolchain involved at all. One class backs
// every 14-digital-pin AVR board (Uno/Nano/Leonardo - see
// UNO_PIN_SHAPE) plus Mega (its own much bigger pin count - see
// worker-mega.ts), parameterized by `pinShape` rather
// than one class per chip, since the JS-native execution model has no
// chip-specific register/vector-table differences left to encode -
// pin count is the only thing that actually varies.
//
// Pin ids are exactly avr8js/arduino's own pinName() output
// ("D0".."D13"/"A0".."A5" for the default shape, "D0".."D53"/
// "A0".."A15" for Mega) - see boards/arduino-uno.ts's identity
// BoardPinMap, which exists only so the board-resolution layer has a
// map to look up, not because any actual translation happens.
export interface Avr8JsPinShape {
  digitalPinCount: number;
  analogPinCount: number;
}

// Uno/Nano/Leonardo's shape - 14 digital + 6 analog. Mega passes its own
// (54 digital + 16 analog, see worker-mega.ts) instead of this default.
export const UNO_PIN_SHAPE: Avr8JsPinShape = { digitalPinCount: 14, analogPinCount: 6 };

export class Avr8JsAdapter implements SimulatorAdapter {
  readonly id = "avr8-js";

  private readonly pinShape: Avr8JsPinShape;
  private runtime: ArduinoRuntime;
  private sketch: CompiledSketch | null = null;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  // Real hardware runs setup() exactly once at boot, before loop() ever
  // runs - true whether the caller drives execution via start() (free-
  // running) or step() (the UI's manual single-step control, which needs
  // the same "boot happens once" semantics the very first time it's used
  // on a freshly loaded sketch, not just when start() happens to be
  // clicked first).
  private setupRan = false;
  // The sketch source's own JS/TS text - kept so reset() can re-run
  // compileSketch() against a fresh ArduinoRuntime (see reset()'s own
  // comment for why the already-compiled closures can't just be reused).
  private lastSource: string | undefined;

  private listeners = new Set<(state: SimState) => void>();
  private pinListeners = new Map<string, Set<(value: number) => void>>();
  private serialListeners = new Set<(byte: number) => void>();

  constructor(pinShape: Avr8JsPinShape = UNO_PIN_SHAPE) {
    this.pinShape = pinShape;
    this.runtime = this.createRuntime();
  }

  private createRuntime(): ArduinoRuntime {
    return new ArduinoRuntime({ pinCount: this.pinShape.digitalPinCount + this.pinShape.analogPinCount });
  }

  async init(_config: unknown): Promise<void> {
    // Nothing to boot into yet - loadFirmware() (really "load sketch
    // source" here) is what makes a sketch runnable, same as Avr8Adapter.
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

  // Runs `n` loop() iterations back-to-back, matching Avr8Adapter.step()'s
  // shape (a bounded amount of work, not a free-running clock) - used by
  // the UI's manual single-step control. Each iteration can genuinely
  // block for however long the sketch's own delay() calls inside it add
  // up to (see ArduinoRuntime.delay()'s own doc comment) - a deliberate
  // MVP trade-off, not an oversight; see the plan this shipped from.
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
    this.runtime = this.createRuntime();
    this.wireRuntimeListeners();
    this.setupRan = false;
    if (this.sketch) {
      // Re-bind the existing sketch source against the fresh runtime -
      // loadFirmware() already has the source text, but reset() itself
      // only ever receives a signal, not the bytes again, so the already-
      // compiled closures (which captured the OLD runtime's globals) must
      // be discarded and re-created against the new one.
      this.sketch = compileSketch(this.lastSource ?? "", createSketchGlobals(this.runtime, this.pinShape));
    }
    this.emitState();
  }

  onStateChange(cb: (state: SimState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  readPin(pin: string): number {
    return this.runtime.readPin(this.parsePin(pin));
  }

  readPinDirection(pin: string): "input" | "output" {
    return this.runtime.readPinDirection(this.parsePin(pin));
  }

  writePin(pin: string, value: number): void {
    this.runtime.setDigitalInput(this.parsePin(pin), value ? 1 : 0);
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

  writeAnalogPin(pin: string, voltage: number): void {
    const numericPin = this.parsePin(pin);
    if (numericPin < this.pinShape.digitalPinCount) {
      throw new Error(`Pin "${pin}" is not an ADC-capable pin`);
    }
    // 0-5V, matching every classic AVR board's real ADC reference range
    // (same clamp Avr8Adapter.writeAnalogPin() applies before AVRADC
    // ever sees it).
    const clampedVoltage = Math.min(5, Math.max(0, voltage));
    this.runtime.setAnalogInput(numericPin, Math.round((clampedVoltage / 5) * 1023));
  }

  onSerialData(cb: (byte: number) => void): () => void {
    this.serialListeners.add(cb);
    return () => this.serialListeners.delete(cb);
  }

  // The sketch source's own JS/TS text, UTF-8 encoded - "bytes" is
  // adapter-specific per SimulatorAdapter's own doc comment, and this
  // adapter never produces or consumes machine code at all. Reboots into
  // it the same way Avr8Adapter.loadFirmware() reboots into a freshly
  // flashed image.
  loadFirmware(bytes: Uint8Array): void {
    const source = new TextDecoder().decode(bytes);
    this.lastSource = source;
    this.runtime = this.createRuntime();
    this.wireRuntimeListeners();
    this.sketch = compileSketch(source, createSketchGlobals(this.runtime, this.pinShape));
    this.running = false;
    this.setupRan = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.emitState();
  }

  private parsePin(pin: string): number {
    return parsePinName(pin, this.pinShape.digitalPinCount, this.pinShape.analogPinCount);
  }

  private wireRuntimeListeners(): void {
    this.runtime.onSerialWrite((byte) => {
      for (const cb of this.serialListeners) cb(byte);
    });
    const totalPins = this.pinShape.digitalPinCount + this.pinShape.analogPinCount;
    for (let pin = 0; pin < totalPins; pin++) {
      const name = pinName(pin, this.pinShape.digitalPinCount, this.pinShape.analogPinCount);
      this.runtime.onPinChange(pin, (value) => {
        for (const cb of this.pinListeners.get(name) ?? []) cb(value);
      });
    }
  }

  // Each scheduled call runs exactly one loop() iteration then re-checks
  // `running` before scheduling the next - not a tight synchronous while
  // loop - so a stop() between iterations is always honored promptly even
  // though a single iteration's own delay() calls can't be interrupted
  // mid-call (see ArduinoRuntimeStoppedError's own doc comment in
  // avr8js/arduino for why: a Worker is single-threaded, so nothing can
  // set the stop flag while a busy-wait delay() is spinning).
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
      cycles: 0, // no cycle-accurate clock in this execution mode
      millis: this.runtime.millis(),
    };
    for (const listener of this.listeners) listener(state);
  }
}
