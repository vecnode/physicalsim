// ============================================================================
// esp32_toolchain.hpp
//
// Compiles a user sketch (an app_main()-shaped body, ESP-IDF's own C API -
// gpio_set_level()/vTaskDelay(), not Arduino's digitalWrite()/delay(), same
// "no Arduino-compatible core vendored yet" posture rp2040_toolchain.hpp
// documents for RP2040) into a merged, esptool-ready flash image, the same
// role rp2040_toolchain.hpp/avr_toolchain.hpp play for their targets.
//
// Genuinely heavier than either of those: a real ESP-IDF project is its
// own multi-component CMake build (bootloader + partition table + app,
// merged via esptool), not pico-sdk's flat add_executable() or avr-gcc's
// per-file compile - see esp32_sketch_template/CMakeLists.txt.
//
// esp-idf itself is vendored (simulators/esp-idf, a fork of
// espressif/esp-idf pinned to v5.3.1, added as a git submodule the same
// way every other simulators/ dependency is) and can be bundled next to
// the executable for a packaged build (CMakeLists.txt's BUNDLE_ESP_IDF -
// opt-in given the size, unlike pico-sdk's unconditional copy).
// xtensa-esp-elf-gcc is bundled via BUNDLE_XTENSA_TOOLCHAIN (fetched from
// espressif's own crosstool-NG releases, mirroring BUNDLE_ARM_TOOLCHAIN's
// shape). What's still genuinely dev-machine-only (see
// esp32_toolchain.cpp's find_toolchain()): cmake/ninja resolve from PATH
// (the same gap rp2040_toolchain.cpp already accepts), and a Python
// environment with esp-idf's own build-time dependencies installed
// (kconfiglib etc. - a bare system Python won't work) still resolves
// from this machine's %USERPROFILE%\.espressif, installed by esp-idf's
// own `install.ps1 esp32`.
// ============================================================================
#pragma once

#include <string>

namespace esp32toolchain {

struct CompileResult {
  bool ok = false;
  std::string log;
  // A merged, esptool-ready flash image (bootloader + partition table +
  // app, offsets baked in) - same "raw bytes, not Intel HEX" posture as
  // rp2040toolchain::CompileResult::binary (ESP32 has no Intel-HEX-shaped
  // convention any more than RP2040 does).
  std::string binary;
};

// True if the esp-idf checkout and xtensa-esp32-elf toolchain this dev
// machine's toolchain discovery expects are actually present - lets
// callers give a clear "not available" answer without attempting (and
// failing partway through) a real compile.
bool toolchain_available();

CompileResult compile_sketch(const std::string &source);

}  // namespace esp32toolchain
