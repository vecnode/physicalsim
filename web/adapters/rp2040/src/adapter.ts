import { RP2040 } from "rp2040js";
import type { GPIOPin } from "rp2040js";
import type { SimState, SimulatorAdapter } from "@physicalsim/common";

// Caps how often a *running* simulation posts a state update. The tick loop
// itself runs unthrottled (as fast as the event loop allows) — this only
// bounds the postMessage/DOM-update rate that follows from it, which
// otherwise fires hundreds of times/sec forever and is what actually made
// the UI get slower the longer a run went on.
const EMIT_INTERVAL_MS = 50;

// The Worker is single-threaded: a `stop` message can't be processed until
// the current tick's synchronous batch of mcu.step() calls returns control
// to the event loop, no matter how quickly stop() itself runs. So batch
// size directly controls worst-case stop latency. Rather than hardcode a
// step count (whose wall-clock duration depends entirely on the host JS
// engine's speed), self-tune it every tick to target a fixed wall-clock
// budget — keeps stop responsive consistently across machines instead of
// being fast on one and sluggish on another.
const TARGET_BATCH_MS = 8;
const MIN_BATCH_STEPS = 200;
const MAX_BATCH_STEPS = 500_000;
const INITIAL_BATCH_STEPS = 20_000;

export class Rp2040Adapter implements SimulatorAdapter {
  readonly id = "rp2040";

  private mcu = new RP2040();
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastEmitAt = 0;
  private batchSteps = INITIAL_BATCH_STEPS;
  private listeners = new Set<(state: SimState) => void>();

  private pinListeners = new Map<string, Set<(value: number) => void>>();
  private lastPinValues = new Map<string, number>();
  private subscribedPins = new Set<number>();

  async init(_config: unknown): Promise<void> {
    // RP2040 constructor already resets the core; nothing else required.
    // No firmware loading yet — this just runs the CPU against whatever
    // is in flash/bootrom (empty), to exercise start/stop/step/reset.
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleTick();
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
    for (let i = 0; i < n; i++) {
      this.mcu.step();
    }
    this.emitState();
  }

  reset(): void {
    this.stop();
    this.mcu.core.reset();
    this.emitState();
  }

  onStateChange(cb: (state: SimState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // Pin ids are "GP<n>", e.g. "GP25" (the Pico's onboard LED). Board-level
  // logical names are resolved to this shape one layer up.
  readPin(pin: string): number {
    const gpio = this.resolvePin(pin);
    return this.effectiveValue(gpio) ? 1 : 0;
  }

  writePin(pin: string, value: number): void {
    const gpio = this.resolvePin(pin);
    // Real firmware enables a pad's input path explicitly (gpio_init())
    // before an externally-driven pin reads as anything but disabled -
    // GPIOPin's padValue defaults to input disabled (see gpio-pin.ts).
    // writePin models an external wire being attached to this pin, so
    // force that on rather than requiring firmware to have configured it.
    gpio.padValue |= 0x40;
    gpio.setInputValue(!!value);
    // setInputValue() only updates the pin's raw external-input value and
    // its IRQ status - unlike an SIO/PADS/PIO-driven output change, it
    // never calls checkForUpdates() (see gpio-pin.ts), so it never
    // reaches the addListener hook subscribePin() below wires up. Notify
    // explicitly so writePin-driven changes (e.g. simulating a button
    // press) surface the same way firmware-driven ones do.
    this.notifyPinChange(pin, this.effectiveValue(gpio) ? 1 : 0);
  }

  onPinChange(pin: string, cb: (value: number) => void): () => void {
    const index = this.pinIndex(pin);
    const gpio = this.resolvePin(pin);
    let listeners = this.pinListeners.get(pin);
    if (!listeners) {
      listeners = new Set();
      this.pinListeners.set(pin, listeners);
    }
    listeners.add(cb);
    if (!this.subscribedPins.has(index)) {
      this.subscribedPins.add(index);
      gpio.addListener(() => {
        this.notifyPinChange(pin, this.effectiveValue(gpio) ? 1 : 0);
      });
    }
    return () => listeners.delete(cb);
  }

  // A GPIOPin's own `.value` only reports Low/High while it's actively
  // driven as an output (see gpio-pin.ts's `value` getter) - it doesn't
  // reflect an externally-injected input value at all. Combine both so
  // readPin/onPinChange report one consistent "what would a multimeter
  // read on this pin" bit regardless of direction.
  private effectiveValue(gpio: GPIOPin): boolean {
    return gpio.outputEnable ? gpio.outputValue : gpio.inputValue;
  }

  private pinIndex(pin: string): number {
    const match = /^GP(\d+)$/i.exec(pin);
    if (!match) {
      throw new Error(`Invalid pin id "${pin}"`);
    }
    return Number(match[1]);
  }

  private resolvePin(pin: string): GPIOPin {
    const index = this.pinIndex(pin);
    const gpio = this.mcu.gpio[index];
    if (!gpio) {
      throw new Error(`Unknown pin id "${pin}"`);
    }
    return gpio;
  }

  private notifyPinChange(pin: string, value: number): void {
    if (this.lastPinValues.get(pin) === value) return;
    this.lastPinValues.set(pin, value);
    for (const cb of this.pinListeners.get(pin) ?? []) cb(value);
  }

  private scheduleTick(): void {
    this.timer = setTimeout(() => {
      if (!this.running) return;
      const start = performance.now();
      for (let i = 0; i < this.batchSteps; i++) {
        this.mcu.step();
      }
      const elapsedMs = performance.now() - start;
      if (elapsedMs > 0) {
        const stepsPerMs = this.batchSteps / elapsedMs;
        this.batchSteps = Math.round(
          Math.min(MAX_BATCH_STEPS, Math.max(MIN_BATCH_STEPS, stepsPerMs * TARGET_BATCH_MS)),
        );
      }
      const now = Date.now();
      if (now - this.lastEmitAt >= EMIT_INTERVAL_MS) {
        this.lastEmitAt = now;
        this.emitState();
      }
      this.scheduleTick();
    }, 0);
  }

  private emitState(): void {
    const state: SimState = {
      running: this.running,
      cycles: this.mcu.core.cycles,
      pc: this.mcu.core.PC,
    };
    for (const listener of this.listeners) listener(state);
  }
}
