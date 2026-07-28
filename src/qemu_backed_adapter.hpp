// ============================================================================
// qemu_backed_adapter.hpp
//
// Common interface for any adapter backed by a spawned QEMU process (as
// opposed to avr8/rp2040's JS-in-a-Worker adapters). Lets main.cpp's
// /bridge dispatch treat every QEMU-backed adapter kind identically, one
// lookup table entry per adapter id instead of a special case per kind -
// today that's just "esp32" (esp32_qemu_adapter.hpp/.cpp); a former
// "cortex-m" adapter (qemu_adapter.hpp/.cpp, plain qemu-system-arm) was
// removed since no board ever mapped to it.
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
  // Whether a pin is currently a firmware-driven output or a (possibly
  // externally-driven) input - the same distinction avr8/rp2040's own
  // readPinDirection() already report (adapter-types.ts), now mandatory
  // for every registered adapter, not just the JS-worker ones.
  virtual nlohmann::json read_pin_direction(const std::string &pin) const = 0;
  // Analog input - "voltage" feeds an ADC-capable pin, matching avr8/
  // rp2040's writeAnalogPin(). Silently a no-op (not an error) for a pin
  // with no ADC hardware behind it, same posture those two already take.
  virtual nlohmann::json write_analog_pin(const std::string &pin, double voltage) = 0;

  // Replaces whatever firmware this adapter boots with newly compiled
  // bytes and (re)starts the target running it - the QEMU-backed
  // equivalent of avr8/rp2040's Worker-side loadFirmware().
  virtual nlohmann::json load_firmware(const std::string &binary) = 0;
};
