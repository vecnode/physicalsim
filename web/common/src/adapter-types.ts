// Shared contract between the shell UI and every simulator adapter worker.

export type PinDirection = "input" | "output";

export interface SimState {
  running: boolean;
  cycles: number;
  [key: string]: unknown;
}

export interface SimulatorAdapter {
  readonly id: string;
  init(config: unknown): Promise<void>;
  start(): void;
  stop(): void;
  step(n: number): void;
  reset(): void;
  onStateChange(cb: (state: SimState) => void): () => void;
  // Pin I/O is a MANDATORY capability, not an optional one - every adapter
  // this project registers (JS-worker or native/QEMU-backed) is required
  // to give the analog netlist/solver (web/shell's canvas/netlist.ts +
  // mna-solver.ts, driven by analog-net-chain.ts) a real, working answer
  // for all five of these, the same way avr8/rp2040 already do. A pin
  // that genuinely has no ADC hardware still answers writeAnalogPin() (by
  // cleanly rejecting it, matching avr8/rp2040's own "reject a non-ADC
  // pin, caught not thrown" posture) rather than the method being absent -
  // "no such capability" is not a valid response for a registered adapter
  // any more, only "this particular pin doesn't support it."
  readPin(pin: string): number | undefined;
  writePin(pin: string, value: number): void;
  onPinChange(pin: string, cb: (value: number) => void): () => void;
  // Whether a pin is currently configured as a firmware-driven output or
  // a (possibly externally-driven) input - readPin()/writePin() alone
  // don't distinguish these, and the analog netlist/solver needs to know:
  // an output pin driving HIGH/LOW is a real, if small, voltage source for
  // the circuit it's wired into; an input pin is high-impedance, just
  // another node. Adapter-specific in how it's determined (avr8: the
  // port's real DDR register bit; rp2040: GPIOPin's own outputEnable;
  // esp32: QEMU's GPIO_ENABLE_REG peeked over QMP) but always answerable.
  readPinDirection(pin: string): PinDirection | undefined;
  // Analog input - separate from readPin()/writePin() (which are always
  // digital 0/1) because an ADC channel is fed a continuous voltage, not
  // a bit. "pin" is the same adapter-level pin id writePin() uses (e.g.
  // "C0" for avr8's A0) - the ADC channel it maps to is an adapter-
  // internal detail, not something callers need to know.
  writeAnalogPin(pin: string, voltage: number): void;
  // Serial (UART TX) output - also optional, and read-only for now: this
  // is Stage 1 of the terminal feature ("show whatever the firmware
  // transmits"), not Serial.read() support. Only avr8 implements it today
  // (rp2040/esp32 have no UART peripheral wired up yet).
  onSerialData?(cb: (byte: number) => void): () => void;
  // Optional - fires with a device-decoder's decoded output whenever it
  // has a new frame to publish (today: SSD1306Device's GDDRAM buffer,
  // "device" is always "ssd1306" for now). Modeled as one generic event
  // keyed by device name, not a dedicated onSsd1306Frame, so a second
  // I2C device with a visual payload doesn't need its own new RPC method
  // added everywhere this one already reaches (worker-host.ts,
  // worker-rpc.ts, adapter-registry.ts) - only a new `device` string
  // value flowing through the same plumbing. I2C devices are address-
  // based, not wire-routed (see ARCHITECTURE.md), so this fires whenever
  // the adapter's bus decodes a frame regardless of whether anything on
  // the canvas is "wired" to it - i2c-display-chain.ts (web/shell) is
  // what decides whether a matching element is actually placed to push
  // pixels into.
  onI2CFrame?(cb: (device: string, data: Uint8Array) => void): () => void;
  // Stage 2 of the terminal feature: writes a flash image (already
  // parsed from Intel HEX - see intel-hex.ts - into plain bytes) into
  // the adapter's own program memory and resets, so it actually runs.
  // Optional and adapter-specific in what "bytes" means (for avr8, the
  // little-endian word-packed contents of flash) - a future rp2040
  // equivalent would interpret the same raw-bytes shape differently, not
  // share this method's exact semantics.
  loadFirmware?(bytes: Uint8Array): void;
}

// ---- Worker RPC protocol -------------------------------------------------
// The shell (client) sends {id, method, params} and the worker replies with
// exactly one {id, result} or {id, error}. The worker may also push
// unsolicited {event, state} messages at any time (state-change notifications).

export type AdapterMethod =
  | "init"
  | "start"
  | "stop"
  | "step"
  | "reset"
  | "readPin"
  | "readPinDirection"
  | "writePin"
  | "writeAnalogPin"
  | "subscribePin"
  | "subscribeSerial"
  | "subscribeI2CFrame"
  | "loadFirmware";

export interface ReadPinParams {
  pin: string;
}

export interface WritePinParams {
  pin: string;
  value: number;
}

export interface WriteAnalogPinParams {
  pin: string;
  voltage: number;
}

export interface SubscribePinParams {
  pin: string;
}

export interface RpcRequest {
  id: number;
  method: AdapterMethod;
  params?: unknown;
}

export interface RpcResult {
  id: number;
  result: unknown;
}

export interface RpcError {
  id: number;
  error: string;
}

export interface StateChangeEvent {
  event: "stateChange";
  state: SimState;
}

export interface PinChangeEvent {
  event: "pinChange";
  pin: string;
  value: number;
}

export interface SerialDataEvent {
  event: "serialData";
  byte: number;
}

export interface I2CFrameEvent {
  event: "i2cFrame";
  device: string;
  data: Uint8Array;
}

export type RpcEvent = StateChangeEvent | PinChangeEvent | SerialDataEvent | I2CFrameEvent;

export type RpcResponse = RpcResult | RpcError | RpcEvent;

export function isRpcEvent(msg: RpcResponse): msg is RpcEvent {
  return "event" in msg;
}
