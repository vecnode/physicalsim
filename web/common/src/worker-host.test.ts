import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcRequest, RpcResponse, SimState, SimulatorAdapter } from "./adapter-types.js";
import { hostAdapter } from "./worker-host.js";

// worker-host.ts runs inside a Worker and talks to the outside world via
// the global self.addEventListener/postMessage. Outside a real Worker
// (i.e. here, in Node) we fake just enough of that surface to drive it.
function installFakeWorkerGlobals() {
  const listeners: Array<(ev: MessageEvent<RpcRequest>) => void> = [];
  const posted: RpcResponse[] = [];

  (globalThis as any).self = {
    addEventListener: (_type: string, cb: (ev: MessageEvent<RpcRequest>) => void) => {
      listeners.push(cb);
    },
  };
  (globalThis as any).postMessage = (msg: RpcResponse) => {
    posted.push(msg);
  };

  return {
    posted,
    send: async (data: RpcRequest) => {
      for (const cb of listeners) await cb({ data } as MessageEvent<RpcRequest>);
    },
  };
}

function makeFakeAdapter(overrides: Partial<SimulatorAdapter> = {}): SimulatorAdapter {
  return {
    id: "fake",
    init: vi.fn(async () => undefined),
    start: vi.fn(),
    stop: vi.fn(),
    step: vi.fn(),
    reset: vi.fn(),
    onStateChange: vi.fn((_cb: (state: SimState) => void) => () => undefined),
    ...overrides,
  };
}

describe("hostAdapter pin dispatch", () => {
  let worker: ReturnType<typeof installFakeWorkerGlobals>;

  beforeEach(() => {
    worker = installFakeWorkerGlobals();
  });

  it("dispatches readPin to the adapter and returns its result", async () => {
    const readPin = vi.fn((pin: string) => (pin === "B5" ? 1 : 0));
    hostAdapter(makeFakeAdapter({ readPin }));

    await worker.send({ id: 1, method: "readPin", params: { pin: "B5" } });

    expect(readPin).toHaveBeenCalledWith("B5");
    expect(worker.posted).toEqual([{ id: 1, result: 1 }]);
  });

  it("dispatches writePin to the adapter", async () => {
    const writePin = vi.fn();
    hostAdapter(makeFakeAdapter({ writePin }));

    await worker.send({ id: 2, method: "writePin", params: { pin: "B5", value: 1 } });

    expect(writePin).toHaveBeenCalledWith("B5", 1);
    expect(worker.posted).toEqual([{ id: 2, result: undefined }]);
  });

  it("rejects readPin/writePin when the adapter doesn't implement them", async () => {
    hostAdapter(makeFakeAdapter());

    await worker.send({ id: 3, method: "readPin", params: { pin: "B5" } });

    expect(worker.posted).toEqual([
      { id: 3, error: 'Adapter "fake" does not support readPin' },
    ]);
  });

  it("subscribePin wires the adapter's onPinChange to a pinChange event, once per pin", async () => {
    let capturedCb: ((value: number) => void) | undefined;
    const unsubscribe = vi.fn();
    const onPinChange = vi.fn((_pin: string, cb: (value: number) => void) => {
      capturedCb = cb;
      return unsubscribe;
    });
    hostAdapter(makeFakeAdapter({ onPinChange }));

    await worker.send({ id: 4, method: "subscribePin", params: { pin: "B5" } });
    await worker.send({ id: 5, method: "subscribePin", params: { pin: "B5" } });

    expect(onPinChange).toHaveBeenCalledTimes(1);
    capturedCb?.(1);

    expect(worker.posted).toEqual([
      { id: 4, result: undefined },
      { id: 5, result: undefined },
      { event: "pinChange", pin: "B5", value: 1 },
    ]);
  });
});
