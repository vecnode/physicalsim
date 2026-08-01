// ============================================================================
// esp32_toolchain.hpp
//
// Compiles a user sketch (an app_main()-shaped body, ESP-IDF's own C API -
// gpio_set_level()/vTaskDelay(), not Arduino's digitalWrite()/delay(), no
// Arduino-compatible core is vendored for ESP32) into a plain ELF32
// image - the shape esp32js's loadElf() expects (see
// web/adapters/esp32/src/adapter.ts), not a merged/flashable image the
// way avr8's Intel HEX is for its own JS-Worker adapter.
//
// Genuinely heavier than avr8's own compile: a real ESP-IDF project is
// its own multi-component CMake build (bootloader + partition table +
// app), not avr-gcc's per-file compile - see
// esp32_sketch_template/CMakeLists.txt. Only the app ELF itself
// (build/physicalsim_esp32_sketch.elf) is read back out - the bootloader/
// partition-table/esptool merge step that a real flash write would need
// is skipped entirely, since esp32js runs the ELF directly.
//
// esp-idf itself is vendored (simulators/esp-idf, a fork of
// espressif/esp-idf pinned to v5.3.1, added as a git submodule the same
// way every other simulators/ dependency is) and can be bundled next to
// the executable for a packaged build (CMakeLists.txt's BUNDLE_ESP_IDF,
// opt-in given the size). xtensa-esp-elf-gcc is bundled via
// BUNDLE_XTENSA_TOOLCHAIN (fetched from espressif's own crosstool-NG
// releases, mirroring BUNDLE_AVR_TOOLCHAIN's shape). What's still
// genuinely dev-machine-only (see esp32_toolchain.cpp's
// find_toolchain()): cmake/ninja resolve from PATH, and a Python
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
  // Raw bytes of the compiled app's ELF32 image - esp32js's loadElf() reads
  // this directly (PT_LOAD segments at their real p_vaddr, entry point from
  // e_entry), same "raw bytes, not Intel HEX" posture as
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
