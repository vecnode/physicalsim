// ============================================================================
// rp2040_toolchain.hpp
//
// Compiles a sketch (setup()/loop(), using pico-sdk's own C API - gpio_put(),
// sleep_ms(), not Arduino's digitalWrite()/delay() - see the "RP2040 firmware
// pipeline" section of ARCHITECTURE.md for why this is pico-sdk-native, not
// Arduino-API-compatible, and what a future full Arduino-API layer
// (earlephilhower/arduino-pico) would additionally need) into a raw flash
// binary for the RP2040 (Arduino Nano RP2040 Connect), using a bundled/system
// arm-none-eabi-gcc + a vendored pico-sdk (simulators/pico-sdk), driven
// through pico-sdk's own CMake build - unlike avr_toolchain.cpp's flat
// "invoke gcc per file" approach, pico-sdk's build genuinely needs CMake
// (it auto-generates several headers, e.g. pico/config_autogen.h, and the
// boot stage-2 bootloader needs a specific checksummed-assembly build step -
// see ARCHITECTURE.md for how this was discovered).
//
// The resulting bytes are meant to be fed through Rp2040Adapter.loadFirmware()
// - a raw binary image starting at flash offset 0, not Intel HEX (RP2040 has
// no such convention) and not UF2 (that's a USB-flashing container format,
// irrelevant to an emulator that can just write the array directly).
// ============================================================================
#pragma once

#include <filesystem>
#include <optional>
#include <string>

namespace rp2040toolchain {

struct CompileResult {
  bool ok = false;
  std::string binary;  // raw flash image bytes, only meaningful when ok
  std::string log;     // combined compiler/cmake output
};

// Locates arm-none-eabi-gcc and the vendored pico-sdk, the same bundled-
// next-to-executable-first, source-tree-fallback shape find_toolchain() in
// avr_toolchain.cpp already uses. Returns false (not an optional path pair)
// because the two toolchains have different-shaped internal state
// (pico-sdk's build is a persistent CMake project directory, not a set of
// include paths) - callers that just need a yes/no before offering RP2040 as
// a compile target should use this instead of running a full compile to find
// out.
bool toolchain_available();

// Compiles one sketch's source text (setup()/loop() bodies, pico-sdk API) for
// the Arduino Nano RP2040 Connect. The first call for a given physicalsim
// process configures a persistent CMake build directory (a few seconds);
// later calls reuse it (ninja incremental rebuild - only the changed
// sketch.c needs recompiling). Synchronous, like avr_toolchain.cpp's
// compile_sketch() - callers on the HTTP server's request thread should
// expect to block. Not reentrant across concurrent calls (guarded by an
// internal mutex - a second /compile request for this board queues behind
// the first rather than racing the shared build directory).
CompileResult compile_sketch(const std::string &source);

}  // namespace rp2040toolchain
