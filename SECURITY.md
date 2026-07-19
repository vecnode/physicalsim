# Security and Deployment Rules

This repository is a desktop app that hosts a local HTTP server and renders a webview UI. Treat it as a local-only application, not as a browser sandbox or an internet-facing service.

## Hard requirements

- Bind the server to `127.0.0.1` only.
- Do not expose the server on `0.0.0.0`, public interfaces, or forwarded ports.
- Keep the UI assets embedded or served from the application bundle only.
- Do not load remote scripts, styles, or plugins at runtime.
- Do not execute shell commands from user input.
- Do not write user-controlled paths outside the app's own output directory.
- Cap request sizes and timeouts for every local endpoint.
- Ship Release builds only for distribution.

