// ============================================================================
// esp32_toolchain.cpp — see esp32_toolchain.hpp for the overview.
// ============================================================================
#include "esp32_toolchain.hpp"

#include <chrono>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <mutex>
#include <optional>
#include <sstream>
#include <vector>

#include "process_exec.hpp"

#ifdef _WIN32
#include <windows.h>
#else
#include <unistd.h>
#endif

#ifndef PHYSICALSIM_SOURCE_DIR
#define PHYSICALSIM_SOURCE_DIR ""
#endif

namespace esp32toolchain {

namespace {

// ---- Toolchain discovery ---------------------------------------------------
// esp-idf itself is now vendored (simulators/esp-idf, a fork of
// espressif/esp-idf, added as a git submodule pinned to v5.3.1 the same
// "own the fork" way every other simulators/ dependency is) - a dev build
// finds it there via PHYSICALSIM_SOURCE_DIR, the same fallback
// avr_toolchain.cpp already uses for its own vendored ArduinoCore-avr
// tree, and a packaged build finds a bundled copy next to the executable
// (CMakeLists.txt's BUNDLE_ESP_IDF, opt-in given the size - esp-idf has
// no clean trim boundary and runs to hundreds of MB). The
// xtensa-esp-elf-gcc toolchain itself is bundled via
// BUNDLE_XTENSA_TOOLCHAIN (fetched from espressif/crosstool-NG's own
// releases - see CMakeLists.txt). What's still genuinely dev-machine-only:
// cmake/ninja (falls back to PATH) and a Python environment with esp-idf's own dependencies
// installed (kconfiglib etc. - a bare system Python won't work) - see
// esp32_toolchain.hpp's header comment.
std::filesystem::path executable_dir() {
#ifdef _WIN32
  wchar_t path[MAX_PATH]{};
  const auto len = GetModuleFileNameW(nullptr, path, MAX_PATH);
  if (len == 0 || len >= MAX_PATH) return std::filesystem::current_path();
  return std::filesystem::path(path).parent_path();
#else
  char path[4096]{};
  const auto len = readlink("/proc/self/exe", path, sizeof(path) - 1);
  if (len <= 0) return std::filesystem::current_path();
  path[len] = '\0';
  return std::filesystem::path(path).parent_path();
#endif
}

// Bundled "esp32-toolchain/bin" next to the executable (CMakeLists.txt's
// BUNDLE_XTENSA_TOOLCHAIN copies one there, mirroring
// BUNDLE_AVR_TOOLCHAIN's "avr-toolchain/bin") - checked first, same
// "bundled beats dev-machine" priority avr_toolchain.cpp's own
// find_toolchain_bin_dir() uses. Only the compiler itself is bundled this
// way today - esp-idf/cmake/ninja/python still resolve from this dev
// machine's fixed paths below (see esp32_toolchain.hpp's header comment
// on why those three aren't bundled yet).
std::optional<std::filesystem::path> find_bundled_xtensa_gcc_bin_dir() {
  const auto bundled = executable_dir() / "esp32-toolchain" / "bin";
  std::error_code ec;
#ifdef _WIN32
  if (std::filesystem::exists(bundled / "xtensa-esp32-elf-gcc.exe", ec)) return bundled;
#else
  if (std::filesystem::exists(bundled / "xtensa-esp32-elf-gcc", ec)) return bundled;
#endif
  return std::nullopt;
}

// Bundled "esp-idf/" next to the executable (CMakeLists.txt's
// BUNDLE_ESP_IDF copies simulators/esp-idf there for packaged builds,
// opt-in given the size), then simulators/esp-idf straight from the
// source tree (PHYSICALSIM_SOURCE_DIR) for a dev build run before that
// copy step has ever happened - the same two-step fallback
// avr_toolchain.cpp's own find_core_dir() already uses for its vendored
// tree.
std::optional<std::filesystem::path> find_vendored_esp_idf_dir() {
  const auto bundled = executable_dir() / "esp-idf";
  std::error_code ec;
  if (std::filesystem::exists(bundled / "tools" / "cmake" / "project.cmake", ec)) {
    return bundled;
  }
  const std::string source_dir = PHYSICALSIM_SOURCE_DIR;
  if (!source_dir.empty()) {
    const auto from_source = std::filesystem::path(source_dir) / "simulators" / "esp-idf";
    if (std::filesystem::exists(from_source / "tools" / "cmake" / "project.cmake", ec)) {
      return from_source;
    }
  }
  return std::nullopt;
}

#ifdef _WIN32
// Legacy dev-machine fallback, from before esp-idf was vendored - kept so
// a machine that already has a plain (non-submodule) esp-idf checkout at
// this well-known path still works without needing simulators/esp-idf
// initialized too. find_vendored_esp_idf_dir() above is tried first.
std::optional<std::filesystem::path> find_legacy_dev_esp_idf_dir() {
  const std::filesystem::path candidate = "C:\\esp-idf";
  std::error_code ec;
  if (std::filesystem::exists(candidate / "tools" / "cmake" / "project.cmake", ec)) {
    return candidate;
  }
  return std::nullopt;
}

std::optional<std::filesystem::path> find_espressif_tools_dir() {
  wchar_t *userprofile = nullptr;
  std::size_t len = 0;
  if (_wdupenv_s(&userprofile, &len, L"USERPROFILE") != 0 || !userprofile) {
    return std::nullopt;
  }
  const std::filesystem::path candidate = std::filesystem::path(userprofile) / ".espressif";
  free(userprofile);
  std::error_code ec;
  if (std::filesystem::exists(candidate, ec)) {
    return candidate;
  }
  return std::nullopt;
}

// The tools directory nests a version string per tool
// (tools/xtensa-esp-elf/esp-13.2.0_20240530/xtensa-esp-elf/bin/...) that
// changes across esp-idf releases - globbed rather than hardcoded so this
// doesn't silently stop working on a toolchain version bump the way a
// literal version string would.
std::optional<std::filesystem::path> find_versioned_subdir(const std::filesystem::path &parent) {
  std::error_code ec;
  if (!std::filesystem::exists(parent, ec)) return std::nullopt;
  for (const auto &entry : std::filesystem::directory_iterator(parent, ec)) {
    if (entry.is_directory()) return entry.path();
  }
  return std::nullopt;
}
#endif

struct ToolchainPaths {
  std::filesystem::path esp_idf_dir;
  std::filesystem::path xtensa_gcc_bin_dir;
  std::filesystem::path cmake_exe;
  std::filesystem::path ninja_bin_dir;
  std::filesystem::path python_exe;
  std::filesystem::path esp_rom_elf_dir;
};

std::optional<ToolchainPaths> find_toolchain() {
#ifdef _WIN32
  auto esp_idf_dir = find_vendored_esp_idf_dir();
  if (!esp_idf_dir) esp_idf_dir = find_legacy_dev_esp_idf_dir();
  const auto tools_dir = find_espressif_tools_dir();
  if (!esp_idf_dir || !tools_dir) return std::nullopt;

  ToolchainPaths paths;
  paths.esp_idf_dir = *esp_idf_dir;

  const auto xtensa_versioned = find_versioned_subdir(*tools_dir / "tools" / "xtensa-esp-elf");
  const auto cmake_versioned = find_versioned_subdir(*tools_dir / "tools" / "cmake");
  const auto ninja_versioned = find_versioned_subdir(*tools_dir / "tools" / "ninja");
  const auto python_env_versioned = find_versioned_subdir(*tools_dir / "python_env");
  const auto esp_rom_elf_versioned = find_versioned_subdir(*tools_dir / "tools" / "esp-rom-elfs");
  if (!xtensa_versioned || !cmake_versioned || !ninja_versioned || !python_env_versioned ||
      !esp_rom_elf_versioned) {
    return std::nullopt;
  }

  paths.xtensa_gcc_bin_dir =
      find_bundled_xtensa_gcc_bin_dir().value_or(*xtensa_versioned / "xtensa-esp-elf" / "bin");
  paths.cmake_exe = *cmake_versioned / "bin" / "cmake.exe";
  paths.ninja_bin_dir = *ninja_versioned;
  paths.python_exe = *python_env_versioned / "Scripts" / "python.exe";
  paths.esp_rom_elf_dir = *esp_rom_elf_versioned;

  std::error_code ec;
  if (!std::filesystem::exists(paths.xtensa_gcc_bin_dir / "xtensa-esp32-elf-gcc.exe", ec) ||
      !std::filesystem::exists(paths.cmake_exe, ec) ||
      !std::filesystem::exists(paths.ninja_bin_dir / "ninja.exe", ec) ||
      !std::filesystem::exists(paths.python_exe, ec)) {
    return std::nullopt;
  }
  return paths;
#else
  // Not implemented for non-Windows yet - this whole discovery scheme is
  // dev-machine-only regardless of OS (see the header comment on why),
  // and the only development/testing done so far has been on Windows.
  return std::nullopt;
#endif
}

std::optional<std::filesystem::path> find_sketch_template_dir() {
  const auto bundled = executable_dir() / "esp32-sketch-template";
  std::error_code ec;
  if (std::filesystem::exists(bundled / "CMakeLists.txt", ec)) {
    return bundled;
  }
  const std::string source_dir = PHYSICALSIM_SOURCE_DIR;
  if (source_dir.empty()) return std::nullopt;
  const auto candidate = std::filesystem::path(source_dir) / "src" / "esp32_sketch_template";
  if (std::filesystem::exists(candidate / "CMakeLists.txt", ec)) {
    return candidate;
  }
  return std::nullopt;
}

// One persistent work directory for the whole process lifetime, reused
// across compiles - "let ninja's incremental rebuild do its job" instead
// of reconfiguring from scratch every time, valuable here since a
// from-scratch ESP-IDF component-tree configure is real work (the
// Phase 0/1 spike's own first build took noticeably longer than a
// smaller CMake project's would).
std::filesystem::path work_dir() {
  return std::filesystem::temp_directory_path() / "physicalsim-esp32-sketch";
}

// g_configured below is an in-process cache only, false again on every
// fresh physicalsim.exe launch - so a dev restarting the app between
// "Compile & Run" clicks (the normal workflow after any C++ rebuild) paid
// a full ~10s cmake reconfigure every time, even though work_dir()'s
// build/ was already configured against the exact same toolchain/template
// from a prior run and nothing relevant had changed. This stamp persists
// what the configure was actually run against, so a fresh process can
// tell "still valid, skip straight to the ~1s incremental ninja build"
// from "something changed, must reconfigure" without redoing the
// configure just to find out.
std::filesystem::path configure_stamp_path(const std::filesystem::path &dir) {
  return dir / "build" / "physicalsim-configure-stamp.txt";
}

std::string configure_key(const ToolchainPaths &toolchain, const std::filesystem::path &template_dir) {
  std::ostringstream key;
  key << toolchain.esp_idf_dir.string() << '\n'
      << toolchain.xtensa_gcc_bin_dir.string() << '\n'
      << toolchain.cmake_exe.string() << '\n'
      << toolchain.ninja_bin_dir.string() << '\n'
      << toolchain.python_exe.string() << '\n'
      << toolchain.esp_rom_elf_dir.string() << '\n'
      << template_dir.string();
  return key.str();
}

bool configure_is_up_to_date(const std::filesystem::path &dir, const std::string &key) {
  std::error_code ec;
  if (!std::filesystem::exists(dir / "build" / "build.ninja", ec)) return false;
  std::ifstream stamp(configure_stamp_path(dir));
  if (!stamp) return false;
  std::ostringstream existing;
  existing << stamp.rdbuf();
  return existing.str() == key;
}

void write_configure_stamp(const std::filesystem::path &dir, const std::string &key) {
  std::ofstream stamp(configure_stamp_path(dir), std::ios::trunc);
  stamp << key;
}

std::mutex g_compile_mutex;
bool g_configured = false;

#ifdef _WIN32
// g_compile_mutex above only serializes compiles within *this* process -
// work_dir() is a single fixed path under the OS temp directory, shared by
// every physicalsim.exe instance on the machine, with nothing else
// guarding it. Two instances compiling an ESP32 sketch at the same time
// (e.g. a stale instance left over from a previous build_and_run.bat run,
// still open, plus a freshly launched one) race on the same build/ tree -
// concurrent ninja/cmake invocations against identical build files, which
// can corrupt the ninja database or simply hang one side waiting on a file
// handle the other holds - exactly the "compile just never finishes"
// symptom this cross-process named mutex closes off. Acquired for the
// whole compile_sketch() call (configure+build+merge_bin), released via
// RAII even on an early return/exception.
struct CrossProcessCompileLock {
  HANDLE handle = nullptr;
  bool acquired = false;

  CrossProcessCompileLock() {
    handle = CreateMutexW(nullptr, FALSE, L"Local\\PhysicalSimEsp32CompileLock");
    if (!handle) return;
    // Covers a full from-scratch configure+build (up to the 300s+300s
    // timeouts esp32_toolchain.cpp's own compile steps allow) plus enough
    // slack for a slower machine - matches those steps' own reasoning for
    // generous bounds rather than picking a tighter one that would make
    // this lock itself the next "why did this time out" report.
    const DWORD wait_result = WaitForSingleObject(handle, 620000);
    acquired = (wait_result == WAIT_OBJECT_0 || wait_result == WAIT_ABANDONED);
  }

  ~CrossProcessCompileLock() {
    if (acquired) ReleaseMutex(handle);
    if (handle) CloseHandle(handle);
  }
};
#endif

void set_env(const char *name, const std::string &value) {
#ifdef _WIN32
  _putenv_s(name, value.c_str());
#else
  setenv(name, value.c_str(), 1);
#endif
}

void prepend_path(const std::filesystem::path &dir) {
#ifdef _WIN32
  char *existing = nullptr;
  std::size_t len = 0;
  std::string new_path = dir.string();
  if (_dupenv_s(&existing, &len, "PATH") == 0 && existing) {
    new_path += ";";
    new_path += existing;
    free(existing);
  }
  _putenv_s("PATH", new_path.c_str());
#else
  const char *existing = std::getenv("PATH");
  std::string new_path = dir.string();
  if (existing) {
    new_path += ":";
    new_path += existing;
  }
  setenv("PATH", new_path.c_str(), 1);
#endif
}

}  // namespace

bool toolchain_available() {
  return find_toolchain().has_value() && find_sketch_template_dir().has_value();
}

CompileResult compile_sketch(const std::string &source) {
  CompileResult result;
  std::lock_guard<std::mutex> lock(g_compile_mutex);

#ifdef _WIN32
  CrossProcessCompileLock cross_process_lock;
  if (!cross_process_lock.acquired) {
    result.log =
        "ESP32 compile: another physicalsim instance is already compiling an ESP32 sketch "
        "(they share one build directory under %TEMP%\\physicalsim-esp32-sketch) - wait for it "
        "to finish, or close the other instance, then try again.";
    return result;
  }
#endif

  const auto toolchain = find_toolchain();
  const auto template_dir = find_sketch_template_dir();
  if (!toolchain || !template_dir) {
    result.log =
        "ESP32 toolchain not found. esp-idf itself is vendored (simulators/esp-idf) or "
        "bundled (BUNDLE_ESP_IDF); xtensa-esp-elf-gcc is bundled via BUNDLE_XTENSA_TOOLCHAIN. "
        "Still needed on this machine: cmake/ninja on PATH, and a Python environment with "
        "esp-idf's own dependencies installed under %USERPROFILE%\\.espressif (see "
        "`install.ps1 esp32` in an esp-idf checkout) - see esp32_toolchain.hpp for exactly "
        "what's bundled vs. still dev-machine-only.";
    return result;
  }

  const auto dir = work_dir();
  std::error_code ec;
  std::filesystem::create_directories(dir / "main", ec);

  // main.c: the user's app_main() body, wrapped the same "just the body,
  // not a full translation unit" way avr_toolchain.cpp's Arduino sketches
  // are - except this API surface is ESP-IDF's own (gpio_set_level(),
  // vTaskDelay()), not Arduino's, since no Arduino-compatible core is
  // vendored for ESP32.
  {
    std::ofstream main_file(dir / "main" / "main.c");
    main_file << "#include \"driver/gpio.h\"\n"
                 "#include \"freertos/FreeRTOS.h\"\n"
                 "#include \"freertos/task.h\"\n\n"
              << source << "\n";
  }

  set_env("IDF_PATH", toolchain->esp_idf_dir.string());
  set_env("ESP_ROM_ELF_DIR", toolchain->esp_rom_elf_dir.string());
  prepend_path(toolchain->xtensa_gcc_bin_dir);
  prepend_path(toolchain->ninja_bin_dir);
  prepend_path(toolchain->python_exe.parent_path());

  const std::string configure_key_value = configure_key(*toolchain, *template_dir);
  if (!g_configured && configure_is_up_to_date(dir, configure_key_value)) {
    // A prior physicalsim.exe run (or an earlier compile already made in
    // this one) already configured this exact build/ against this exact
    // toolchain/template - see configure_is_up_to_date()'s own comment on
    // why redoing it would be pure waste.
    g_configured = true;
  }

  if (!g_configured) {
    std::error_code copy_ec;
    std::filesystem::copy_file(*template_dir / "CMakeLists.txt", dir / "CMakeLists.txt",
                                std::filesystem::copy_options::overwrite_existing, copy_ec);
    std::filesystem::create_directories(dir / "main", copy_ec);
    std::filesystem::copy_file(*template_dir / "main" / "CMakeLists.txt", dir / "main" / "CMakeLists.txt",
                                std::filesystem::copy_options::overwrite_existing, copy_ec);

    const std::vector<std::string> configure_args = {
        "-G",
        "Ninja",
        "-B",
        "build",
        "-DCMAKE_TOOLCHAIN_FILE=" + (toolchain->esp_idf_dir / "tools" / "cmake" / "toolchain-esp32.cmake").string(),
        "-DIDF_TARGET=esp32",
        "-DPYTHON=" + toolchain->python_exe.string(),
        "-DPYTHON_DEPS_CHECKED=1",
        ".",
    };
    // 300s: a from-scratch ESP-IDF component-tree configure (the whole
    // component list, kconfig defaults, sdkconfig generation) is real work
    // - slower than pico-sdk's own configure, and slower machines than the
    // one this was developed on can genuinely take longer than a tighter
    // bound would allow (a real "compile hangs" report traced back to a
    // timeout this tight combined with process_exec.cpp not killing the
    // whole process tree on timeout - see that file's own fix - so the
    // *next* attempt fought orphaned processes from the *previous* one).
    std::cerr << "[esp32_toolchain] starting cmake configure" << std::endl;
    const auto configure_start = std::chrono::steady_clock::now();
    const auto configure_run = procexec::run_and_wait(toolchain->cmake_exe, configure_args, dir, 300);
    const auto configure_seconds =
        std::chrono::duration<double>(std::chrono::steady_clock::now() - configure_start).count();
    std::cerr << "[esp32_toolchain] cmake configure exit_code=" << configure_run.exit_code << " ("
              << configure_seconds << "s)" << std::endl;
    if (configure_run.exit_code != 0) {
      result.log = "cmake configure failed:\n" + configure_run.output;
      return result;
    }
    write_configure_stamp(dir, configure_key_value);
    g_configured = true;
  }

  // 300s: a first build compiles the whole ESP-IDF component tree
  // (bootloader + every linked component) - later builds only recompile
  // main.c and relink, much faster, but the bound has to cover the slow
  // first case with real headroom for a slower machine than this was
  // developed on (see the configure step's own comment above).
  //
  // Calls ninja directly rather than "cmake --build build" - measured
  // ~9-10s for an already-up-to-date build through this app's own process
  // spawn path (vs ~0.4s for the identical command run by hand), which
  // didn't reproduce through a minimal standalone harness using this same
  // spawn code - narrowed to contention between physicalsim's own WebView2
  // process tree (constantly active, several Chromium subprocesses doing
  // real disk/IPC I/O) and antivirus real-time scanning of each short-lived
  // build subprocess. "cmake --build" adds an extra process hop (cmake
  // re-invoking ninja as a child, plus its own regenerate-check pass over
  // the whole component tree) on top of that; calling ninja directly cuts
  // both away. This is a portability requirement, not just a dev-machine
  // convenience - unlike a dev's own AV exclusions, end users installing a
  // packaged build can't be expected to configure their antivirus, so the
  // fewer stat/scan-triggering hops in this path, the better it holds up
  // on a machine already under EDR/AV pressure.
  std::cerr << "[esp32_toolchain] starting ninja build" << std::endl;
  const auto build_start = std::chrono::steady_clock::now();
  const auto ninja_exe = toolchain->ninja_bin_dir / "ninja.exe";
  const auto build_run = procexec::run_and_wait(ninja_exe, {"-C", "build"}, dir, 300);
  const auto build_seconds =
      std::chrono::duration<double>(std::chrono::steady_clock::now() - build_start).count();
  std::cerr << "[esp32_toolchain] ninja build exit_code=" << build_run.exit_code << " (" << build_seconds
            << "s)" << std::endl;
  if (build_run.exit_code != 0) {
    result.log = "build failed:\n" + build_run.output;
    return result;
  }

  // The project.cmake-driven build above already produces the app's own
  // ELF (project(physicalsim_esp32_sketch) in esp32_sketch_template's
  // CMakeLists.txt names the output) - esp32js's loadElf() reads that
  // directly (PT_LOAD segments at their real p_vaddr, entry point from
  // e_entry), so unlike a real flash write there's no esptool merge_bin
  // step (bootloader + partition table + app, at flash offsets) needed at
  // all; this just reads the ELF file back out.
  const auto elf_path = dir / "build" / "physicalsim_esp32_sketch.elf";
  std::ifstream elf_file(elf_path, std::ios::binary);
  if (!elf_file) {
    result.log = "ninja build reported success but " + elf_path.string() + " is missing";
    return result;
  }
  std::ostringstream elf_ss;
  elf_ss << elf_file.rdbuf();

  std::cerr << "[esp32_toolchain] compile_sketch returning success, " << elf_ss.str().size() << " bytes"
            << std::endl;
  result.ok = true;
  result.binary = elf_ss.str();
  result.log = build_run.output;
  return result;
}

}  // namespace esp32toolchain
