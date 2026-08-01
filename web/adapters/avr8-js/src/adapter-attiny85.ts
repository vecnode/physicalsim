import { ArduinoRuntime, compileSketch, createSketchGlobals, type CompiledSketch } from "avr8js/arduino";
import type { SimState, SimulatorAdapter } from "@physicalsim/common";

const PIN_COUNT = 6; // PB0-PB5, ATtiny85's entire port

// A JS/TS-native ATtiny85 adapter for Franzininho - same shape as
// adapter.ts's Avr8JsAdapter (interprets a JS sketch directly via
// avr8js/arduino's ArduinoRuntime, no C/C++ toolchain), but a separate,
// small class rather than a third Avr8JsPinShape: ATtiny85 doesn't
// follow the D<n>/A<n> Arduino numbering the ATmega-family boards share
// (avr8js/arduino's pinName()/parsePinName()) at all - real ATTinyCore
// numbers its 6 pins 0-5 directly onto PB0-PB5 (confirmed against the
// vendored tinyx5 variant's own pins_arduino.h, and matching this
// project's existing "Button Control" example, which already assumed
// this exact mapping under the real avr8-attiny85 CPU adapter), and the
// placed element's own pin markers are the real "PB<n>" silkscreen
// names (see boards/franzininho.ts), not "D<n>".
export class Avr8JsAttiny85Adapter implements SimulatorAdapter {
  readonly id = "avr8-js-attiny85";

  private runtime = new ArduinoRuntime({ pinCount: PIN_COUNT });
  private sketch: CompiledSketch | null = null;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private setupRan = false;
  private lastSource: string | undefined;

  private listeners = new Set<(state: SimState) => void>();
  private pinListeners = new Map<string, Set<(value: number) => void>>();
  private serialListeners = new Set<(byte: number) => void>();

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
    this.runtime = new ArduinoRuntime({ pinCount: PIN_COUNT });
    this.wireRuntimeListeners();
    this.setupRan = false;
    if (this.sketch) {
      this.sketch = compileSketch(
        this.lastSource ?? "",
        createSketchGlobals(this.runtime, { digitalPinCount: PIN_COUNT, analogPinCount: 0 }),
      );
    }
    this.emitState();
  }

  onStateChange(cb: (state: SimState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  readPin(pin: string): number {
    return this.runtime.readPin(parsePbPin(pin));
  }

  readPinDirection(pin: string): "input" | "output" {
    return this.runtime.readPinDirection(parsePbPin(pin));
  }

  writePin(pin: string, value: number): void {
    this.runtime.setDigitalInput(parsePbPin(pin), value ? 1 : 0);
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

  // No ADC modeled yet for this board (matches the real avr8-attiny85
  // adapter's own documented gap - chip.ts's ATTINY85 config skips
  // constructing a Timer1/ADC at all) - rejected the same "caught, not
  // thrown as an adapter-missing-capability" way SimulatorAdapter's own
  // doc comment requires.
  writeAnalogPin(pin: string, _voltage: number): void {
    throw new Error(`Pin "${pin}" is not an ADC-capable pin`);
  }

  onSerialData(cb: (byte: number) => void): () => void {
    this.serialListeners.add(cb);
    return () => this.serialListeners.delete(cb);
  }

  loadFirmware(bytes: Uint8Array): void {
    const source = new TextDecoder().decode(bytes);
    this.lastSource = source;
    this.runtime = new ArduinoRuntime({ pinCount: PIN_COUNT });
    this.wireRuntimeListeners();
    this.sketch = compileSketch(
      source,
      createSketchGlobals(this.runtime, { digitalPinCount: PIN_COUNT, analogPinCount: 0 }),
    );
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
    for (let pin = 0; pin < PIN_COUNT; pin++) {
      const name = `PB${pin}`;
      this.runtime.onPinChange(pin, (value) => {
        for (const cb of this.pinListeners.get(name) ?? []) cb(value);
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

// "PB<n>" -> n (0-5) - ATTinyCore's real Arduino-style numbering for
// PB0-PB5 (see this file's own header comment).
function parsePbPin(pin: string): number {
  const match = /^PB(\d)$/.exec(pin);
  if (!match) {
    throw new Error(`Invalid pin id "${pin}"`);
  }
  const index = Number(match[1]);
  if (index >= PIN_COUNT) {
    throw new Error(`Invalid pin id "${pin}"`);
  }
  return index;
}
