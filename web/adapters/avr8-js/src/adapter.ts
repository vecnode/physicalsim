import { ArduinoRuntime, compileSketch, createSketchGlobals, pinName, type CompiledSketch } from "avr8js/arduino";
import type { SimState, SimulatorAdapter } from "@physicalsim/common";

// A second, parallel Arduino Uno adapter: instead of compiling a real
// C++ sketch with avr-gcc and running the resulting machine code through
// avr8js's cycle-accurate CPU emulation (see ../avr8/src/adapter.ts),
// this interprets a JS/TS-authored sketch directly via avr8js's
// ArduinoRuntime - no C/C++ toolchain involved at all. Deliberately a
// separate adapter/board type ("avr8-js" / "arduino-uno-js"), not a mode
// flag on Avr8Adapter - the execution model (interpreted setup()/loop(),
// blocking delay(), no register-level anything) is different enough that
// sharing one class would mean every method branching on which mode it's
// in, rather than two adapters that both happen to implement the same
// SimulatorAdapter shape.
//
// Pin ids are exactly ArduinoRuntime's own pinName() output ("D0".."D13",
// "A0".."A5") - see boards/arduino-uno-js.ts's identity BoardPinMap, which
// exists only so the board-resolution layer has a map to look up, not
// because any actual translation happens.
export class Avr8JsAdapter implements SimulatorAdapter {
  readonly id = "avr8-js";

  private runtime = new ArduinoRuntime();
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
    this.runtime = new ArduinoRuntime();
    this.wireRuntimeListeners();
    this.setupRan = false;
    if (this.sketch) {
      // Re-bind the existing sketch source against the fresh runtime -
      // loadFirmware() already has the source text, but reset() itself
      // only ever receives a signal, not the bytes again, so the already-
      // compiled closures (which captured the OLD runtime's globals) must
      // be discarded and re-created against the new one.
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

  writeAnalogPin(pin: string, voltage: number): void {
    const numericPin = parsePinName(pin);
    if (numericPin < 14) {
      throw new Error(`Pin "${pin}" is not an ADC-capable pin`);
    }
    // 0-5V, matching the Uno's real ADC reference range (same clamp
    // Avr8Adapter.writeAnalogPin() applies before AVRADC ever sees it).
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
    this.runtime = new ArduinoRuntime();
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
    this.runtime.onSerialWrite((byte) => {
      for (const cb of this.serialListeners) cb(byte);
    });
    for (let pin = 0; pin < 20; pin++) {
      const name = pinName(pin);
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

// Inverse of avr8js/arduino's pinName() - "D0".."D13" -> 0-13, "A0".."A5"
// -> 14-19. Lives here, not in avr8js, the same way Avr8Adapter's own
// resolvePin() (parsing "B5" into a port+bit) lives in adapter.ts rather
// than avr8js itself - adapter-facing pin-string parsing, not core
// runtime logic.
function parsePinName(pin: string): number {
  const letter = pin.charAt(0).toUpperCase();
  const index = Number(pin.slice(1));
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Invalid pin id "${pin}"`);
  }
  if (letter === "D" && index <= 13) {
    return index;
  }
  if (letter === "A" && index <= 5) {
    return 14 + index;
  }
  throw new Error(`Invalid pin id "${pin}"`);
}
