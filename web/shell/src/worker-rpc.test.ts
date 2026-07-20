import { describe, expect, it, vi } from "vitest";
import type { RpcRequest, RpcResponse } from "@physicalsim/common";
import { AdapterClient } from "./worker-rpc.js";

// Minimal fake Worker: captures postMessage calls and lets the test push
// messages back as if they came from the worker thread.
class FakeWorker {
  posted: RpcRequest[] = [];
  private listeners: Array<(ev: MessageEvent<RpcResponse>) => void> = [];

  postMessage(msg: RpcRequest): void {
    this.posted.push(msg);
  }

  addEventListener(_type: string, cb: (ev: MessageEvent<RpcResponse>) => void): void {
    this.listeners.push(cb);
  }

  terminate = vi.fn();

  emit(msg: RpcResponse): void {
    for (const cb of this.listeners) cb({ data: msg } as MessageEvent<RpcResponse>);
  }
}

describe("AdapterClient pin events", () => {
  it("routes pinChange events only to pin listeners, and stateChange only to state listeners", () => {
    const worker = new FakeWorker();
    const client = new AdapterClient(worker as unknown as Worker);

    const stateCb = vi.fn();
    const pinCb = vi.fn();
    client.onStateChange(stateCb);
    client.onPinChange(pinCb);

    worker.emit({ event: "pinChange", pin: "B5", value: 1 });
    worker.emit({ event: "stateChange", state: { running: true, cycles: 42 } });

    expect(pinCb).toHaveBeenCalledTimes(1);
    expect(pinCb).toHaveBeenCalledWith("B5", 1);
    expect(stateCb).toHaveBeenCalledTimes(1);
    expect(stateCb).toHaveBeenCalledWith({ running: true, cycles: 42 });
  });

  it("call() posts a subscribePin request and resolves on the matching response", async () => {
    const worker = new FakeWorker();
    const client = new AdapterClient(worker as unknown as Worker);

    const pending = client.call("subscribePin", { pin: "B5" });
    expect(worker.posted).toEqual([{ id: 1, method: "subscribePin", params: { pin: "B5" } }]);

    worker.emit({ id: 1, result: undefined });
    await expect(pending).resolves.toBeUndefined();
  });

  it("terminate() clears pin listeners too", () => {
    const worker = new FakeWorker();
    const client = new AdapterClient(worker as unknown as Worker);
    const pinCb = vi.fn();
    client.onPinChange(pinCb);

    client.terminate();
    worker.emit({ event: "pinChange", pin: "B5", value: 1 });

    expect(pinCb).not.toHaveBeenCalled();
  });
});
