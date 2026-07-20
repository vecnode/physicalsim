import { beforeEach, describe, expect, it } from "vitest";
import { CircuitPin, Led, hostAdapter, type PinClient } from "@physicalsim/common";
import type { RpcRequest, RpcResponse } from "@physicalsim/common";
import { Avr8Adapter } from "./adapter.js";

// Drives Avr8Adapter through the exact same hostAdapter() dispatch path a
// real Worker would use, minus the Worker itself - proves the pin pipeline
// (CircuitPin -> PinClient -> RPC dispatch -> adapter) works end-to-end for
// a real adapter, not just fakes.
function inProcessAdapterClient(): PinClient {
  const listeners: Array<(ev: MessageEvent<RpcRequest>) => void> = [];
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const pinChangeListeners = new Set<(pin: string, value: number) => void>();
  let nextId = 1;

  (globalThis as any).self = {
    addEventListener: (_type: string, cb: (ev: MessageEvent<RpcRequest>) => void) => {
      listeners.push(cb);
    },
  };
  (globalThis as any).postMessage = (msg: RpcResponse) => {
    if ("event" in msg) {
      if (msg.event === "pinChange") {
        for (const listener of pinChangeListeners) listener(msg.pin, msg.value);
      }
      return;
    }
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if ("error" in msg) entry.reject(new Error(msg.error));
    else entry.resolve(msg.result);
  };

  hostAdapter(new Avr8Adapter());

  return {
    call(method, params) {
      const id = nextId++;
      const request: RpcRequest = { id, method, params };
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        for (const cb of listeners) void cb({ data: request } as MessageEvent<RpcRequest>);
      });
    },
    onPinChange(cb) {
      pinChangeListeners.add(cb);
      return () => pinChangeListeners.delete(cb);
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Led wired to a real Avr8Adapter", () => {
  let client: PinClient;

  beforeEach(async () => {
    client = inProcessAdapterClient();
    await client.call("init", undefined);
  });

  it("tracks the AVR pin's value as it's driven externally", async () => {
    const led = new Led(new CircuitPin(client, "B5"));
    await flush();
    expect(led.isOn).toBe(false);

    await client.call("writePin", { pin: "B5", value: 1 });
    expect(led.isOn).toBe(true);

    await client.call("writePin", { pin: "B5", value: 0 });
    expect(led.isOn).toBe(false);
  });
});
