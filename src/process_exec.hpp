// ============================================================================
// process_exec.hpp
//
// Blocking "run one command, wait for it, capture combined stdout+stderr"
// helper - extracted from avr_toolchain.cpp (which originated it) once
// esp32_toolchain.cpp needed the identical cross-platform spawn logic,
// to avoid repeated copies of Windows CreateProcess / POSIX posix_spawn
// plumbing.
// ============================================================================
#pragma once

#include <filesystem>
#include <string>
#include <vector>

namespace procexec {

struct RunResult {
  int exit_code = -1;
  std::string output;  // combined stdout+stderr
};

// Runs `exe args...` in `cwd`, waits up to `timeout_seconds`, and returns its
// exit code and captured output. A timed-out process is killed. Not
// reentrant-safe to call from multiple threads with the same `cwd` (each
// call writes a transient log file there, cleaned up before returning) -
// callers sharing a cwd across threads need their own external
// serialization (see esp32_toolchain.cpp's g_compile_mutex).
RunResult run_and_wait(const std::filesystem::path &exe, const std::vector<std::string> &args,
                        const std::filesystem::path &cwd, int timeout_seconds = 30);

}  // namespace procexec
