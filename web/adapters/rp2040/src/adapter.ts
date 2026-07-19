import { RP2040 } from "rp2040js";
import type { SimState, SimulatorAdapter } from "@physicalsim/common";

const STEPS_PER_TICK = 20000;

export class Rp2040Adapter implements SimulatorAdapter {
  readonly id = "rp2040";

  private mcu = new RP2040();
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(state: SimState) => void>();

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

  private scheduleTick(): void {
    this.timer = setTimeout(() => {
      if (!this.running) return;
      for (let i = 0; i < STEPS_PER_TICK; i++) {
        this.mcu.step();
      }
      this.emitState();
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
