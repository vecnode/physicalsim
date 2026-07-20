import type {
  AdapterMethod,
  RpcRequest,
  RpcResponse,
  SimState,
} from "@physicalsim/common";
import { isRpcEvent } from "@physicalsim/common";

// Generic client side of the adapter RPC protocol (common/src/adapter-types.ts).
// Works against any adapter worker, since the protocol is adapter-agnostic.
export class AdapterClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private stateListeners = new Set<(state: SimState) => void>();
  private pinChangeListeners = new Set<(pin: string, value: number) => void>();

  constructor(private worker: Worker) {
    this.worker.addEventListener("message", (ev: MessageEvent<RpcResponse>) => {
      const msg = ev.data;
      if (isRpcEvent(msg)) {
        if (msg.event === "stateChange") {
          for (const listener of this.stateListeners) listener(msg.state);
        } else {
          for (const listener of this.pinChangeListeners) listener(msg.pin, msg.value);
        }
        return;
      }
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if ("error" in msg) {
        entry.reject(new Error(msg.error));
      } else {
        entry.resolve(msg.result);
      }
    });
  }

  call(method: AdapterMethod, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const request: RpcRequest = { id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(request);
    });
  }

  onStateChange(cb: (state: SimState) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  onPinChange(cb: (pin: string, value: number) => void): () => void {
    this.pinChangeListeners.add(cb);
    return () => this.pinChangeListeners.delete(cb);
  }

  terminate(): void {
    this.worker.terminate();
    this.pending.clear();
    this.stateListeners.clear();
    this.pinChangeListeners.clear();
  }
}
