// Fire-and-forget channel back to the native (C++) shell, when present.
// window.physicalsimReply is injected by webview's bind() only when this
// page is running inside the physicalsim webview window/headless host; a
// plain browser tab simply has no such function, and calls become no-ops.
// This is what keeps the shell loading identically in both targets.

declare global {
  interface Window {
    physicalsimReply?: (payload: unknown) => unknown;
  }
}

export function notifyNative(payload: Record<string, unknown>): void {
  if (typeof window.physicalsimReply === "function") {
    window.physicalsimReply(payload);
  }
}
