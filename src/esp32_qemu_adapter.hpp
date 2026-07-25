// ============================================================================
// esp32_qemu_adapter.hpp
//
// C++ side of the "esp32" board: a real qemu-system-xtensa process
// (vecnode/qemu-esp32, forked from lcgamboa/qemu, itself a fork of
// espressif/qemu) the native shell spawns and controls, the same pattern
// qemu_adapter.hpp/.cpp already uses for "cortex-m"/qemu-system-arm - see
// that file for the general shape (QMP for start/stop/reset, GDB Remote
// Serial Protocol for register/memory access).
//
// Why a *different* QEMU fork than cortex-m's plain upstream qemu-system-arm:
// the official espressif/qemu fork's own peripheral-support docs mark
// "GPIO matrix / IOMUX" unimplemented on ESP32/S3/C3 - the exact mechanism
// behind gpio_set_level()/digitalWrite() on arbitrary pins, so an LED
// wired to a GPIO would never toggle under it. lcgamboa/qemu (PICSimLab's
// fork) adds that support; empirically confirmed 2026-07-25 by running a
// real ESP-IDF GPIO example under it and watching GPIO_OUT_REG toggle in
// lockstep with the firmware's writes (see the esp32-qemu-gpio-spike
// memory note). Unlike cortex-m, this adapter's read_pin() actually works.
//
// Firmware: unlike avr8/rp2040/cortex-m's "empty but bootable" or
// minimal-stub posture, ESP32's boot ROM requires a real, checksummed,
// esptool-merged flash image (bootloader + partition table + app) - not
// something this adapter can synthesize at runtime the way cortex-m's tiny
// vector-table stub is. Until a real "compile a sketch for esp32" pipeline
// exists (a genuinely bigger lift than avr-gcc's flat per-file compile -
// ESP-IDF projects are their own CMake builds, not a single loose source
// file - see ARCHITECTURE.md), this adapter boots one bundled, fixed demo
// image (the same GPIO blink firmware used to validate the QEMU fork
// above) rather than pretending user sketches compile. /compile in
// main.cpp returns a clear "not implemented yet" error for this board
// instead of silently ignoring the request.
// ============================================================================
#pragma once

#include <filesystem>
#include <memory>
#include <optional>
#include <string>

#include <nlohmann/json.hpp>

#include "qemu_backed_adapter.hpp"

namespace esp32qemu {

using json = nlohmann::json;

// Locates a usable qemu-system-xtensa executable: checks an "esp32-qemu/"
// folder next to physicalsim's own executable first (CMake's
// BUNDLE_QEMU_XTENSA option copies one there for packaged builds - see
// CMakeLists.txt), then PATH. No well-known-install-locations fallback
// (unlike qemu-system-arm) - vecnode/qemu-esp32 is a custom fork with no
// OS package or installer, so "already on this machine" realistically only
// ever means "on PATH because a dev put it there".
std::optional<std::filesystem::path> find_qemu_system_xtensa();

// Owns one running qemu-system-xtensa child process for the "esp32"
// adapter: process lifecycle, the QMP control connection, and the GDB RSP
// connection used for memory-mapped GPIO register reads. Not copyable -
// one instance owns one OS process and two sockets.
class Esp32QemuInstance : public QemuBackedAdapter {
 public:
  Esp32QemuInstance();
  ~Esp32QemuInstance() override;

  Esp32QemuInstance(const Esp32QemuInstance &) = delete;
  Esp32QemuInstance &operator=(const Esp32QemuInstance &) = delete;

  // Spawns qemu-system-xtensa (-machine esp32-picsimlab, halted via -S,
  // booting the bundled demo flash image) and connects the QMP and GDB
  // RSP sockets. Throws std::runtime_error on failure (binary/ROM/demo
  // image not found, spawn failure, or the sockets never come up).
  void start_process() override;

  json start() override;
  json stop() override;
  json step(int n) override;
  json reset() override;

  // {running, cycles, pc} - same documented "cycles is step() count, not
  // real CPU cycles" simplification as qemu_adapter.hpp's QemuInstance.
  json state() const override;

  // Reads the live level of an output-configured GPIO pin straight out of
  // GPIO_OUT_REG (ESP32 peripheral bus address 0x3ff44004) over the GDB
  // RSP memory-read command - real hardware state, not a simulated
  // approximation. "pin" is a marker like "D18" (matching the placed
  // board's own pin name, see board-registry.ts/esp32-devkit-v1-element.ts)
  // or a bare GPIO number.
  json read_pin(const std::string &pin) const override;

  // Not yet supported: driving an external input (e.g. a simulated button)
  // requires invoking QEMU's internal set_gpio() IRQ-line handler
  // (hw/gpio/esp32_gpio.c), which - unlike GPIO_OUT_REG - has no
  // memory-mapped or QMP-exposed path from outside the QEMU process today.
  // That needs its own follow-up (a small patch to vecnode/qemu-esp32
  // exposing it, e.g. as a QOM property or monitor command), not something
  // achievable through the existing QMP/GDB surface - so this throws
  // rather than silently doing nothing, same "don't fake it" posture as
  // qemu_adapter.hpp's cortex-m stub.
  json write_pin(const std::string &pin, int value) override;

  // Replaces the booted firmware with newly compiled bytes and respawns
  // qemu-system-xtensa fresh, halted (matching avr8/rp2040's own
  // loadFirmware()-then-reset() "loaded but not running until Start is
  // clicked" behavior) - see esp32_toolchain.hpp for how the bytes
  // themselves get produced.
  json load_firmware(const std::string &binary) override;

  bool running() const { return running_; }

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
  bool running_ = false;
  long long step_count_ = 0;
  // Always 0 - PC readback isn't implemented for this target (Xtensa's GDB
  // 'g' register-packet layout wasn't needed for anything this adapter
  // does; read_pin() uses a direct 'm' memory read instead). Reported
  // as-is, not silently faked as something more meaningful.
  unsigned long long last_pc_ = 0;
};

}  // namespace esp32qemu
