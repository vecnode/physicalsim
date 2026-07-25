// ============================================================================
// esp32_toolchain.cpp — see esp32_toolchain.hpp for the overview.
// ============================================================================
#include "esp32_toolchain.hpp"

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
// avr_toolchain.cpp/rp2040_toolchain.cpp already use for their own vendored
// trees, and a packaged build finds a bundled copy next to the executable
// (CMakeLists.txt's BUNDLE_ESP_IDF, opt-in given the size - unlike
// pico-sdk's ~9MB, esp-idf has no clean trim boundary and runs to hundreds
// of MB). The xtensa-esp-elf-gcc toolchain itself is bundled via
// BUNDLE_XTENSA_TOOLCHAIN (fetched from espressif/crosstool-NG's own
// releases - see CMakeLists.txt). What's still genuinely dev-machine-only:
// cmake/ninja (falls back to PATH, same gap rp2040_toolchain.cpp already
// has and accepts) and a Python environment with esp-idf's own dependencies
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
// BUNDLE_ARM_TOOLCHAIN's "arm-toolchain/bin") - checked first, same
// "bundled beats dev-machine" priority find_toolchain_bin_dir() already
// has in rp2040_toolchain.cpp. Only the compiler itself is bundled this
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
// BUNDLE_ESP_IDF copies simulators/esp-idf there for packaged builds -
// opt-in given the size, unlike pico-sdk's unconditional copy), then
// simulators/esp-idf straight from the source tree (PHYSICALSIM_SOURCE_DIR)
// for a dev build run before that copy step has ever happened - the same
// two-step fallback avr_toolchain.cpp's find_core_dir()/
// rp2040_toolchain.cpp's find_pico_sdk_dir() already use for their own
// vendored trees.
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
// across compiles - same "let ninja's incremental rebuild do its job"
// reasoning as rp2040_toolchain.cpp's work_dir(), even more valuable here
// since a from-scratch ESP-IDF component-tree configure is real work (the
// Phase 0/1 spike's own first build took noticeably longer than pico-sdk's
// ~70-file one).
std::filesystem::path work_dir() {
  return std::filesystem::temp_directory_path() / "physicalsim-esp32-sketch";
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
  // and rp2040_toolchain.cpp's sketch.c are - except this API surface is
  // ESP-IDF's own (gpio_set_level(), vTaskDelay()), not Arduino's, since no
  // Arduino-compatible core is vendored for ESP32 either (same reasoning
  // as RP2040 - see ARCHITECTURE.md).
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
    const auto configure_run = procexec::run_and_wait(toolchain->cmake_exe, configure_args, dir, 300);
    std::cerr << "[esp32_toolchain] cmake configure exit_code=" << configure_run.exit_code << std::endl;
    if (configure_run.exit_code != 0) {
      result.log = "cmake configure failed:\n" + configure_run.output;
      return result;
    }
    g_configured = true;
  }

  // 300s: a first build compiles the whole ESP-IDF component tree
  // (bootloader + every linked component) - later builds only recompile
  // main.c and relink, much faster, but the bound has to cover the slow
  // first case with real headroom for a slower machine than this was
  // developed on (see the configure step's own comment above).
  std::cerr << "[esp32_toolchain] starting cmake --build" << std::endl;
  const auto build_run = procexec::run_and_wait(toolchain->cmake_exe, {"--build", "build"}, dir, 300);
  std::cerr << "[esp32_toolchain] cmake --build exit_code=" << build_run.exit_code << std::endl;
  if (build_run.exit_code != 0) {
    result.log = "build failed:\n" + build_run.output;
    return result;
  }

  // esptool merge_bin: bootloader + partition table + app, at their real
  // flash offsets, into one image - same shape as the Phase 0/1 spike's
  // own manual merge_bin invocation, deliberately *without*
  // --fill-flash-size this time. That flag pads the file out to the full
  // declared flash size (4MB) with 0xFF filler - fine for a file written
  // straight to disk, but this result crosses the HTTP bridge as hex text
  // first (main.cpp's /compile), where 4MB of real image became 8MB+ of
  // hex - actually hit and had to fix (see the esp32-phase1-adapter memory
  // note): only ~244KB of this is ever non-filler (confirmed by diffing a
  // padded vs. unpadded merge_bin run), so the padding is reconstructed
  // locally instead, in esp32_qemu_adapter.cpp's load_firmware(), right
  // before writing the file QEMU's -drive actually reads.
  std::cerr << "[esp32_toolchain] starting esptool merge_bin" << std::endl;
  const auto merge_run = procexec::run_and_wait(
      toolchain->python_exe, {"-m", "esptool", "--chip", "esp32", "merge_bin", "-o", "flash_image.bin",
                              "@flash_args"},
      dir / "build", 60);
  std::cerr << "[esp32_toolchain] esptool merge_bin exit_code=" << merge_run.exit_code << std::endl;
  if (merge_run.exit_code != 0) {
    result.log = "esptool merge_bin failed:\n" + merge_run.output;
    return result;
  }

  std::ifstream bin_file(dir / "build" / "flash_image.bin", std::ios::binary);
  if (!bin_file) {
    result.log = "esptool merge_bin reported success but flash_image.bin is missing";
    return result;
  }
  std::ostringstream bin_ss;
  bin_ss << bin_file.rdbuf();

  std::cerr << "[esp32_toolchain] compile_sketch returning success, " << bin_ss.str().size() << " bytes"
            << std::endl;
  result.ok = true;
  result.binary = bin_ss.str();
  result.log = build_run.output;
  return result;
}

}  // namespace esp32toolchain
