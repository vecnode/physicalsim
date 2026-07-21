import type { CircuitBoard } from "./circuit.js";

// A second, separate model from circuit.ts - deliberately not new fields
// on CircuitBoard. Mirrors how velxio keeps its digital MCU harness and
// its analog solver (MNA/ngspice) as two things bridged through one
// narrow interface (an AVRSpiceBridge) rather than one shared struct:
// here, computeEnergy() is that bridge - it only ever reads a
// CircuitBoard, never stores one, and circuit.ts has no idea this file
// exists.
//
// Nominal values only, not solved from a real topology - there's no
// wiring between components yet for anything Ohm's-law-shaped to apply
// to (see ARCHITECTURE.md's "Energy model" section for what a real
// circuit-topology solver would take, and why it's a deliberate later
// step, not this one).
export interface BoardEnergy {
  boardId: string; // matches a CircuitBoard.id - the only link to circuit.ts
  voltage: number; // volts, 0 when unpowered
  currentMa: number; // milliamps, nominal estimate, 0 when unpowered
}

// Board type -> logic-level supply voltage. A fixed, known constant per
// board (Arduino Uno runs its logic at 5V), not something to compute.
export const boardNominalVoltage: Record<string, number> = {
  "arduino-uno": 5,
};

// Board type -> nominal current draw, idle (powered, CPU not ticking -
// e.g. paused) vs running (CPU actively executing). Approximate figures
// for an ATmega328p at 16MHz, not measured from this simulation - the
// UI should read as "roughly what a real board would draw here", not as
// a precise instrument reading.
export const boardNominalCurrentMa: Record<string, { idle: number; running: number }> = {
  "arduino-uno": { idle: 45, running: 60 },
};

// board.powered decides voltage on/off; `running` (the adapter's own
// state.running, not board.powered) picks which current nominal applies
// - a paused-but-powered board still has voltage but draws the idle
// figure, not the running one.
export function computeEnergy(board: CircuitBoard, running: boolean): BoardEnergy {
  if (!board.powered) {
    return { boardId: board.id, voltage: 0, currentMa: 0 };
  }
  const voltage = boardNominalVoltage[board.type] ?? 0;
  const currentNominal = boardNominalCurrentMa[board.type];
  const currentMa = currentNominal ? (running ? currentNominal.running : currentNominal.idle) : 0;
  return { boardId: board.id, voltage, currentMa };
}
