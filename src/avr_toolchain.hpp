// ============================================================================
// avr_toolchain.hpp
//
// Compiles a real Arduino sketch (setup()/loop(), digitalRead/Write,
// Serial, etc.) into an Intel HEX image - today, only for Franzininho
// (ATtiny85, its own core tree - see resolve_board_target() in the
// .cpp), using a bundled/system avr-gcc and the vendored ATTinyCore
// subset (simulators/ATTinyCore - avr/cores/tiny + avr/variants/
// tinyx5). Uno/Nano/Mega/Leonardo moved to a JS-native runtime
// (avr8js/arduino, web/adapters/avr8-js) with no C/C++ toolchain
// involved at all - this file's own ArduinoCore-avr/LiquidCrystal
// support for those boards was removed alongside that vendored core and
// library. No compiler ships inside physicalsim's own binary; this
// shells out to avr-gcc/avr-g++/avr-objcopy via process_exec.hpp's
// cross-platform spawn helper.
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
  std::filesystem::path core_dir;     // the resolved core tree's cores/<arduino|tiny>
  std::filesystem::path variant_dir;  // the resolved core tree's variants/<target's variant>
  // One entry per vendored Arduino library a sketch can #include - empty
  // today (LiquidCrystal was removed alongside ArduinoCore-avr; no
  // vendored library currently targets ATtiny85, the only board left
  // reaching this file). Kept as a list, not deleted outright, since
  // find_library_dirs()/compile_sketch() already handle "zero libraries"
  // correctly and a future ATtiny-compatible library is a one-line
  // addition to known_libraries(), not new plumbing.
  std::vector<std::filesystem::path> library_dirs;
};

// Locates a usable avr-gcc toolchain and the vendored ArduinoCore-avr
// directories for the given board (see resolve_board_target() in the
// .cpp for the board -> {mcu, variant} table; an unrecognized board
// string falls back to Arduino Uno's target the same way an empty one
// does). Checks a bundled "avr-toolchain/bin" folder next to
// physicalsim's own executable first (CMake's BUNDLE_AVR_TOOLCHAIN option
// copies one there for packaged builds - see CMakeLists.txt), then PATH,
// then well-known Arduino IDE install locations (its own bundled
// avr-gcc). The core/variant directories are always looked for bundled
// next to the executable ("avr-core/", copied unconditionally by CMake -
// see CMakeLists.txt - since the vendored subset is small enough to
// always ship) with a source-tree fallback for dev builds run from the
// build directory. Returns nullopt if either half is missing anywhere.
std::optional<ToolchainPaths> find_toolchain(const std::string &board);

struct CompileResult {
  bool ok = false;
  std::string hex_text;  // Intel HEX text, only meaningful when ok
  std::string log;       // combined compiler output from every step
};

// Compiles one sketch's source text (an .ino's body - setup()/loop(), no
// #include <Arduino.h> needed, this prepends it) for the given board
// (circuit.ts's CircuitBoard.type - "arduino-uno"/"arduino-nano"/
// "arduino-mega"/"franzininho" as of this addition; unrecognized or
// empty falls back to Arduino Uno, matching this function's original
// single-board behavior). Runs entirely synchronously - several avr-gcc/avr-g++
// invocations plus one avr-objcopy, a handful of seconds total. Callers
// on the HTTP server's request thread should expect to block for that
// long, the same as this project's other synchronous handlers.
//
// Deliberately no automatic function-prototype generation (the real
// Arduino IDE does this via a ctags step) - a sketch that calls a
// function before its definition needs a manual forward declaration.
// Documented v1 limitation, not solved here.
CompileResult compile_sketch(const std::string &source, const std::string &board = "arduino-uno");

}  // namespace avrtoolchain
