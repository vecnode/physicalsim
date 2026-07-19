// Shared registry of adapter Worker clients. Both the UI (main.ts) and the
// native bridge (native-bridge.ts) go through this so they observe and
// drive the exact same running simulator instances, not separate ones.

import { AdapterClient } from "./worker-rpc.js";
import { notifyNative } from "./native-notify.js";

export type AdapterId = "rp2040" | "avr8";

function createWorker(id: AdapterId): Worker {
  if (id === "rp2040") {
    return new Worker(
      new URL("../../adapters/rp2040/src/worker.ts", import.meta.url),
      { type: "module" },
    );
  }
  return new Worker(
    new URL("../../adapters/avr8/src/worker.ts", import.meta.url),
    { type: "module" },
  );
}

const clients = new Map<AdapterId, AdapterClient>();

// Each adapter already caps how often it emits a stateChange while running
// (see EMIT_INTERVAL_MS in adapter.ts — that's what keeps the UI responsive
// no matter how long a run goes on). This second throttle is specifically
// for the native<->JS bridge: every event forwarded to native round-trips
// through webview eval()/bind() on the UI thread, and even the
// adapter-level rate is enough to starve a freshly-dispatched
// dispatch_bridge_call() in src/main.cpp long enough to time out.
const NATIVE_FORWARD_INTERVAL_MS = 200;
const lastForwardedAt = new Map<AdapterId, number>();

// Lazily creates (and reuses) the Worker + RPC client for an adapter. The
// worker keeps running once created, independent of what the UI happens to
// have selected — that's what lets the native bridge drive one adapter
// while the UI is looking at another.
export function getAdapterClient(id: AdapterId): AdapterClient {
  let client = clients.get(id);
  if (!client) {
    client = new AdapterClient(createWorker(id));
    client.onStateChange((state) => {
      const now = Date.now();
      const last = lastForwardedAt.get(id) ?? 0;
      if (now - last < NATIVE_FORWARD_INTERVAL_MS && state.running) {
        return;
      }
      lastForwardedAt.set(id, now);
      notifyNative({ event: "stateChange", adapter: id, state });
    });
    clients.set(id, client);
  }
  return client;
}
