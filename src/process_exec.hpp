// ============================================================================
// process_exec.hpp
//
// Blocking "run one command, wait for it, capture combined stdout+stderr"
// helper - extracted from avr_toolchain.cpp (which originated it) once
// rp2040_toolchain.cpp needed the identical cross-platform spawn logic, to
// avoid a second ~150-line copy of Windows CreateProcess / POSIX
// posix_spawn plumbing. A simpler, blocking-wait cousin of qemu_adapter.cpp's
// own process-spawn pattern (that file keeps its process running long-term
// and talks to it over sockets; this one just runs a tool to completion and
// reads back what it printed) - qemu_adapter.cpp's needs are different
// enough (long-lived process, socket IPC) that it isn't a third user of this
// header, not an oversight.
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
// serialization (see rp2040_toolchain.cpp's compile mutex).
RunResult run_and_wait(const std::filesystem::path &exe, const std::vector<std::string> &args,
                        const std::filesystem::path &cwd, int timeout_seconds = 30);

}  // namespace procexec
