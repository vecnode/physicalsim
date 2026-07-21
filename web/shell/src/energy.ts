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

// A power source a board can be fed from (USB, a wall adapter, battery -
// distinct from `SimulatorAdapter` in adapter-types.ts, which is CPU
// emulation and has nothing to do with power; the two just happen to
// share the English word "adapter"). Not selectable from the UI yet -
// this exists so a board descriptor can name what it *could* run from
// without every board being assumed to have exactly one implicit supply.
export interface PowerSource {
  name: string; // e.g. "USB", "wall adapter", "battery (2xAA)"
  voltage: number; // nominal volts this source delivers
  maxCurrentMa?: number; // supply's own current limit, if known
}

// Everything computeEnergy() needs for one board type, replacing what
// used to be two separate lookup tables (boardNominalVoltage,
// boardNominalCurrentMa) keyed the same way - collapsed into one entry
// per board so adding a board type is one registry line, not one edit in
// each of two files.
export interface PowerProfile {
  supplyVoltage: number; // nominal logic-level rail, e.g. 5 for an Uno
  currentMa: { idle: number; running: number };
  // Known power sources this board can be fed from. Informational only
  // today (nothing in computeEnergy branches on it yet) - the natural
  // slot for a future "what's this board plugged into" control without
  // reshaping BoardEnergy again.
  sources?: PowerSource[];
}

// Board type -> its power profile. Arduino Uno's logic level is a fixed,
// known 5V whenever powered (not something to compute), and its idle/
// running current figures are approximate ones for an ATmega328p at
// 16MHz, not measured from this simulation - the UI should read as
// "roughly what a real board would draw here", not as a precise
// instrument reading.
export const boardPowerProfile: Record<string, PowerProfile> = {
  "arduino-uno": {
    supplyVoltage: 5,
    currentMa: { idle: 45, running: 60 },
    sources: [
      { name: "USB", voltage: 5, maxCurrentMa: 500 },
      { name: "DC barrel jack (wall adapter)", voltage: 9 },
      { name: "Vin header", voltage: 9 },
    ],
  },
};

// board.powered decides voltage on/off; `running` (the adapter's own
// state.running, not board.powered) picks which current nominal applies
// - a paused-but-powered board still has voltage but draws the idle
// figure, not the running one.
export function computeEnergy(board: CircuitBoard, running: boolean): BoardEnergy {
  if (!board.powered) {
    return { boardId: board.id, voltage: 0, currentMa: 0 };
  }
  const profile = boardPowerProfile[board.type];
  if (!profile) {
    return { boardId: board.id, voltage: 0, currentMa: 0 };
  }
  const currentMa = running ? profile.currentMa.running : profile.currentMa.idle;
  return { boardId: board.id, voltage: profile.supplyVoltage, currentMa };
}
