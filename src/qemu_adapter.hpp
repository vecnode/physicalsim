// ============================================================================
// qemu_adapter.hpp
//
// C++ side of the "cortex-m" board: a real qemu-system-arm process the
// native shell spawns and controls directly (QMP for start/stop/reset, a
// minimal GDB Remote Serial Protocol client for step + PC readback). See
// ARCHITECTURE.md for why this adapter kind exists alongside the JS/TS
// Worker-backed ones (avr8, rp2040) and how it plugs into the same
// /bridge/:adapter/:method HTTP surface.
// ============================================================================
#pragma once

#include <filesystem>
#include <memory>
#include <optional>
#include <string>

#include <nlohmann/json.hpp>

namespace qemu {

using json = nlohmann::json;

// Locates a usable qemu-system-arm executable: checks a "qemu/" folder
// next to physicalsim's own executable first (CMake's BUNDLE_QEMU_ARM
// option copies one there for packaged builds - see CMakeLists.txt),
// then PATH (via the OS's own search order), then a short list of
// well-known install locations per platform (e.g. the default Windows
// installer target). Returns nullopt if not found anywhere - callers
// should surface this as a clear, actionable error rather than trying to
// spawn a missing binary.
std::optional<std::filesystem::path> find_qemu_system_arm();

// Owns one running qemu-system-arm child process for the "cortex-m"
// adapter: process lifecycle, the QMP control connection, and the GDB RSP
// connection used for single-stepping. Not copyable - one instance owns
// one OS process and two sockets.
class QemuInstance {
public:
  QemuInstance();
  ~QemuInstance();

  QemuInstance(const QemuInstance &) = delete;
  QemuInstance &operator=(const QemuInstance &) = delete;

  // Spawns qemu-system-arm (-M netduinoplus2, halted via -S) and connects
  // the QMP and GDB RSP sockets. Throws std::runtime_error on failure
  // (binary not found, spawn failure, or the sockets never come up).
  void start_process();

  // Adapter-shaped operations, mirroring SimulatorAdapter
  // (web/common/src/adapter-types.ts) so the two adapter kinds present an
  // identical surface over the HTTP bridge.
  json start();
  json stop();
  json step(int n);
  json reset();

  // Current state snapshot: {running, cycles, pc}. cycles is not
  // available from QEMU the way avr8js/rp2040js expose it (no cycle
  // counter over QMP/GDB for this target) - reported as the number of
  // step()/run calls issued instead, not real CPU cycles. Documented,
  // not silently faked.
  json state() const;

  // Pin I/O: unimplemented pending a spike into whether QEMU's netduinoplus2
  // GPIO model supports external stimulus at all (see ARCHITECTURE.md /
  // the io-pins plan). Both throw std::runtime_error unconditionally so the
  // bridge surface is uniform across all three adapter kinds today - the
  // shell never needs a cortex-m special case - without pretending pin
  // access actually works. Replace with a real implementation (likely QMP
  // or GDB memory reads/writes against the STM32 GPIO IDR/ODR registers)
  // once that spike resolves.
  json read_pin(const std::string &pin) const;
  json write_pin(const std::string &pin, int value);

  bool running() const { return running_; }

private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
  bool running_ = false;
  long long step_count_ = 0;
  unsigned long long last_pc_ = 0;
};

}  // namespace qemu
