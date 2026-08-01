# physicalsim

Native desktop PComp simulator host.

Every AVR and RP2040 board runs a **JS/TS-native sketch runtime** - no
C/C++ compiler, no vendored Arduino/pico-sdk core. Sketches are
interpreted directly, staying faithful to the real hardware APIs (Arduino's
`pinMode`/`digitalWrite`/`Serial`/`LiquidCrystal`, pico-sdk's
`gpio_init`/`gpio_put`/`sleep_ms`) - same names, same semantics, just JS/TS
syntax instead of compiled C++. ESP32 is the one board family still
compiling for real, via a vendored `esp-idf` (a JS-native ESP-IDF-shaped
runtime is a planned follow-up - see [ARCHITECTURE.md](ARCHITECTURE.md)).

Emulators:

- `vecnode/avr8js` (CPU core + `arduino/` JS-native sketch runtime)
	- Arduino Uno
  - Arduino Nano
  - Arduino Mega
  - Franzininho (ATtiny85)
  - Arduino Leonardo (ATmega32u4)

- `vecnode/rp2040js` (CPU core + `pico/` JS-native sketch runtime)
  - Raspberry Pi Pico
  - Raspberry Pi Pico W
  - Arduino Nano RP2040 Connect

- `vecnode/esp32js`
  - ESP32 DevKit V1
  - ESP32 DevKit C V4
  - ESP32-CAM

Find supported components here: [COMPONENTS.md](COMPONENTS.md)


## Dependencies

Vendored as git submodules (`simulators/`) and distributed with the app -
every one is a `vecnode` fork, kept current with (or ahead of) its
upstream:

* [vecnode/avr8js](https://github.com/vecnode/avr8js)
* [vecnode/rp2040js](https://github.com/vecnode/rp2040js)
* [vecnode/esp32js](https://github.com/vecnode/esp32js)
* [vecnode/wokwi-elements](https://github.com/vecnode/wokwi-elements)
* [vecnode/esp-idf](https://github.com/vecnode/esp-idf) - ESP32's real
  compile step only; every other board's sketch runtime is pure JS/TS,
  no vendored C/C++ Arduino/pico-sdk core needed

## Reproduce

```sh
# -----------------------------
# One-time / after pulling
# -----------------------------
# Pulls every vendored dependency, including simulators/esp-idf - ESP32 is
# a first-class supported board, not an opt-in extra, so this one command
# is enough to build and run every board out of the box.
git submodule update --init --recursive

# Optional: esp-idf's own nested submodules (mbedtls, bt, cmock, etc.) come
# down at full history above - if you want them shallow instead:
cd simulators/esp-idf && git submodule update --init --recursive --depth 1 && cd ../..

# -----------------------------
# Windows (manual dev flow)
# -----------------------------
cd web && npm install && npm run build && cd ..
cmake -B build

# Debug build + run
cmake --build build --target physicalsim -j --config Debug
.\build\Debug\physicalsim.exe

# Release build + run
cmake --build build --target physicalsim -j --config Release
.\build\Release\physicalsim.exe

# Headless (server only, no window; prints the bound port, exits on Ctrl-C)
.\build\Debug\physicalsim.exe --headless

# -----------------------------
# Windows helper scripts
# -----------------------------

# npm build + configure + build Debug + run
.\build_and_run.bat

# One-command portable package to Desktop\Release
# (always bundles a fixed WebView2 runtime)
.\package_release.bat

# -----------------------------
# Linux
# -----------------------------
cd web && npm install && npm run build && cd ..
cmake -B build

# Debug build + run
cmake --build build --target physicalsim -j --config Debug
./build/physicalsim

# Release build + run
cmake --build build --target physicalsim -j --config Release
./build/physicalsim

# Headless
./build/physicalsim --headless
```

### Web/ development

```sh
cd web
npm install
npm run dev          # Vite dev server with HMR, for iterating on the shell UI
npm run build         # production build -> ../public (embedded by CMake)
npm run typecheck     # tsc --noEmit across common/adapters/shell
```


## Native <-> JS bridge

```sh
# Start/stop/step/reset an adapter. Body is a JSON params object (or empty).
curl -X POST http://127.0.0.1:<port>/bridge/rp2040/start
curl -X POST http://127.0.0.1:<port>/bridge/rp2040/step -d '5'
curl -X POST http://127.0.0.1:<port>/bridge/rp2040/stop

# Last known state (from the adapter's own stateChange events)
curl http://127.0.0.1:<port>/bridge/rp2040/state

# esp32 works over the exact same surface - a Worker running esp32js,
# same as every other adapter
curl -X POST http://127.0.0.1:<port>/bridge/esp32/start
curl http://127.0.0.1:<port>/bridge/esp32/state
```


## Dependencies

Build/runtime prerequisites:

- CMake 3.20+
- C++20 compiler
	- Windows: Visual Studio 2022 Build Tools (MSVC)
	- Linux: GCC or Clang with C++20 support
- Node.js 18+ and npm (for `web/`)
- Git (required because CMake `FetchContent` downloads several dependencies
  from Git repositories, and `simulators/` are git submodules)
- Internet access during initial configure/build (to download dependencies)
- Windows runtime:
	- Microsoft Edge WebView2 Runtime
- Linux runtime/build libs (webview GTK backend):
	- GTK 3 development files
	- WebKit2GTK development files

Downloaded automatically at configure/build time (`FetchContent`):

- `yhirose/cpp-httplib`
	- https://github.com/yhirose/cpp-httplib
- `webview/webview`
	- https://github.com/webview/webview
- `yhirose/cpp-embedlib`
	- https://github.com/yhirose/cpp-embedlib
- `nlohmann/json`
	- https://github.com/nlohmann/json

## License

Licensed under [Apache 2.0](./LICENSE).