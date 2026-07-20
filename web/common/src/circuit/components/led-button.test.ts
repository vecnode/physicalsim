import { describe, expect, it } from "vitest";
import { CircuitPin, type PinClient } from "../circuit-pin.js";
import { Led } from "./led.js";
import { Button } from "./button.js";

class FakePinClient implements PinClient {
  values = new Map<string, number>();
  private pinChangeListeners = new Set<(pin: string, value: number) => void>();

  async call(method: string, params?: unknown): Promise<unknown> {
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
    if (method === "subscribePin") return undefined;
    throw new Error(`unexpected method "${method}"`);
  }

  onPinChange(cb: (pin: string, value: number) => void): () => void {
    this.pinChangeListeners.add(cb);
    return () => this.pinChangeListeners.delete(cb);
  }
}

// Node's promise microtask queue needs a tick to flush before assertions
// that depend on Led's constructor-time pin.read() having resolved.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Led + Button", () => {
  it("Led reflects a Button wired to the same pin", async () => {
    const client = new FakePinClient();
    const led = new Led(new CircuitPin(client, "B5"));
    const button = new Button(new CircuitPin(client, "B5"));

    await flush();
    expect(led.isOn).toBe(false);

    await button.press();
    expect(led.isOn).toBe(true);

    await button.release();
    expect(led.isOn).toBe(false);
  });

  it("Led picks up the pin's current value on construction", async () => {
    const client = new FakePinClient();
    client.values.set("B5", 1);

    const led = new Led(new CircuitPin(client, "B5"));
    await flush();

    expect(led.isOn).toBe(true);
  });

  it("Led.dispose() stops tracking further changes", async () => {
    const client = new FakePinClient();
    const led = new Led(new CircuitPin(client, "B5"));
    const button = new Button(new CircuitPin(client, "B5"));
    await flush();

    led.dispose();
    await button.press();

    expect(led.isOn).toBe(false);
  });
});
