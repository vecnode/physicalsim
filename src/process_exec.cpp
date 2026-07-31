#include "process_exec.hpp"

#include <atomic>
#include <chrono>
#include <fstream>
#include <sstream>
#include <thread>

#ifdef _WIN32
#include <windows.h>
#else
#include <fcntl.h>
#include <signal.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>
extern char **environ;
#endif

namespace procexec {

namespace {

std::atomic<int> g_log_counter{0};

// Minimal quoting adequate for the controlled arguments callers pass (temp
// file paths, plain flag strings) - not a general-purpose command-line
// quoting implementation.
std::string quote_arg_windows(const std::string &arg) {
  std::string out = "\"";
  for (char c : arg) {
    if (c == '"') {
      out += "\\\"";
    } else {
      out += c;
    }
  }
  out += "\"";
  return out;
}

}  // namespace

RunResult run_and_wait(const std::filesystem::path &exe, const std::vector<std::string> &args,
                        const std::filesystem::path &cwd, int timeout_seconds) {
  RunResult result;
  const auto log_path = cwd / ("step-" + std::to_string(g_log_counter.fetch_add(1)) + ".log");

#ifdef _WIN32
  std::ostringstream cmd;
  cmd << quote_arg_windows(exe.string());
  for (const auto &a : args) cmd << " " << quote_arg_windows(a);
  std::string cmd_str = cmd.str();

  SECURITY_ATTRIBUTES sa{};
  sa.nLength = sizeof(sa);
  sa.bInheritHandle = TRUE;
  HANDLE log_handle = CreateFileW(log_path.wstring().c_str(), GENERIC_WRITE, FILE_SHARE_READ, &sa,
                                   CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (log_handle == INVALID_HANDLE_VALUE) {
    result.output = "failed to create process log file at " + log_path.string();
    return result;
  }

  STARTUPINFOA startup_info{};
  startup_info.cb = sizeof(startup_info);
  startup_info.dwFlags = STARTF_USESTDHANDLES;
  startup_info.hStdOutput = log_handle;
  startup_info.hStdError = log_handle;
  startup_info.hStdInput = GetStdHandle(STD_INPUT_HANDLE);

  PROCESS_INFORMATION process_info{};
  const std::string cwd_str = cwd.string();
  const BOOL spawned =
      CreateProcessA(nullptr, cmd_str.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr,
                      cwd_str.c_str(), &startup_info, &process_info);
  CloseHandle(log_handle);
  if (!spawned) {
    result.output = "failed to spawn " + exe.string();
    return result;
  }

  // A Job Object with KILL_ON_JOB_CLOSE - without this, TerminateProcess()
  // below only kills the immediate child (e.g. cmake.exe), not the whole
  // tree it spawns (ninja, and every xtensa-esp32-elf-gcc/cc1.exe
  // instance it runs) - a real bug found while debugging a "compile
  // hangs forever" report: a timed-out `cmake --build` (esp-idf's own
  // component-tree build can genuinely take longer than expected on a
  // slower machine) left orphaned compiler processes still writing into
  // the same shared work directory, so every subsequent compile attempt
  // fought zombies for file locks instead of running cleanly. Assigning
  // the child to this job (best-effort - if it fails, behavior falls
  // back to the old single-process kill) and closing the job handle
  // unconditionally at the end (not just on the timeout path) kills any
  // still-running descendant even after a normal exit, since some
  // grandchildren can detach and outlive their immediate parent.
  HANDLE job_handle = CreateJobObjectW(nullptr, nullptr);
  if (job_handle) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SetInformationJobObject(job_handle, JobObjectExtendedLimitInformation, &limits, sizeof(limits));
    AssignProcessToJobObject(job_handle, process_info.hProcess);
  }

  const DWORD wait_result =
      WaitForSingleObject(process_info.hProcess, static_cast<DWORD>(timeout_seconds) * 1000);
  if (wait_result == WAIT_TIMEOUT) {
    TerminateProcess(process_info.hProcess, 1);
    WaitForSingleObject(process_info.hProcess, 2000);
  }
  DWORD exit_code = 1;
  GetExitCodeProcess(process_info.hProcess, &exit_code);
  CloseHandle(process_info.hProcess);
  CloseHandle(process_info.hThread);
  if (job_handle) {
    CloseHandle(job_handle);
  }
  result.exit_code = static_cast<int>(exit_code);
#else
  std::vector<std::string> arg_storage;
  arg_storage.push_back(exe.string());
  for (const auto &a : args) arg_storage.push_back(a);
  std::vector<char *> argv;
  for (auto &a : arg_storage) argv.push_back(a.data());
  argv.push_back(nullptr);

  posix_spawn_file_actions_t actions;
  posix_spawn_file_actions_init(&actions);
  posix_spawn_file_actions_addopen(&actions, STDOUT_FILENO, log_path.c_str(),
                                    O_WRONLY | O_CREAT | O_TRUNC, 0644);
  posix_spawn_file_actions_adddup2(&actions, STDOUT_FILENO, STDERR_FILENO);

  posix_spawnattr_t attr;
  posix_spawnattr_init(&attr);

  pid_t pid = -1;
  const std::string prev_cwd = std::filesystem::current_path().string();
  std::filesystem::current_path(cwd);
  const int rc = posix_spawn(&pid, exe.c_str(), &actions, &attr, argv.data(), environ);
  std::filesystem::current_path(prev_cwd);
  posix_spawn_file_actions_destroy(&actions);
  posix_spawnattr_destroy(&attr);

  if (rc != 0) {
    result.output = "failed to spawn " + exe.string();
    return result;
  }

  int status = 0;
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(timeout_seconds);
  while (true) {
    pid_t r = waitpid(pid, &status, WNOHANG);
    if (r == pid) break;
    if (std::chrono::steady_clock::now() > deadline) {
      kill(pid, SIGKILL);
      waitpid(pid, &status, 0);
      break;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }
  result.exit_code = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
#endif

  std::ifstream log_file(log_path);
  if (log_file) {
    std::ostringstream ss;
    ss << log_file.rdbuf();
    result.output = ss.str();
  }
  std::error_code ec;
  std::filesystem::remove(log_path, ec);
  return result;
}

}  // namespace procexec
