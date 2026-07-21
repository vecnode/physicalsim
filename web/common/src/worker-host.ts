// Runs inside a Worker: wires a SimulatorAdapter to the postMessage RPC
// protocol defined in adapter-types.ts. One call from each adapter's
// worker.ts entry point.

import type {
  ReadPinParams,
  RpcRequest,
  RpcResponse,
  SimulatorAdapter,
  SubscribePinParams,
  WritePinParams,
} from "./adapter-types.js";

export function hostAdapter(adapter: SimulatorAdapter): void {
  adapter.onStateChange((state) => {
    const event: RpcResponse = { event: "stateChange", state };
    postMessage(event);
  });

  // Pins are only forwarded as events once the shell asks for them (via the
  // "subscribePin" method below) - unlike stateChange, which is always-on.
  // Idempotent per pin: re-subscribing is a no-op rather than double-firing.
  const pinSubscriptions = new Map<string, () => void>();

  // Same idea as pinSubscriptions, but there's only ever one serial stream
  // per adapter (not one per pin), so a single flag is enough to make
  // "subscribeSerial" idempotent.
  let serialSubscribed = false;

  self.addEventListener("message", async (ev: MessageEvent<RpcRequest>) => {
    const { id, method, params } = ev.data;
    try {
      let result: unknown;
      switch (method) {
        case "init":
          result = await adapter.init(params);
          break;
        case "start":
          result = adapter.start();
          break;
        case "stop":
          result = adapter.stop();
          break;
        case "step":
          result = adapter.step(params as number);
          break;
        case "reset":
          result = adapter.reset();
          break;
        case "readPin":
          if (!adapter.readPin) {
            throw new Error(`Adapter "${adapter.id}" does not support readPin`);
          }
          result = adapter.readPin((params as ReadPinParams).pin);
          break;
        case "writePin":
          if (!adapter.writePin) {
            throw new Error(`Adapter "${adapter.id}" does not support writePin`);
          }
          {
            const { pin, value } = params as WritePinParams;
            result = adapter.writePin(pin, value);
          }
          break;
        case "subscribePin":
          if (!adapter.onPinChange) {
            throw new Error(`Adapter "${adapter.id}" does not support onPinChange`);
          }
          {
            const { pin } = params as SubscribePinParams;
            if (!pinSubscriptions.has(pin)) {
              const unsubscribe = adapter.onPinChange(pin, (value) => {
                const event: RpcResponse = { event: "pinChange", pin, value };
                postMessage(event);
              });
              pinSubscriptions.set(pin, unsubscribe);
            }
            result = undefined;
          }
          break;
        case "subscribeSerial":
          if (!adapter.onSerialData) {
            throw new Error(`Adapter "${adapter.id}" does not support onSerialData`);
          }
          if (!serialSubscribed) {
            serialSubscribed = true;
            adapter.onSerialData((byte) => {
              const event: RpcResponse = { event: "serialData", byte };
              postMessage(event);
            });
          }
          result = undefined;
          break;
        case "loadFirmware":
          if (!adapter.loadFirmware) {
            throw new Error(`Adapter "${adapter.id}" does not support loadFirmware`);
          }
          adapter.loadFirmware(params as Uint8Array);
          result = undefined;
          break;
        default:
          throw new Error(`Unknown method: ${method as string}`);
      }
      const response: RpcResponse = { id, result };
      postMessage(response);
    } catch (err) {
      const response: RpcResponse = {
        id,
        error: err instanceof Error ? err.message : String(err),
      };
      postMessage(response);
    }
  });
}
