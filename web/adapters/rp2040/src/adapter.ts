import { RP2040 } from "rp2040js";
import type { GPIOPin } from "rp2040js";

// RP2040's own `clock` field is typed as the minimal `IClock` interface
// (just `nanos`/`createAlarm`) - `tick()`/`nanosToNextAlarm` only exist
// on the concrete `SimulationClock` implementation `new RP2040()`
// actually constructs by default (rp2040.ts's own `clock: IClock = new
// SimulationClock()`), but `SimulationClock` itself isn't re-exported
// from rp2040js's own index.ts, so this names just the two members
// stepOnce() below needs rather than importing the concrete class.
interface TickableClock {
  tick(deltaNanos: number): void;
  readonly nanosToNextAlarm: number;
}
import { MPU6050Device, SSD1306Device, type SimState, type SimulatorAdapter } from "@physicalsim/common";
import { DS1307Device } from "./ds1307.js";
import { I2CBus } from "./i2c-bus.js";
import { bootromB1 } from "./bootrom-b1.js";

// The application's own vector table sits immediately after the 256-byte
// boot stage-2 region (a fixed RP2040 hardware constant - real flash always
// reserves exactly this much for boot2, regardless of what boot2
// implementation a given toolchain links in). Word 0 is the initial stack
// pointer, word 1 is the reset handler address - see loadFirmware() below.
const APP_VECTOR_TABLE_OFFSET = 0x100;

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
  private serialListeners = new Set<(byte: number) => void>();
  private i2cFrameListeners = new Set<(device: string, data: Uint8Array) => void>();

  constructor() {
    // Real ROM (see bootrom-b1.ts) - pico-sdk's runtime calls into a
    // handful of bootrom-provided functions (double/float math shims), so
    // this needs to be genuinely loaded, not left at rp2040js's all-zero
    // default, even though loadFirmware() below skips actually *executing*
    // bootrom's own cold-boot code (see that method's own comment).
    this.mcu.loadBootrom(bootromB1);
    // Unlike Avr8Adapter, RP2040 is one monolithic class - reset() below
    // only resets the core, it never recreates `this.mcu` (see rp2040js's
    // own RP2040.core.reset()), so this.mcu.uart[0]/this.mcu.adc keep
    // existing across a reset the same way real UART/ADC peripheral
    // hardware would survive a CPU reset. Wiring onByte once here (not
    // re-wired in reset(), unlike avr8's onByteTransmit) is therefore
    // correct, not an oversight.
    this.mcu.uart[0].onByte = (value) => {
      for (const cb of this.serialListeners) cb(value);
    };
    // Unlike avr8, rp2040js's I2C0/I2C1 (and SPI0/1, PIO0/1) are already
    // constructed unconditionally by the RP2040 class itself (see
    // rp2040.ts's own `readonly i2c = [...]` field) - there's no
    // equivalent of AVRSPI/AVRTWI's "never constructed, so the bus hangs"
    // bug to fix here. What's missing is device-specific behavior on top,
    // same as avr8: this binds every device decoder that exists so far -
    // DS1307 (0x68), MPU6050 (0x69 - its real AD0-high alternate address,
    // deliberately not its 0x68 default, to avoid colliding with
    // DS1307's own fixed 0x68 - see MPU6050Device's own comment), and
    // SSD1306 (0x3c) - to I2C0 via I2CBus (see i2c-bus.ts).
    new I2CBus(this.mcu.i2c[0], [
      new DS1307Device(),
      new MPU6050Device(),
      new SSD1306Device((data) => {
        for (const cb of this.i2cFrameListeners) cb("ssd1306", data);
      }),
    ]);
  }

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
      this.stepOnce();
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

  // GPIOPin's own outputEnable getter (gpio-pin.ts) - real RP0/RP1 pad
  // output-enable state, true once firmware calls gpio_set_dir(pin,
  // GPIO_OUT) (or gpio_init() defaults it - real hardware resets to
  // input), false otherwise. No separate tracking needed, same reasoning
  // as avr8's own readPinDirection() reading DDR directly.
  readPinDirection(pin: string): "input" | "output" {
    return this.resolvePin(pin).outputEnable ? "output" : "input";
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

  // Analog counterpart to writePin - GPIO26-29 double as ADC channels
  // 0-3 on a real RP2040 (rp2040js's own adc.ts: "Channels 0...3 are
  // connected to GPIO 26...29"). Unlike avr8's ADC (channelValues in
  // volts against a configurable reference), rp2040js's RPADC stores raw
  // 12-bit codes directly - completeADCRead() writes channelValues[n]
  // straight into the RESULT register with no voltage-to-code conversion
  // step of its own - so this does that conversion here, against the
  // Pico's fixed 3.3V ADC reference (not 5V, unlike avr8's boards).
  writeAnalogPin(pin: string, voltage: number): void {
    const index = this.pinIndex(pin);
    const channel = index - 26;
    if (channel < 0 || channel > 3) {
      throw new Error(`Pin "${pin}" is not an ADC-capable pin`);
    }
    const clamped = Math.min(3.3, Math.max(0, voltage));
    this.mcu.adc.channelValues[channel] = Math.round((clamped / 3.3) * 0xfff);
  }

  // Fires once per byte the firmware writes to UART0's data register -
  // the rp2040 counterpart to Avr8Adapter's onSerialData (see that
  // method's own comment for why this is transmit-only for now).
  onSerialData(cb: (byte: number) => void): () => void {
    this.serialListeners.add(cb);
    return () => this.serialListeners.delete(cb);
  }

  // rp2040 counterpart to Avr8Adapter's onI2CFrame - see that method's
  // own comment.
  onI2CFrame(cb: (device: string, data: Uint8Array) => void): () => void {
    this.i2cFrameListeners.add(cb);
    return () => this.i2cFrameListeners.delete(cb);
  }

  // Writes a raw flash image (rp2040_toolchain.cpp's compiled output - a
  // flat binary, not Intel HEX like avr8's loadFirmware(); RP2040 has no
  // such convention) and boots into it.
  //
  // Deliberately does NOT simulate the real ROM bootrom's own cold-boot
  // sequence (crystal oscillator / PLL / voltage-regulator bring-up,
  // followed by validating and jumping into the flash-resident boot stage
  // 2) the way real hardware does - confirmed by hand (see
  // ARCHITECTURE.md's "RP2040 firmware pipeline" section) that rp2040js's
  // own peripheral emulation doesn't fully model the registers that cold
  // boot sequence polls, and stalls indefinitely partway through PLL init.
  // Instead this jumps straight to the *application's* own vector table -
  // exactly what an attached hardware debugger does when it "resets and
  // runs" a target, skipping ROM entirely. The compiled binary's boot2
  // region (its first 256 bytes) is still present in `bytes` and still
  // linked by the sketch template's CMakeLists.txt (pico-sdk's own build
  // requires reserving that space), it's just never executed - since
  // rp2040js reads flash directly out of its own `flash` array rather than
  // a physical SPI chip, boot2's real job (configuring the flash
  // controller for XIP reads) has nothing to warm up here.
  loadFirmware(bytes: Uint8Array): void {
    this.mcu.flash.fill(0xff);
    this.mcu.flash.set(bytes, 0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const initialSp = view.getUint32(APP_VECTOR_TABLE_OFFSET, true);
    const resetHandler = view.getUint32(APP_VECTOR_TABLE_OFFSET + 4, true);
    this.stop();
    this.mcu.core.reset();
    this.mcu.core.SP = initialSp;
    this.mcu.core.PC = resetHandler & ~1;
    this.emitState();
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

  // RP2040.step() (rp2040js's own, see rp2040.ts) is *only*
  // `this.core.executeInstruction()` - it never advances `this.clock`.
  // Timer/alarm-driven peripherals (the hardware TIMER sleep_ms()/
  // busy_wait_until() poll, WFI wake-up scheduling) depend entirely on
  // `clock.tick(nanos)` being called with real elapsed time - skip that,
  // and any sketch that sleeps or waits-for-interrupt hangs forever,
  // spinning on a condition nothing will ever advance. Confirmed by hand
  // (see ARCHITECTURE.md's "RP2040 firmware pipeline" section) this was
  // the actual root cause of the previously-documented sleep_ms() hang -
  // not an rp2040js peripheral-completeness gap the way it first looked,
  // a missing clock.tick() call in this adapter's own execution loop.
  // Mirrors rp2040js's own reference Simulator.execute() (demo code,
  // wokwi/rp2040js's src/simulator.ts) exactly, including the WFI-aware
  // fast-forward: when the core is idle waiting for an interrupt,
  // jumping the clock straight to the next scheduled alarm is both
  // correct (nothing observable happens in between) and far faster than
  // single-stepping through do-nothing cycles.
  private readonly cycleNanos = 1e9 / 125_000_000; // 125MHz, matching rp2040js's own reference runner

  private stepOnce(): void {
    const { core } = this.mcu;
    const clock = this.mcu.clock as unknown as TickableClock;
    if (core.waiting) {
      clock.tick(clock.nanosToNextAlarm);
    } else {
      const cycles = core.executeInstruction();
      clock.tick(cycles * this.cycleNanos);
    }
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
      cycles: this.mcu.core.cycles,
      pc: this.mcu.core.PC,
    };
    for (const listener of this.listeners) listener(state);
  }
}
