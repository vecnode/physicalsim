// ============================================================================
// esp32_qemu_adapter.hpp
//
// C++ side of the "esp32" board: a real qemu-system-xtensa process
// (vecnode/qemu-esp32, forked from lcgamboa/qemu, itself a fork of
// espressif/qemu) the native shell spawns and controls, using QMP for
// start/stop/reset and GDB Remote Serial Protocol for register/memory
// access and (see write_pin()/write_analog_pin() below) monitor commands.
//
// Why a *different* QEMU fork than plain upstream qemu-system-xtensa: the
// official espressif/qemu fork's own peripheral-support docs mark "GPIO
// matrix / IOMUX" unimplemented on ESP32/S3/C3 - the exact mechanism
// behind gpio_set_level()/digitalWrite() on arbitrary pins, so an LED
// wired to a GPIO would never toggle under it. lcgamboa/qemu (PICSimLab's
// fork) adds that support; empirically confirmed 2026-07-25 by running a
// real ESP-IDF GPIO example under it and watching GPIO_OUT_REG toggle in
// lockstep with the firmware's writes (see the esp32-qemu-gpio-spike
// memory note).
//
// This adapter's pin I/O now needs a *further* patch on top of that fork
// (hw/xtensa/esp32_picsimlab.c + hmp-commands.hx: two new HMP monitor
// commands, "esp32_set_gpio_input" and "esp32_set_adc" - see
// write_pin()/write_analog_pin()'s own comments) to close the input half
// of the loop; read_pin()/read_pin_direction() need no fork changes at
// all, since GPIO_OUT_REG/GPIO_ENABLE_REG are plain memory-mapped
// registers a GDB memory read already reaches.
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

  // Drives an external input into GPIO_IN_REG - unlike GPIO_OUT_REG,
  // that register has no plain memory-mapped write path (QEMU's
  // hw/gpio/esp32_gpio.c only updates it from inside set_gpio(), called
  // via a qdev GPIO-in line, not from a bus write handler). Reaches it
  // through a small addition to vecnode/qemu-esp32 itself: a new HMP
  // monitor command ("esp32_set_gpio_input <gpio> <value>", added to
  // hw/xtensa/esp32_picsimlab.c + hmp-commands.hx in that fork) invoked
  // here over the same GDB RSP connection read_pin() already uses, via
  // its qRcmd ("monitor command") extension - see run_monitor_command()
  // in the .cpp file.
  json write_pin(const std::string &pin, int value) override;

  // Same GPIO_ENABLE_REG memory read pattern as read_pin()'s GPIO_OUT_REG
  // - direction is just another plain memory-mapped register, no fork
  // patch needed for this one.
  json read_pin_direction(const std::string &pin) const override;

  // Feeds an ADC1-channel-capable pin (GPIO32-39) a real voltage, scaled
  // to a 12-bit raw count against the SAR ADC's ADC_values[] array - the
  // same vecnode/qemu-esp32 HMP-command path write_pin() uses, targeting
  // hw/misc/esp32_sens.c's Esp32SensState instead of the GPIO device. A
  // pin outside GPIO32-39 has no ADC1 channel behind it and this silently
  // no-ops, matching avr8/rp2040's own "reject a non-ADC pin, caught not
  // thrown" posture.
  json write_analog_pin(const std::string &pin, double voltage) override;

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
