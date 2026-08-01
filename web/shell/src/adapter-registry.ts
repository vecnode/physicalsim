// Shared registry of adapter Worker clients. Both the UI (main.ts) and the
// native bridge (native-bridge.ts) go through this so they observe and
// drive the exact same running simulator instances, not separate ones.

import type { AdapterMethod, SimState } from "@physicalsim/common";
import { AdapterClient } from "./worker-rpc.js";
import { notifyNative } from "./native-notify.js";

// "avr8-mega" is a second worker entry point for the exact same
// Avr8Adapter class (adapters/avr8/src/adapter.ts), constructed with the
// ATMEGA2560 chip config instead of the default atmega328p one - a
// distinct AdapterId, not a parameter on "avr8", because every client
// here is cached one-per-id (see getAdapterClient() below): two boards
// sharing an id already share one running CPU (arduino-uno and
// arduino-nano do this today, deliberately - see boardAdapterId in
// circuit.ts), which is correct for two boards that are the *same* chip
// but would silently corrupt a Mega's much larger port/flash state if an
// Uno shared it too. "avr8-attiny85" (Franzininho, chip.ts's ATTINY85)
// and "avr8-leonardo" (Arduino Leonardo, chip.ts's ATMEGA32U4) are the
// same pattern a third and fourth time - genuinely different chips, not
// a parameter on "avr8".
export type AdapterId =
  | "rp2040"
  | "rp2040-js"
  | "avr8"
  | "avr8-js"
  // Own adapter id, not "avr8-js" - Mega's 54 digital + 16 analog pins
  // need a bigger ArduinoRuntime, and clients are cached one per id (see
  // getAdapterClient() below), so sharing "avr8-js" would mean an Uno
  // and a Mega fight over one runtime shaped for neither of them.
  | "avr8-js-mega"
  | "avr8-mega"
  | "avr8-attiny85"
  | "avr8-leonardo"
  | "esp32";

// Structural interface AdapterClient (Worker-backed) satisfies. main.ts
// drives whatever getAdapterClient() hands back through this shape.
export interface SimClient {
  call(method: AdapterMethod, params?: unknown): Promise<unknown>;
  onStateChange(cb: (state: SimState) => void): () => void;
  // Mandatory - every registered adapter's pin I/O is a real, working
  // capability (adapter-types.ts), delivered via real postMessage push.
  onPinChange(cb: (pin: string, value: number) => void): () => void;
  // Optional - only avr8 and esp32 have a Serial/UART peripheral wired up
  // so far (rp2040 doesn't yet).
  onSerialData?(cb: (byte: number) => void): () => void;
  // Optional - no adapter has an I2C bus wired up for esp32/rp2040 yet
  // (only avr8 does, via i2c-bus.ts).
  onI2CFrame?(cb: (device: string, data: Uint8Array) => void): () => void;
}

function createWorker(id: AdapterId): Worker {
  if (id === "rp2040") {
    return new Worker(
      new URL("../../adapters/rp2040/src/worker.ts", import.meta.url),
      { type: "module" },
    );
  }
  if (id === "rp2040-js") {
    return new Worker(
      new URL("../../adapters/rp2040-js/src/worker.ts", import.meta.url),
      { type: "module" },
    );
  }
  if (id === "esp32") {
    return new Worker(
      new URL("../../adapters/esp32/src/worker.ts", import.meta.url),
      { type: "module" },
    );
  }
  if (id === "avr8-js") {
    return new Worker(
      new URL("../../adapters/avr8-js/src/worker.ts", import.meta.url),
      { type: "module" },
    );
  }
  if (id === "avr8-js-mega") {
    return new Worker(
      new URL("../../adapters/avr8-js/src/worker-mega.ts", import.meta.url),
      { type: "module" },
    );
  }
  if (id === "avr8-mega") {
    return new Worker(
      new URL("../../adapters/avr8/src/worker-mega.ts", import.meta.url),
      { type: "module" },
    );
  }
  if (id === "avr8-attiny85") {
    return new Worker(
      new URL("../../adapters/avr8/src/worker-attiny85.ts", import.meta.url),
      { type: "module" },
    );
  }
  if (id === "avr8-leonardo") {
    return new Worker(
      new URL("../../adapters/avr8/src/worker-leonardo.ts", import.meta.url),
      { type: "module" },
    );
  }
  return new Worker(
    new URL("../../adapters/avr8/src/worker.ts", import.meta.url),
    { type: "module" },
  );
}

const clients = new Map<AdapterId, SimClient>();

// Each adapter already caps how often it emits a stateChange while running
// (see EMIT_INTERVAL_MS in adapter.ts — that's what keeps the UI responsive
// no matter how long a run goes on). This second throttle is specifically
// for the native<->JS bridge: every event forwarded to native round-trips
// through webview eval()/bind() on the UI thread, and even the
// adapter-level rate is enough to starve a freshly-dispatched
// dispatch_bridge_call() in src/main.cpp long enough to time out.
const NATIVE_FORWARD_INTERVAL_MS = 200;
const lastForwardedAt = new Map<AdapterId, number>();

// Lazily creates (and reuses) a Worker+RPC client for an adapter - keeps
// running once created, independent of what the UI happens to have
// selected — that's what lets the native bridge drive one adapter while
// the UI is looking at another.
export function getAdapterClient(id: AdapterId): SimClient {
  let client = clients.get(id);
  if (!client) {
    const workerClient = new AdapterClient(createWorker(id));
    // Worker-backed adapters need init() before anything beyond the raw
    // CPU works - avr8's attachPeripherals() (which sets up the GPIO
    // ports readPin/writePin/onPinChange depend on) only runs from
    // there, not from the constructor. Safe to fire without awaiting:
    // postMessage delivers to the worker in order, so every call queued
    // after this one is guaranteed to be handled after init() completes
    // (see worker-host.ts's message handler).
    void workerClient.call("init", undefined);
    workerClient.onStateChange((state) => {
      const now = Date.now();
      const last = lastForwardedAt.get(id) ?? 0;
      if (now - last < NATIVE_FORWARD_INTERVAL_MS && state.running) {
        return;
      }
      lastForwardedAt.set(id, now);
      notifyNative({ event: "stateChange", adapter: id, state });
    });
    client = workerClient;
    clients.set(id, client);
  }
  return client;
}
