// ============================================================================
// qemu_backed_adapter.hpp
//
// Common interface for any adapter backed by a spawned QEMU process (as
// opposed to avr8/rp2040's JS-in-a-Worker adapters) - see qemu_adapter.hpp
// for the original ("cortex-m") rationale. Lets main.cpp's /bridge dispatch
// treat every QEMU-backed adapter kind (cortex-m, esp32, ...) identically,
// one lookup table entry per adapter id instead of a special case per kind.
// ============================================================================
#pragma once

#include <nlohmann/json.hpp>
#include <string>

class QemuBackedAdapter {
 public:
  virtual ~QemuBackedAdapter() = default;

  virtual void start_process() = 0;
  virtual nlohmann::json start() = 0;
  virtual nlohmann::json stop() = 0;
  virtual nlohmann::json step(int n) = 0;
  virtual nlohmann::json reset() = 0;
  virtual nlohmann::json state() const = 0;
  virtual nlohmann::json read_pin(const std::string &pin) const = 0;
  virtual nlohmann::json write_pin(const std::string &pin, int value) = 0;

  // Replaces whatever firmware this adapter boots with newly compiled
  // bytes and (re)starts the target running it - the QEMU-backed
  // equivalent of avr8/rp2040's Worker-side loadFirmware(). Not every
  // QEMU-backed adapter supports this yet (cortex-m doesn't - see
  // qemu_adapter.cpp), so implementations that don't should throw a clear
  // std::runtime_error rather than silently no-op'ing.
  virtual nlohmann::json load_firmware(const std::string &binary) = 0;
};
