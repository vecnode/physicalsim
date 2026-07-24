// ============================================================================
// avr_toolchain.hpp
//
// Compiles a real Arduino sketch (setup()/loop(), digitalRead/Write,
// Serial, etc.) into an Intel HEX image for Arduino Uno (ATmega328p),
// using a bundled/system avr-gcc, the vendored ArduinoCore-avr subset
// (simulators/ArduinoCore-avr - cores/arduino + variants/standard only),
// and whatever vendored Arduino libraries a sketch #includes (e.g.
// LiquidCrystal - simulators/LiquidCrystal, CMakeLists.txt's
// AVR_LIBRARIES list). No compiler ships inside physicalsim's own binary;
// this shells out to avr-gcc/avr-g++/avr-objcopy the same way
// qemu_adapter.cpp shells out to qemu-system-arm - see that file for the
// process-spawn pattern this mirrors.
//
// The resulting hex text is meant to be fed through the exact same path
// "Load .hex..." already uses (web/common/src/intel-hex.ts's
// parseIntelHex() -> SimulatorAdapter.loadFirmware()) - this file only
// ever produces bytes, it has no idea an avr8 adapter exists.
// ============================================================================
#pragma once

#include <filesystem>
#include <optional>
#include <string>
#include <vector>

namespace avrtoolchain {

struct ToolchainPaths {
  std::filesystem::path bin_dir;      // avr-gcc/avr-g++/avr-objcopy live here
  std::filesystem::path core_dir;     // ArduinoCore-avr's cores/arduino
  std::filesystem::path variant_dir;  // ArduinoCore-avr's variants/standard
  // One entry per vendored Arduino library (CMakeLists.txt's
  // AVR_LIBRARIES list, e.g. LiquidCrystal) that a sketch can #include -
  // each is that library's own src/ directory, added to both the
  // compiler's include path and the set of files compiled alongside the
  // sketch/core (see compile_sketch()). Not required to be non-empty:
  // a missing library is dropped with a warning in the log rather than
  // failing the whole compile, since most sketches don't need any of
  // them.
  std::vector<std::filesystem::path> library_dirs;
};

// Locates a usable avr-gcc toolchain and the vendored ArduinoCore-avr
// directories. Checks a bundled "avr-toolchain/bin" folder next to
// physicalsim's own executable first (CMake's BUNDLE_AVR_TOOLCHAIN option
// copies one there for packaged builds - see CMakeLists.txt), then PATH,
// then well-known Arduino IDE install locations (its own bundled
// avr-gcc). The core/variant directories are always looked for bundled
// next to the executable ("avr-core/", copied unconditionally by CMake -
// see CMakeLists.txt - since the vendored subset is small enough to
// always ship) with a source-tree fallback for dev builds run from the
// build directory. Returns nullopt if either half is missing anywhere.
std::optional<ToolchainPaths> find_toolchain();

struct CompileResult {
  bool ok = false;
  std::string hex_text;  // Intel HEX text, only meaningful when ok
  std::string log;       // combined compiler output from every step
};

// Compiles one sketch's source text (an .ino's body - setup()/loop(), no
// #include <Arduino.h> needed, this prepends it) for Arduino Uno. Runs
// entirely synchronously - several avr-gcc/avr-g++ invocations plus one
// avr-objcopy, a handful of seconds total. Callers on the HTTP server's
// request thread should expect to block for that long, the same as this
// project's other synchronous handlers.
//
// Deliberately no automatic function-prototype generation (the real
// Arduino IDE does this via a ctags step) - a sketch that calls a
// function before its definition needs a manual forward declaration.
// Documented v1 limitation, not solved here.
CompileResult compile_sketch(const std::string &source);

}  // namespace avrtoolchain
