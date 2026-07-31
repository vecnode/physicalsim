import { Board, ESP32_DEVKIT_V1, GPIO_REG } from "esp32js";
import type { SimState, SimulatorAdapter } from "@physicalsim/common";

// Caps how often a *running* simulation posts a state update - same
// reasoning as avr8/rp2040's own EMIT_INTERVAL_MS (adapter.ts in those
// packages): the tick loop itself runs unthrottled, this only bounds the
// postMessage/DOM-update rate that follows from it.
const EMIT_INTERVAL_MS = 50;

// Same self-tuning batch-size reasoning as avr8/rp2040's own adapters -
// see either of those files' own comment on TARGET_BATCH_MS.
const TARGET_BATCH_MS = 8;
const MIN_BATCH_STEPS = 200;
const MAX_BATCH_STEPS = 500_000;
const INITIAL_BATCH_STEPS = 20_000;

// ESP32's real ADC1 channel <-> GPIO wiring (Espressif's ESP32 datasheet) -
// esp32js's Adc peripheral itself only knows raw channel numbers (see
// esp32js's peripherals/adc.ts), not which GPIO backs each one.
const ADC1_CHANNEL_BY_GPIO: Readonly<Record<number, number>> = {
  36: 0,
  37: 1,
  38: 2,
  39: 3,
  32: 4,
  33: 5,
  34: 6,
  35: 7,
};

// ESP32's SAR ADC has no configurable-reference concept modeled here (see
// esp32js's own Adc doc comment on ADC_ATTEN not being backed) - fixed at
// the chip's real un-attenuated default full-scale voltage, same "one
// fixed reference" posture rp2040's own writeAnalogPin (3.3V) already
// takes for its own SoC.
const ADC_REFERENCE_VOLTS = 3.3;
const ADC_MAX_CODE = 0xfff; // 12-bit

export class Esp32Adapter implements SimulatorAdapter {
  readonly id = "esp32";

  private board = new Board(ESP32_DEVKIT_V1);
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastEmitAt = 0;
  private batchSteps = INITIAL_BATCH_STEPS;
  private listeners = new Set<(state: SimState) => void>();

  private pinListeners = new Map<string, Set<(value: number) => void>>();
  private lastPinValues = new Map<string, number>();
  private subscribedPins = new Set<number>();
  private serialListeners = new Set<(byte: number) => void>();

  constructor() {
    this.wireBoard();
  }

  async init(_config: unknown): Promise<void> {
    // Board() is already constructed in the field initializer, bootable
    // (if firmware-less) - nothing else required, same posture as
    // Rp2040Adapter's own init().
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
      this.stepOnce();
    }
    this.emitState();
  }

  reset(): void {
    this.stop();
    this.board = new Board(ESP32_DEVKIT_V1);
    this.wireBoard();
    this.emitState();
  }

  onStateChange(cb: (state: SimState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // Pin ids are "D<n>", e.g. "D2" (GPIO2) - board-registry.ts's
  // esp32DevkitV1Board/esp32DevkitCV4Board/esp32CamBoard maps already
  // resolve a placed board's silkscreen labels to this identity shape.
  readPin(pin: string): number {
    return this.board.getPin(this.pinIndex(pin));
  }

  // GPIO_ENABLE's real per-pin output-enable bit - 1 means firmware has
  // configured this pin as an output (gpio_set_direction(pin, OUTPUT)),
  // matching avr8's DDR bit / rp2040's outputEnable posture.
  readPinDirection(pin: string): "input" | "output" {
    const index = this.pinIndex(pin);
    const enable = this.board.bus.gpio.readWord(GPIO_REG.ENABLE);
    return (enable >>> index) & 1 ? "output" : "input";
  }

  writePin(pin: string, value: number): void {
    const index = this.pinIndex(pin);
    this.board.setPin(index, value ? 1 : 0);
    this.notifyPinChange(pin, this.board.getPin(index));
  }

  onPinChange(pin: string, cb: (value: number) => void): () => void {
    const index = this.pinIndex(pin);
    let listeners = this.pinListeners.get(pin);
    if (!listeners) {
      listeners = new Set();
      this.pinListeners.set(pin, listeners);
    }
    listeners.add(cb);
    this.subscribedPins.add(index);
    return () => listeners.delete(cb);
  }

  // Analog input - GPIO32-39 double as ADC1 channels 4-7/0-3 on a real
  // ESP32 (see ADC1_CHANNEL_BY_GPIO above). Any other pin has no ADC1
  // channel behind it - rejected the same "caught not thrown" way avr8/
  // rp2040's own writeAnalogPin() reject a non-ADC pin.
  writeAnalogPin(pin: string, voltage: number): void {
    const index = this.pinIndex(pin);
    const channel = ADC1_CHANNEL_BY_GPIO[index];
    if (channel === undefined) {
      throw new Error(`Pin "${pin}" is not an ADC-capable pin`);
    }
    const clamped = Math.min(ADC_REFERENCE_VOLTS, Math.max(0, voltage));
    this.board.setAdcChannel(channel, Math.round((clamped / ADC_REFERENCE_VOLTS) * ADC_MAX_CODE));
  }

  // Fires once per byte the firmware writes to UART0 - the esp32
  // counterpart to Avr8Adapter's onSerialData/Rp2040Adapter's own.
  onSerialData(cb: (byte: number) => void): () => void {
    this.serialListeners.add(cb);
    return () => this.serialListeners.delete(cb);
  }

  // Loads a compiled ELF (esp32_toolchain.cpp's compile_sketch() output -
  // a plain ELF32 image, not Intel HEX or a raw flash binary, since
  // esp32js's loadElf() reads PT_LOAD segments directly) and boots into
  // it - matching avr8/rp2040's own "loaded but not running until Start is
  // clicked" loadFirmware()-then-reset() shape.
  loadFirmware(bytes: Uint8Array): void {
    this.stop();
    this.board = new Board(ESP32_DEVKIT_V1);
    this.wireBoard();
    this.board.loadFirmware(bytes);
    this.emitState();
  }

  private pinIndex(pin: string): number {
    const match = /^D(\d+)$/i.exec(pin);
    if (!match) {
      throw new Error(`Invalid pin id "${pin}"`);
    }
    const index = Number(match[1]);
    if (index < 0 || index > 39) {
      throw new Error(`Unknown pin id "${pin}"`);
    }
    return index;
  }

  private wireBoard(): void {
    this.board.onSerialOut = (byte) => {
      for (const cb of this.serialListeners) cb(byte);
    };
    this.lastPinValues.clear();
  }

  private notifyPinChange(pin: string, value: number): void {
    if (this.lastPinValues.get(pin) === value) return;
    this.lastPinValues.set(pin, value);
    for (const cb of this.pinListeners.get(pin) ?? []) cb(value);
  }

  // esp32js's Gpio peripheral has no push-based "output changed" listener
  // (unlike avr8's AVRIOPort.addListener/rp2040's GPIOPin.addListener) -
  // polling every subscribed pin once per step is the same cost class as
  // those adapters' own per-step work, and simpler than adding a listener
  // hook to esp32js itself for a handful of pins.
  private checkSubscribedPins(): void {
    for (const index of this.subscribedPins) {
      const pin = `D${index}`;
      this.notifyPinChange(pin, this.board.getPin(index));
    }
  }

  private stepOnce(): void {
    this.board.step();
    this.checkSubscribedPins();
  }

  private scheduleTick(): void {
    this.timer = setTimeout(() => {
      if (!this.running) return;
      const start = performance.now();
      for (let i = 0; i < this.batchSteps; i++) {
        this.stepOnce();
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
      cycles: Number(this.board.cpu.cycles),
      pc: this.board.cpu.pc,
    };
    for (const listener of this.listeners) listener(state);
  }
}
