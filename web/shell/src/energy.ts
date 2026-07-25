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
  // Same atmega328p as the Uno, same nominal draw - COMPONENTS.md's
  // "Adding a new board" section calls out a missing entry here as
  // reading zero rather than erroring, which is what arduino-nano was
  // doing until now (a pre-existing gap, fixed in passing while adding
  // arduino-mega below for the same reason).
  "arduino-nano": {
    supplyVoltage: 5,
    currentMa: { idle: 45, running: 60 },
    sources: [
      { name: "USB (Mini-B)", voltage: 5, maxCurrentMa: 500 },
      { name: "Vin header", voltage: 9 },
    ],
  },
  // atmega2560 at the same 16MHz - a bigger die than the 328p but the
  // real datasheet's active-current figures land in a similar range;
  // approximate, like arduino-uno's own figures above, not measured from
  // this simulation.
  "arduino-mega": {
    supplyVoltage: 5,
    currentMa: { idle: 55, running: 90 },
    sources: [
      { name: "USB", voltage: 5, maxCurrentMa: 500 },
      { name: "DC barrel jack (wall adapter)", voltage: 9 },
      { name: "Vin header", voltage: 9 },
    ],
  },
  // atmega32u4 - a smaller die than the 328p but with native USB, real
  // datasheet active-current figures land a bit above the 328p's;
  // approximate, like every other profile here (not measured from this
  // simulation).
  "arduino-leonardo": {
    supplyVoltage: 5,
    currentMa: { idle: 50, running: 70 },
    sources: [
      { name: "USB", voltage: 5, maxCurrentMa: 500 },
      { name: "DC barrel jack (wall adapter)", voltage: 9 },
      { name: "Vin header", voltage: 9 },
    ],
  },
  // ATtiny85, not an ATmega - a much smaller die, real datasheet active-
  // current figures land well below the 328p/2560's, approximate like
  // every other profile here (not measured from this simulation). No
  // barrel jack/separate Vin regulator on the real board - it's a bare
  // USB-stick, powered over USB only.
  franzininho: {
    supplyVoltage: 5,
    currentMa: { idle: 10, running: 15 },
    sources: [{ name: "USB", voltage: 5, maxCurrentMa: 500 }],
  },
  // RP2040's own logic level is 3.3V, not 5V - genuinely different from
  // every other board here, not a copy/paste of the AVR boards' profile.
  "nano-rp2040-connect": {
    supplyVoltage: 3.3,
    currentMa: { idle: 20, running: 35 },
    sources: [{ name: "USB", voltage: 5, maxCurrentMa: 500 }],
  },
  // Same RP2040 chip as nano-rp2040-connect - same figures. A plain Pico
  // has no WiFi/IMU/mic drawing extra current the Nano RP2040 Connect's
  // additional silicon would, but that's not modeled by either profile
  // anyway (both are nominal chip-level estimates, not per-component).
  "pi-pico": {
    supplyVoltage: 3.3,
    currentMa: { idle: 20, running: 35 },
    sources: [{ name: "USB", voltage: 5, maxCurrentMa: 500 }],
  },
  // Same RP2040 chip, same nominal figures as the plain Pico - the
  // CYW43439 WiFi chip's own real draw (much higher when actually
  // radio-active) isn't modeled since WiFi itself isn't emulated.
  "pi-pico-w": {
    supplyVoltage: 3.3,
    currentMa: { idle: 20, running: 35 },
    sources: [{ name: "USB", voltage: 5, maxCurrentMa: 500 }],
  },
  // ESP32's own logic level is 3.3V, like RP2040 - real datasheet active-
  // current figures for the dual-core Xtensa LX6 land noticeably higher
  // than RP2040's Cortex-M0+ at idle/running, approximate like every
  // other profile here (not measured from this simulation, and WiFi/BT
  // radio current isn't modeled since neither is emulated - see
  // esp32_qemu_adapter.hpp).
  "esp32-devkit-v1": {
    supplyVoltage: 3.3,
    currentMa: { idle: 30, running: 80 },
    sources: [{ name: "USB (Micro-B)", voltage: 5, maxCurrentMa: 500 }],
  },
  // Same chip as esp32-devkit-v1, same approximate draw.
  "esp32-devkit-c-v4": {
    supplyVoltage: 3.3,
    currentMa: { idle: 30, running: 80 },
    sources: [{ name: "USB (Micro-B)", voltage: 5, maxCurrentMa: 500 }],
  },
  // Same chip; real hardware draws somewhat more when the camera/SD are
  // active, but neither is emulated, so this reuses the plain-ESP32 figure
  // rather than modeling current that would never actually be exercised.
  "esp32-cam": {
    supplyVoltage: 3.3,
    currentMa: { idle: 30, running: 80 },
    sources: [{ name: "5V header", voltage: 5, maxCurrentMa: 500 }],
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
