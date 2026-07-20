// Client for a *native-backed* adapter (e.g. "cortex-m") - one the C++
// shell spawns and controls directly (see src/qemu_adapter.{hpp,cpp}),
// not a Worker running JS/TS. There is no postMessage channel to this
// kind of adapter at all, so this talks to the same HTTP bridge surface
// external callers use (POST /bridge/:adapter/:method,
// GET /bridge/:adapter/state) directly from the page itself - same
// origin as this page is served from, no CORS involved.
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

export class NativeAdapterClient {
  private listeners = new Set<(state: SimState) => void>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly adapterId: string) {}

  async call(method: AdapterMethod, params?: unknown): Promise<unknown> {
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

  // No push channel from a native process into the page - polls
  // GET /bridge/:adapter/state instead, only while there's at least one
  // subscriber.
  onStateChange(cb: (state: SimState) => void): () => void {
    this.listeners.add(cb);
    this.ensurePolling();
    return () => {
      this.listeners.delete(cb);
      if (this.listeners.size === 0) this.stopPolling();
    };
  }

  private ensurePolling(): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async poll(): Promise<void> {
    try {
      const res = await fetch(`/bridge/${this.adapterId}/state`);
      if (!res.ok) return;
      const state = (await res.json()) as SimState;
      for (const listener of this.listeners) listener(state);
    } catch {
      // Transient fetch failure (e.g. adapter not started yet) - next
      // poll tick retries, nothing to surface here.
    }
  }
}
