// Shared registry of adapter Worker clients. Both the UI (main.ts) and the
// native bridge (native-bridge.ts) go through this so they observe and
// drive the exact same running simulator instances, not separate ones.

import type { AdapterMethod, SimState } from "@physicalsim/common";
import { AdapterClient } from "./worker-rpc.js";
import { NativeAdapterClient } from "./native-adapter-client.js";
import { notifyNative } from "./native-notify.js";

export type AdapterId = "rp2040" | "avr8" | "cortex-m";

// Structural interface both AdapterClient (Worker-backed) and
// NativeAdapterClient (native-process-backed, see that file) satisfy.
// main.ts drives whatever getAdapterClient() hands back through this
// shape without needing to know which kind it got.
export interface SimClient {
  call(method: AdapterMethod, params?: unknown): Promise<unknown>;
  onStateChange(cb: (state: SimState) => void): () => void;
}

// Adapters with no JS/Worker side at all - the C++ shell spawns and
// controls these directly (see src/qemu_adapter.hpp). Reached only
// through the HTTP bridge, never postMessage.
const NATIVE_ADAPTER_IDS = new Set<AdapterId>(["cortex-m"]);

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

// Lazily creates (and reuses) a client for an adapter - a Worker+RPC
// client for JS/TS adapters, or an HTTP-polling client for native
// (QEMU-backed) ones. Either way it keeps running once created,
// independent of what the UI happens to have selected — that's what lets
// the native bridge drive one adapter while the UI is looking at another.
export function getAdapterClient(id: AdapterId): SimClient {
  let client = clients.get(id);
  if (!client) {
    if (NATIVE_ADAPTER_IDS.has(id)) {
      // No JS side to forward state from here: src/qemu_adapter.cpp
      // already writes straight into the same g_bridge_latest_state map
      // that notifyNative() below exists to populate for Worker
      // adapters, so there's nothing for this client to forward.
      client = new NativeAdapterClient(id);
    } else {
      const workerClient = new AdapterClient(createWorker(id));
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
    }
    clients.set(id, client);
  }
  return client;
}
