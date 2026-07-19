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

// A running adapter emits a stateChange roughly every tick (see
// STEPS_PER_TICK in each adapter.ts) — effectively continuously. Each one
// forwarded to native round-trips through webview eval()/bind() on the UI
// thread; forwarding every single event floods that channel and can starve
// new dispatch_bridge_call()s in src/main.cpp long enough to time out. The
// UI's own onStateChange subscribers (main.ts) still get every event —
// only the native forwarding is throttled, since only that goes through
// the native round trip.
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
