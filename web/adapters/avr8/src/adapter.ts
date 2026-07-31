import {
  adcConfig,
  avrInstruction,
  AVRADC,
  AVREEPROM,
  AVRIOPort,
  AVRSPI,
  AVRTimer,
  AVRTWI,
  AVRUSART,
  CPU,
  EEPROMMemoryBackend,
  eepromConfig,
  spiConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  twiConfig,
  usart0Config,
} from "avr8js";
import { MPU6050Device, SSD1306Device, type SimState, type SimulatorAdapter } from "@physicalsim/common";
import { DS1307Device } from "./ds1307.js";
import { I2CBus } from "./i2c-bus.js";
import { ATMEGA328P, type AvrChipConfig } from "./chip.js";

const CLOCK_HZ = 16e6;

// Caps how often a *running* simulation posts a state update. The tick loop
// itself runs unthrottled (as fast as the event loop allows) — this only
// bounds the postMessage/DOM-update rate that follows from it, which
// otherwise fires hundreds of times/sec forever and is what actually made
// the UI get slower the longer a run went on.
const EMIT_INTERVAL_MS = 50;

// The Worker is single-threaded: a `stop` message can't be processed until
// the current tick's synchronous batch of instructions returns control to
// the event loop, no matter how quickly stop() itself runs. So batch size
// directly controls worst-case stop latency. Rather than hardcode a cycle
// count (whose wall-clock duration depends entirely on the host JS engine's
// speed), self-tune it every tick to target a fixed wall-clock budget —
// keeps stop responsive consistently across machines instead of being fast
// on one and sluggish on another.
const TARGET_BATCH_MS = 8;
const MIN_BATCH_CYCLES = 200;
const MAX_BATCH_CYCLES = 500_000;
const INITIAL_BATCH_CYCLES = 20_000;

export class Avr8Adapter implements SimulatorAdapter {
  readonly id = "avr8";

  private program: Uint16Array;
  private cpu: CPU;
  // Undefined on chips without chip.hasAtmegaSharedPeripherals (ATtiny85
  // - see chip.ts) - genuinely not constructed there, not just unused,
  // since their fixed ATmega-shaped addresses would otherwise collide
  // with ATtiny85's real GPIO registers (see chip.ts's own comment).
  private timer0: AVRTimer | undefined;
  private timer1: AVRTimer | undefined;
  private timer2: AVRTimer | undefined;
  // Port letter -> constructed AVRIOPort, built from chip.ports in
  // attachPeripherals() - not fixed B/C/D fields, since a second chip
  // variant (ATMEGA2560, see chip.ts) has 11 of these, not 3.
  private ports = new Map<string, AVRIOPort>();
  private adcPort!: AVRIOPort;
  private usart: AVRUSART | undefined;
  private adc!: AVRADC;
  private spi: AVRSPI | undefined;
  private twi: AVRTWI | undefined;
  private eeprom!: AVREEPROM;
  // Constructed once, not in attachPeripherals() - EEPROM is battery-
  // backed on real hardware, meaning its contents survive a power cycle
  // (Stop/Start, Reset, even loadFirmware()'s reboot into new firmware,
  // matching how the same physical chip's EEPROM would still hold
  // whatever the previous sketch wrote). It does NOT survive this Worker
  // being torn down and recreated (a full page reload) - a documented,
  // not silent, difference from real hardware's non-volatility, matching
  // this project's existing "in-memory, not persisted to disk" posture
  // (see ARCHITECTURE.md's "Feature parity vs. velxio" section).
  private readonly eepromBackend: EEPROMMemoryBackend;

  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastEmitAt = 0;
  private batchCycles = INITIAL_BATCH_CYCLES;
  private listeners = new Set<(state: SimState) => void>();

  private pinListeners = new Map<string, Set<(value: number) => void>>();
  private lastPinValues = new Map<string, number>();
  // Subscriptions here are the outside world's, not per-run state - unlike
  // lastPinValues (cleared in attachPeripherals() on every reset), this set
  // must survive a reset() the same way pinListeners does, since resetting
  // the CPU shouldn't silently drop whoever's listening to Serial output.
  private serialListeners = new Set<(byte: number) => void>();
  // Same "survives reset(), not per-run state" reasoning as
  // serialListeners - an I2C display decoder's frames shouldn't stop
  // reaching a subscriber just because the CPU was reset.
  private i2cFrameListeners = new Set<(device: string, data: Uint8Array) => void>();

  // Defaults to the atmega328p (Arduino Uno/Nano - both the exact same
  // MCU, see boards/arduino-nano.ts) - pass ATMEGA2560 (chip.ts) for a
  // Mega-shaped worker entry point (worker-mega.ts). Kept as a
  // constructor parameter, not a second class, since every method below
  // (start/stop/step/pin I/O/ADC/loadFirmware/reset) is chip-agnostic
  // once ports/flash size come from `chip` instead of being hardcoded.
  constructor(private readonly chip: AvrChipConfig = ATMEGA328P) {
    this.program = new Uint16Array(chip.flashWords);
    this.cpu = new CPU(this.program, this.chip.sramBytes, this.chip.registerSpace);
    this.eepromBackend = new EEPROMMemoryBackend(chip.eepromBytes);
  }

  async init(_config: unknown): Promise<void> {
    // Firmware is loaded later, via loadFirmware() - init() just gets the
    // CPU/peripherals into a bootable (if empty-flash) state, the same one
    // reset() returns to.
    this.attachPeripherals();
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
      avrInstruction(this.cpu);
      this.cpu.tick();
    }
    this.emitState();
  }

  reset(): void {
    this.stop();
    this.cpu = new CPU(this.program, this.chip.sramBytes, this.chip.registerSpace);
    this.attachPeripherals();
    this.emitState();
  }

  onStateChange(cb: (state: SimState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // Pin ids are "<port letter><bit>", e.g. "B5" (Arduino Uno's onboard LED).
  // Board-level logical names ("D13") are resolved to this shape one layer
  // up - see the boards/ mapping this feeds into.
  readPin(pin: string): number {
    const { port, bit } = this.resolvePin(pin);
    return (this.cpu.data[port.portConfig.PIN] >> bit) & 1;
  }

  // The real DDR (Data Direction Register) bit for this pin - 1 means
  // the CPU has configured it as an output (pinMode(pin, OUTPUT)), 0
  // means input (the DDR's own real, hardware reset-default state,
  // matching every AVR pin defaulting to input until firmware says
  // otherwise). Read directly from the same register writePin/readPin
  // already resolve through resolvePin() - no separate tracking needed,
  // since avr8js's AVRIOPort already models DDR as a real CPU-visible
  // register.
  readPinDirection(pin: string): "input" | "output" {
    const { port, bit } = this.resolvePin(pin);
    return ((this.cpu.data[port.portConfig.DDR] >> bit) & 1) ? "output" : "input";
  }

  writePin(pin: string, value: number): void {
    const { port, bit } = this.resolvePin(pin);
    port.setPin(bit, !!value);
    // setPin() drives AVRIOPort's external input value directly and does
    // not go through writeGpio() (that's only for the CPU's own PORT/DDR
    // writes), so it never reaches the port.addListener hook wired up in
    // attachPeripherals(). Notify explicitly so writePin-driven changes
    // (e.g. simulating a button press) surface the same way CPU-driven
    // ones do.
    this.notifyPinChange(pin, (this.cpu.data[port.portConfig.PIN] >> bit) & 1);
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

  // Drives an ADC channel with a real voltage (0..5, clamped) rather than
  // a GPIO bit - a placed potentiometer/photoresistor/joystick's "read"
  // side (see analog-chain.ts, web/shell). Reuses resolvePin() for the
  // port/bit lookup since A0-A5 already resolve to "C0".."C5" via
  // boardPinMaps (see boards/arduino-uno.ts) - the ADC channel number
  // happens to equal PORTC's bit number on the atmega328p (both are 0-5
  // for A0-A5), which is why no separate "analog pin id" concept exists
  // here; this only accepts port C, since that's the only port any board
  // map ever resolves an analog pin name to.
  writeAnalogPin(pin: string, voltage: number): void {
    const { port, bit } = this.resolvePin(pin);
    if (port !== this.adcPort || bit >= this.chip.adcChannels) {
      throw new Error(`Pin "${pin}" is not an ADC-capable pin`);
    }
    this.adc.channelValues[bit] = Math.min(5, Math.max(0, voltage));
  }

  // Fires once per byte the firmware writes to UDR (the USART transmit
  // register) - real Arduino sketches reach this through Serial.write()/
  // Serial.print(). Read-only: this is Stage 1 of the terminal ("show
  // whatever the firmware transmits"), not Serial.read() support -
  // AVRUSART.writeByte() exists for injecting an RX byte, but nothing
  // calls it here yet (see ARCHITECTURE.md's "Serial Monitor" section for
  // why that's deliberately a separate, later step).
  onSerialData(cb: (byte: number) => void): () => void {
    this.serialListeners.add(cb);
    return () => this.serialListeners.delete(cb);
  }

  // Fires whenever a device behind the I2C bus (see i2c-bus.ts) publishes
  // a decoded frame - today, only SSD1306Device does ("ssd1306"). Same
  // "survives reset()" posture as onSerialData above.
  onI2CFrame(cb: (device: string, data: Uint8Array) => void): () => void {
    this.i2cFrameListeners.add(cb);
    return () => this.i2cFrameListeners.delete(cb);
  }

  // Writes a parsed flash image (see @physicalsim/common's
  // parseIntelHex()) into program memory and reboots into it. `bytes` is
  // a plain byte stream in address order; AVR flash is word-addressed
  // and little-endian, so each pair of bytes packs into one
  // this.program entry the same way avr-gcc's own .hex output already
  // assumes a real programmer would unpack it.
  //
  // this.program is filled with 0xffff (all-ones, matching an erased
  // chip's real reset state) before writing bytes over it, rather than
  // only overwriting exactly `bytes.length` worth - otherwise a shorter
  // second firmware load would leave the *previous* load's now-stale
  // instructions sitting past the new program's end, silently reachable
  // if execution ever ran off the end of the intended code.
  loadFirmware(bytes: Uint8Array): void {
    const maxBytes = this.program.length * 2;
    if (bytes.length > maxBytes) {
      throw new Error(`Firmware is ${bytes.length} bytes, too large for the ${maxBytes}-byte flash`);
    }
    this.program.fill(0xffff);
    const wordCount = Math.ceil(bytes.length / 2);
    for (let i = 0; i < wordCount; i++) {
      const lo = bytes[i * 2];
      const hi = i * 2 + 1 < bytes.length ? bytes[i * 2 + 1] : 0xff;
      this.program[i] = lo | (hi << 8);
    }
    // Booting new firmware is exactly what reset() already does (recreate
    // the CPU/peripherals from this.program, wipe registers and cycle
    // count) - reusing it here rather than duplicating that logic.
    this.reset();
  }

  private resolvePin(pin: string): { port: AVRIOPort; bit: number } {
    const portLetter = pin.charAt(0).toUpperCase();
    const bit = Number(pin.slice(1));
    if (!Number.isInteger(bit) || bit < 0 || bit > 7) {
      throw new Error(`Invalid pin id "${pin}"`);
    }
    const port = this.ports.get(portLetter);
    if (!port) {
      throw new Error(`Unknown port for pin id "${pin}"`);
    }
    return { port, bit };
  }

  private notifyPinChange(pin: string, value: number): void {
    if (this.lastPinValues.get(pin) === value) return;
    this.lastPinValues.set(pin, value);
    for (const cb of this.pinListeners.get(pin) ?? []) cb(value);
  }

  private attachPeripherals(): void {
    // Timer0/1/2, USART0, SPI, TWI - only for chips whose real hardware
    // has them at these fixed ATmega-family addresses (see chip.ts's
    // hasAtmegaSharedPeripherals doc comment for why constructing them
    // for ATtiny85 would actively corrupt its GPIO registers, not just
    // be inert). Timer0/1's own configs are spread with the chip's own
    // vectorOverride (undefined on every chip except ATmega32u4 - see
    // chip.ts's own doc comment on timer0VectorOverride for why this
    // exists at all: a chip whose real vector table differs from the
    // shared atmega328p/2560 layout these fixed configs assume would
    // otherwise fire interrupts at the WRONG address).
    if (this.chip.hasAtmegaSharedPeripherals) {
      this.timer0 = new AVRTimer(
        this.cpu,
        this.chip.timer0VectorOverride ? { ...timer0Config, ...this.chip.timer0VectorOverride } : timer0Config,
      );
      this.timer1 = new AVRTimer(
        this.cpu,
        this.chip.timer1VectorOverride ? { ...timer1Config, ...this.chip.timer1VectorOverride } : timer1Config,
      );
      // hasTimer2 defaults to true (every chip here has one except
      // ATmega32u4, see chip.ts) - undefined must mean "yes", not
      // "falsy therefore no".
      this.timer2 =
        this.chip.hasTimer2 !== false
          ? new AVRTimer(
              this.cpu,
              this.chip.timer2VectorOverride ? { ...timer2Config, ...this.chip.timer2VectorOverride } : timer2Config,
            )
          : undefined;
    } else {
      this.timer0 = undefined;
      this.timer1 = undefined;
      this.timer2 = undefined;
    }
    this.ports = new Map(
      Object.entries(this.chip.ports).map(([letter, config]) => [letter, new AVRIOPort(this.cpu, config)]),
    );
    const adcPort = this.ports.get(this.chip.adcPortLetter);
    if (!adcPort) {
      throw new Error(`Chip config's adcPortLetter "${this.chip.adcPortLetter}" isn't one of its own ports`);
    }
    this.adcPort = adcPort;
    // adcConfig already ships atmega328Channels as its muxChannels - ADC
    // channels 0-7 map straight onto ADMUX's mux-select bits, exactly how
    // real hardware ties A0-A7 to PORTC's ADC-capable pins, so no per-
    // board remapping is needed here. Constructed unconditionally (even
    // for ATtiny85, whose chip.adcChannels is 0) - its own register
    // addresses (0x78+) don't collide with anything, and writeAnalogPin()
    // below already rejects any bit >= chip.adcChannels before ever
    // touching this.adc, so an ATtiny85 sketch simply never reaches code
    // that would need this to be chip-accurate. adcVectorOverride is the
    // same "this chip's real vector table differs" story as Timer0/1
    // above (ATmega32u4 only).
    this.adc = new AVRADC(
      this.cpu,
      this.chip.adcVectorOverride ? { ...adcConfig, adcInterrupt: this.chip.adcVectorOverride } : adcConfig,
    );
    if (this.chip.hasAtmegaSharedPeripherals) {
      // Constructing these (even with no device-specific eventHandler/
      // onByte set beyond DS1307Device below) is what stops any sketch
      // that touches SPI.transfer()/Wire.endTransmission() from hanging
      // forever - before this, writes to SPDR/TWCR had no writeHooks at
      // all, so SPSR's SPIF flag (or TWCR's TWINT flag) never set and a
      // sketch's own `while (!(SPSR & SPIF));`-style wait spun forever.
      // AVRSPI's default onByte (returns 0 on every byte, "nothing's
      // there") and AVRTWI's default NoopTWIEventHandler (NACKs every
      // address, "nothing's listening") now make that correct, even for
      // devices with no decoder of their own yet (ILI9341, SD, SSD1306,
      // MPU6050, I2C-mode LCD) - a real improvement independent of DS1307Device
      // below, which is the one device with actual protocol-level behavior
      // so far. spi/twiVectorOverride, same ATmega32u4-only story as above.
      // hasUsart0 defaults to true the same way hasTimer2 does.
      this.usart =
        this.chip.hasUsart0 !== false
          ? new AVRUSART(
              this.cpu,
              this.chip.usart0VectorOverride ? { ...usart0Config, ...this.chip.usart0VectorOverride } : usart0Config,
              CLOCK_HZ,
            )
          : undefined;
      this.spi = new AVRSPI(
        this.cpu,
        this.chip.spiVectorOverride ? { ...spiConfig, spiInterrupt: this.chip.spiVectorOverride } : spiConfig,
        CLOCK_HZ,
      );
      this.twi = new AVRTWI(
        this.cpu,
        this.chip.twiVectorOverride ? { ...twiConfig, twiInterrupt: this.chip.twiVectorOverride } : twiConfig,
        CLOCK_HZ,
      );
      // Three devices behind one AVRTWI.eventHandler slot, dispatched by
      // address (see i2c-bus.ts) - DS1307 (0x68), MPU6050 (0x69 - its
      // real AD0-high alternate address, not its more common 0x68
      // default, specifically to avoid colliding with DS1307's own fixed
      // 0x68 - see MPU6050Device's own doc comment), and SSD1306 (0x3c).
      this.twi.eventHandler = new I2CBus(this.twi, [
        new DS1307Device(),
        new MPU6050Device(),
        new SSD1306Device((data) => {
          for (const cb of this.i2cFrameListeners) cb("ssd1306", data);
        }),
      ]);
      // reset() replaces this.cpu and re-runs attachPeripherals(), which
      // constructs a brand-new AVRUSART with its own (null) onByteTransmit -
      // re-wiring it here, not just once at construction, is what keeps
      // Serial output flowing to the same subscribers across a reset instead
      // of silently going dark after the first Stop.
      if (this.usart) {
        this.usart.onByteTransmit = (value) => {
          for (const cb of this.serialListeners) cb(value);
        };
      }
    } else {
      this.usart = undefined;
      this.spi = undefined;
      this.twi = undefined;
    }
    // this.eepromBackend itself is constructed once (see the constructor)
    // and reused here on every reset - only the AVREEPROM peripheral
    // object (which just wraps cpu+backend to service EECR/EEDR register
    // writes) needs recreating alongside the fresh CPU.
    this.eeprom = new AVREEPROM(this.cpu, this.eepromBackend, eepromConfig);

    // See chip.ts's ATMEGA32U4.hasUsbPll comment for the full story:
    // ArduinoCore-avr's own USBCore.cpp busy-waits on PLLCSR's PLOCK bit
    // (I/O 0x29, memory 0x49 - confirmed against the bundled avr-libc's
    // own <avr/iom32u4.h>) during boot, which avr8js has no peripheral
    // for. Reporting it always locked - preserving whatever else a
    // sketch writes to this register, just forcing bit 0 on - is what
    // lets any Leonardo sketch reach setup() at all. Set fresh on every
    // reset()/attachPeripherals() call, same as every other hook here
    // (this.cpu is a brand-new instance each time).
    if (this.chip.hasUsbPll) {
      const PLLCSR_ADDR = 0x49;
      const PLOCK_BIT = 1 << 0;
      this.cpu.readHooks[PLLCSR_ADDR] = () => this.cpu.data[PLLCSR_ADDR] | PLOCK_BIT;
    }

    this.lastPinValues.clear();
    for (const [letter, port] of this.ports) {
      port.addListener((newValue, oldValue) => {
        if (newValue === oldValue) return;
        for (let bit = 0; bit < 8; bit++) {
          if (((newValue >> bit) ^ (oldValue >> bit)) & 1) {
            this.notifyPinChange(`${letter}${bit}`, (newValue >> bit) & 1);
          }
        }
      });
    }
  }

  private scheduleTick(): void {
    this.timer = setTimeout(() => {
      if (!this.running) return;
      const startCycles = this.cpu.cycles;
      const target = startCycles + this.batchCycles;
      const start = performance.now();
      while (this.cpu.cycles < target) {
        avrInstruction(this.cpu);
        this.cpu.tick();
      }
      const elapsedMs = performance.now() - start;
      const cyclesRun = this.cpu.cycles - startCycles;
      if (elapsedMs > 0 && cyclesRun > 0) {
        const cyclesPerMs = cyclesRun / elapsedMs;
        this.batchCycles = Math.round(
          Math.min(MAX_BATCH_CYCLES, Math.max(MIN_BATCH_CYCLES, cyclesPerMs * TARGET_BATCH_MS)),
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
      cycles: this.cpu.cycles,
      pc: this.cpu.pc,
    };
    for (const listener of this.listeners) listener(state);
  }
}
