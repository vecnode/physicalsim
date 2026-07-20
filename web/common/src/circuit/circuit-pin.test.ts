import { describe, expect, it, vi } from "vitest";
import { CircuitPin, type PinClient } from "./circuit-pin.js";
import { arduinoUno } from "../boards/arduino-uno.js";

// In-memory fake client: a pin value map plus manual event firing, so
// components can be tested without any real adapter or worker.
class FakePinClient implements PinClient {
  values = new Map<string, number>();
  private pinChangeListeners = new Set<(pin: string, value: number) => void>();
  calls: Array<{ method: string; params?: unknown }> = [];

  async call(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "readPin") {
      const { pin } = params as { pin: string };
      return this.values.get(pin) ?? 0;
    }
    if (method === "writePin") {
      const { pin, value } = params as { pin: string; value: number };
      this.values.set(pin, value);
      for (const listener of this.pinChangeListeners) listener(pin, value);
      return undefined;
    }
    if (method === "subscribePin") {
      return undefined;
    }
    throw new Error(`FakePinClient: unexpected method "${method}"`);
  }

  onPinChange(cb: (pin: string, value: number) => void): () => void {
    this.pinChangeListeners.add(cb);
    return () => this.pinChangeListeners.delete(cb);
  }

  // Simulates a value change that didn't originate from this client's own
  // writePin (e.g. firmware driving an output pin).
  emitExternalChange(pin: string, value: number): void {
    this.values.set(pin, value);
    for (const listener of this.pinChangeListeners) listener(pin, value);
  }
}

describe("CircuitPin", () => {
  it("read()/write() round-trip through the client", async () => {
    const client = new FakePinClient();
    const pin = new CircuitPin(client, "B5");

    expect(await pin.read()).toBe(0);
    await pin.write(1);
    expect(await pin.read()).toBe(1);
  });

  it("onChange() subscribes once and filters events to its own pin", async () => {
    const client = new FakePinClient();
    const pinB5 = new CircuitPin(client, "B5");
    const pinB6 = new CircuitPin(client, "B6");

    const cbB5 = vi.fn();
    pinB5.onChange(cbB5);
    pinB5.onChange(vi.fn()); // second subscribe on the same pin - no double subscribePin call

    client.emitExternalChange("B6", 1); // different pin - shouldn't fire cbB5
    client.emitExternalChange("B5", 1);

    expect(cbB5).toHaveBeenCalledTimes(1);
    expect(cbB5).toHaveBeenCalledWith(1);
    expect(client.calls.filter((c) => c.method === "subscribePin")).toHaveLength(1);
    void pinB6; // referenced only to construct it
  });

  it("forBoardPin() resolves a board silkscreen name to the adapter pin id", async () => {
    const client = new FakePinClient();
    const pin = CircuitPin.forBoardPin(client, arduinoUno, "D13");

    expect(pin.pin).toBe("B5");
    await pin.write(1);
    expect(client.values.get("B5")).toBe(1);
  });

  it("onChange() throws for a client that doesn't support pin-change events", () => {
    const client: PinClient = {
      call: vi.fn(async () => undefined),
    };
    const pin = new CircuitPin(client, "B5");
    expect(() => pin.onChange(vi.fn())).toThrow(/does not support pin-change/);
  });
});
