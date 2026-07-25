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
// Toolchain discovery today is dev-machine-only (see esp32_toolchain.cpp's
// find_esp_idf_dir()/find_xtensa_toolchain_dir() - fixed paths under this
// machine's C:\esp-idf and C:\Users\<user>\.espressif, not a bundled or
// FetchContent-fetched copy the way avr-gcc/arm-none-eabi-gcc are). A real
// BUNDLE_XTENSA_TOOLCHAIN (mirroring BUNDLE_ARM_TOOLCHAIN) plus a vendored
// or fetched esp-idf checkout is real follow-up work before this compiles
// on any machine other than the one it was built on - documented here, not
// silently assumed solved.
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
