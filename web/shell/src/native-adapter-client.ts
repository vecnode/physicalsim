// Client for a *native-backed* adapter (e.g. "cortex-m", "esp32") - one the
// C++ shell spawns and controls directly (see src/qemu_adapter.{hpp,cpp},
// src/esp32_qemu_adapter.{hpp,cpp}), not a Worker running JS/TS. There is
// no postMessage channel to this kind of adapter at all, so this talks to
// the same HTTP bridge surface external callers use (POST
// /bridge/:adapter/:method, GET /bridge/:adapter/state) directly from the
// page itself - same origin as this page is served from, no CORS involved.
//
// Structurally implements the same shape as worker-rpc.ts's
// AdapterClient (call/onStateChange) so adapter-registry.ts can hand
// either one back to the UI without it needing to know which kind it got.

import type { AdapterMethod, SimState } from "@physicalsim/common";

const POLL_INTERVAL_MS = 200;

interface BridgeHttpResult {
  result?: unknown;
  error?: string;
}

// Implements SimClient's optional onPinChange by polling readPin for every
// subscribed pin on the same timer that already polls adapter state - the
// native bridge has no push channel from the C++ process into the page
// (unlike a Worker's postMessage), so polling is the only option here.
// Not implemented until now because no native adapter had real per-pin
// state worth polling: cortex-m's QemuInstance still stubs readPin as
// unsupported (see src/qemu_adapter.hpp); esp32_qemu_adapter.hpp's
// readPin() is the first one that actually returns live state, and
// wiring an LED to it with no push channel at all left the LED showing a
// single stale snapshot from the moment it was wired, never updating
// again - found while checking the "GPIO Blink (ESP32)" example's LEDs
// didn't visually blink even with the adapter genuinely running.
export class NativeAdapterClient {
  private stateListeners = new Set<(state: SimState) => void>();
  private pinListeners = new Set<(pin: string, value: number) => void>();
  private subscribedPins = new Set<string>();
  private lastPinValues = new Map<string, number>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly adapterId: string) {}

  async call(method: AdapterMethod, params?: unknown): Promise<unknown> {
    // subscribePin has no native-side handler at all (main.cpp's
    // handle_qemu_bridge_call has no "subscribePin" case - polling below
    // does the equivalent job from the client side) - sending it to the
    // server would just get "Unknown method" back and throw, so this is
    // handled entirely locally, before any fetch, not just tolerated
    // after the fact. CircuitPin.onChange() still calls it unconditionally
    // (the same shape a Worker-backed client needs), fire-and-forget
    // (`void this.client.call(...)`) - a throw here would otherwise become
    // a silent unhandled rejection with no visible symptom beyond "the pin
    // never updates", exactly what this was caught missing.
    if (method === "subscribePin" && params && typeof params === "object" && "pin" in params) {
      this.subscribedPins.add((params as { pin: string }).pin);
      this.ensurePolling();
      return null;
    }

    const res = await fetch(`/bridge/${this.adapterId}/${method}`, {
      method: "POST",
      body: params === undefined ? undefined : JSON.stringify(params),
    });
    const body = (await res.json()) as BridgeHttpResult;
    if (!res.ok || body.error !== undefined) {
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    return body.result;
  }

  onStateChange(cb: (state: SimState) => void): () => void {
    this.stateListeners.add(cb);
    this.ensurePolling();
    return () => {
      this.stateListeners.delete(cb);
      this.stopPollingIfIdle();
    };
  }

  onPinChange(cb: (pin: string, value: number) => void): () => void {
    this.pinListeners.add(cb);
    this.ensurePolling();
    return () => {
      this.pinListeners.delete(cb);
      this.stopPollingIfIdle();
    };
  }

  private ensurePolling(): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  private stopPollingIfIdle(): void {
    if (this.stateListeners.size > 0 || this.pinListeners.size > 0) return;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async poll(): Promise<void> {
    try {
      const res = await fetch(`/bridge/${this.adapterId}/state`);
      if (res.ok) {
        const state = (await res.json()) as SimState;
        for (const listener of this.stateListeners) listener(state);
      }
    } catch {
      // Transient fetch failure (e.g. adapter not started yet) - next
      // poll tick retries, nothing to surface here.
    }

    // Sequential, not Promise.all - deliberately simple for however many
    // pins a real circuit wires up today (a handful of LEDs); worth
    // revisiting if a circuit ever subscribes to enough pins for
    // per-poll-tick latency to matter.
    for (const pin of this.subscribedPins) {
      try {
        const value = (await this.call("readPin", { pin })) as number;
        if (this.lastPinValues.get(pin) !== value) {
          this.lastPinValues.set(pin, value);
          for (const listener of this.pinListeners) listener(pin, value);
        }
      } catch {
        // Same "transient failure, next tick retries" posture as the
        // state poll above.
      }
    }
  }
}
