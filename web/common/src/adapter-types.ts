// Shared contract between the shell UI and every simulator adapter worker.

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
  // Pin I/O is an optional capability - not every adapter kind supports it
  // (e.g. a native/QEMU-backed adapter may only support a subset, or none,
  // depending on what its underlying machine model exposes).
  readPin?(pin: string): number | undefined;
  writePin?(pin: string, value: number): void;
  onPinChange?(pin: string, cb: (value: number) => void): () => void;
  // Serial (UART TX) output - also optional, and read-only for now: this
  // is Stage 1 of the terminal feature ("show whatever the firmware
  // transmits"), not Serial.read() support. Only avr8 implements it today
  // (rp2040/cortex-m have no UART peripheral wired up yet).
  onSerialData?(cb: (byte: number) => void): () => void;
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
  | "writePin"
  | "subscribePin"
  | "subscribeSerial"
  | "loadFirmware";

export interface ReadPinParams {
  pin: string;
}

export interface WritePinParams {
  pin: string;
  value: number;
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

export type RpcEvent = StateChangeEvent | PinChangeEvent | SerialDataEvent;

export type RpcResponse = RpcResult | RpcError | RpcEvent;

export function isRpcEvent(msg: RpcResponse): msg is RpcEvent {
  return "event" in msg;
}
