// Runs inside a Worker: wires a SimulatorAdapter to the postMessage RPC
// protocol defined in adapter-types.ts. One call from each adapter's
// worker.ts entry point.

import type { RpcRequest, RpcResponse, SimulatorAdapter } from "./adapter-types.js";

export function hostAdapter(adapter: SimulatorAdapter): void {
  adapter.onStateChange((state) => {
    const event: RpcResponse = { event: "stateChange", state };
    postMessage(event);
  });

  self.addEventListener("message", async (ev: MessageEvent<RpcRequest>) => {
    const { id, method, params } = ev.data;
    try {
      let result: unknown;
      switch (method) {
        case "init":
          result = await adapter.init(params);
          break;
        case "loadFirmware":
          result = await adapter.loadFirmware(params as Uint8Array);
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
