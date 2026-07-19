// JS-side half of the native<->JS bridge. The C++ shell (src/main.cpp)
// calls window.physicalsimBridge.dispatch(...) via webview eval() to drive
// an adapter, and this replies asynchronously through window.physicalsimReply
// (a webview bind(), see native-notify.ts). Adapter state-change events are
// pushed the same way, independent of any dispatch call — see
// adapter-registry.ts.
//
// Imported for its side effect (registering window.physicalsimBridge);
// harmless to import in a plain browser tab, since notifyNative() no-ops
// there.

import type { AdapterMethod } from "@physicalsim/common";
import { getAdapterClient, type AdapterId } from "./adapter-registry.js";
import { notifyNative } from "./native-notify.js";

interface BridgeRequest {
  id: number;
  adapter: AdapterId;
  method: AdapterMethod;
  params?: unknown;
}

async function handleDispatch(req: BridgeRequest): Promise<void> {
  try {
    const client = getAdapterClient(req.adapter);
    const result = await client.call(req.method, req.params);
    notifyNative({ id: req.id, result: result ?? null });
  } catch (err) {
    notifyNative({ id: req.id, error: err instanceof Error ? err.message : String(err) });
  }
}

declare global {
  interface Window {
    physicalsimBridge: {
      dispatch(req: BridgeRequest): void;
    };
  }
}

window.physicalsimBridge = {
  dispatch(req: BridgeRequest): void {
    void handleDispatch(req);
  },
};
