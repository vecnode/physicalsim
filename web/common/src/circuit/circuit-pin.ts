import type { AdapterMethod } from "../adapter-types.js";
import { resolvePin, type BoardPinMap } from "../boards/board.js";

// The minimal shape CircuitPin needs from an adapter client. Deliberately
// not imported from web/shell (SimClient there) - common has no dependency
// on shell, and shell's AdapterClient/NativeAdapterClient already satisfy
// this shape structurally, so no explicit wiring is needed either way.
export interface PinClient {
  call(method: AdapterMethod, params?: unknown): Promise<unknown>;
  onPinChange?(cb: (pin: string, value: number) => void): () => void;
}

// Thin wrapper around one adapter pin, reached through a client's generic
// call()/onPinChange(). Adapter-agnostic: works the same whether the
// underlying client is Worker-backed (avr8, rp2040) or native (cortex-m),
// though onChange() throws for clients that don't support pin-change push
// (see PinClient.onPinChange being optional, and NativeAdapterClient not
// implementing it today).
export class CircuitPin {
  private subscribed = false;

  constructor(
    private readonly client: PinClient,
    readonly pin: string,
  ) {}

  // Convenience constructor for the common case of wiring up a pin by its
  // board silkscreen name (e.g. "D13") rather than the adapter's raw pin
  // id (e.g. "B5") - see boards/arduino-uno.ts, boards/rp2040-board.ts.
  static forBoardPin(client: PinClient, board: BoardPinMap, name: string): CircuitPin {
    return new CircuitPin(client, resolvePin(board, name));
  }

  async read(): Promise<number> {
    const result = await this.client.call("readPin", { pin: this.pin });
    return result as number;
  }

  async write(value: number): Promise<void> {
    await this.client.call("writePin", { pin: this.pin, value });
  }

  // Analog counterpart to write() - drives an ADC channel with a voltage
  // rather than a GPIO pin with a bit. Rejects (via the RPC error path -
  // see worker-host.ts) for any adapter that doesn't implement
  // writeAnalogPin?; callers wiring up components that may land on a
  // non-ADC board (analog-chain.ts) already swallow that rejection the
  // same way protocol-chain.ts's attach() swallows an unresolvable pin.
  async writeAnalog(voltage: number): Promise<void> {
    await this.client.call("writeAnalogPin", { pin: this.pin, voltage });
  }

  onChange(cb: (value: number) => void): () => void {
    if (!this.client.onPinChange) {
      throw new Error(
        `Cannot subscribe to pin "${this.pin}": this client does not support pin-change events`,
      );
    }
    if (!this.subscribed) {
      this.subscribed = true;
      void this.client.call("subscribePin", { pin: this.pin });
    }
    return this.client.onPinChange((pin, value) => {
      if (pin === this.pin) cb(value);
    });
  }
}
