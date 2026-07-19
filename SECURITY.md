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

## Windows deployment baseline

Windows is the reference platform for this workspace. For Windows builds:

- Compile with `/W4`, `/permissive-`, `/sdl`, and Control Flow Guard when supported.
- Link with `/DYNAMICBASE`, `/NXCOMPAT`, `/HIGHENTROPYVA`, and `/GUARD:CF` when supported.
- Sign release binaries before distribution.
- Run the app as a standard user, not as Administrator.
- Package only the executable, embedded assets, and the WebView2 runtime dependency.

## C++ rules for this app

- Prefer RAII for every handle, thread, and file resource.
- Avoid raw pointers for ownership.
- Validate all network input even if the server is loopback-only.
- Reject oversized payloads and add tight read/write timeouts.
- Keep the attack surface small: no dynamic code loading, no plugin discovery, no arbitrary file execution.
- Fail closed if a security-sensitive prerequisite is missing.

## Review checkpoint

Any change that adds a new endpoint, filesystem write path, external dependency, or browser capability should be reviewed against these rules before release.

## Release security TODOs

- [ ] Code-sign the executable and bundled DLLs.
- [ ] Ship checksums (SHA-256) and verify before distribution.
- [ ] Disable console in release unless needed (INCLUDE_TERMINAL_ON_RELEASE).
- [ ] Keep binding local-only (`src/main.cpp`, `bind_to_any_port("127.0.0.1")`).
- [ ] Keep strict response headers and request limits (`src/main.cpp`: timeout/header/payload settings).
- [ ] Keep CSP strict in frontend (`public/index.html`).
- [ ] Build from clean CI and archive build provenance (commit, toolchain, hashes).
- [ ] Run dependency updates regularly for FetchContent dependencies (`CMakeLists.txt`).