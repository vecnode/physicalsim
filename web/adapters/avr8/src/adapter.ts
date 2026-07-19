import {
  avrInstruction,
  AVRIOPort,
  AVRTimer,
  AVRUSART,
  CPU,
  portBConfig,
  portCConfig,
  portDConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  usart0Config,
} from "avr8js";
import type { SimState, SimulatorAdapter } from "@physicalsim/common";

// ATmega328p (Arduino Uno) parameters.
const FLASH_WORDS = 0x8000;
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

  private program = new Uint16Array(FLASH_WORDS);
  private cpu = new CPU(this.program);
  private timer0!: AVRTimer;
  private timer1!: AVRTimer;
  private timer2!: AVRTimer;
  private portB!: AVRIOPort;
  private portC!: AVRIOPort;
  private portD!: AVRIOPort;
  private usart!: AVRUSART;

  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastEmitAt = 0;
  private batchCycles = INITIAL_BATCH_CYCLES;
  private listeners = new Set<(state: SimState) => void>();

  async init(_config: unknown): Promise<void> {
    // No firmware loading yet — this just runs the CPU against an empty
    // program, to exercise start/stop/step/reset.
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
    this.cpu = new CPU(this.program);
    this.attachPeripherals();
    this.emitState();
  }

  onStateChange(cb: (state: SimState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private attachPeripherals(): void {
    this.timer0 = new AVRTimer(this.cpu, timer0Config);
    this.timer1 = new AVRTimer(this.cpu, timer1Config);
    this.timer2 = new AVRTimer(this.cpu, timer2Config);
    this.portB = new AVRIOPort(this.cpu, portBConfig);
    this.portC = new AVRIOPort(this.cpu, portCConfig);
    this.portD = new AVRIOPort(this.cpu, portDConfig);
    this.usart = new AVRUSART(this.cpu, usart0Config, CLOCK_HZ);
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
