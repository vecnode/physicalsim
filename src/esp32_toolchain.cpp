// ============================================================================
// esp32_toolchain.cpp — see esp32_toolchain.hpp for the overview.
// ============================================================================
#include "esp32_toolchain.hpp"

#include <cstdlib>
#include <fstream>
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

namespace esp32toolchain {

namespace {

// ---- Toolchain discovery ---------------------------------------------------
// Dev-machine-only today, deliberately: fixed paths under this machine's
// esp-idf checkout (C:\esp-idf) and the tools `install.ps1 esp32` put under
// C:\Users\<user>\.espressif - not a bundled-next-to-the-exe or
// FetchContent-fetched copy the way avr-gcc/arm-none-eabi-gcc are (see
// esp32_toolchain.hpp's header comment). A real BUNDLE_XTENSA_TOOLCHAIN
// (mirroring CMakeLists.txt's BUNDLE_ARM_TOOLCHAIN) is real follow-up work,
// not done here - this exists so "Compile & Run" genuinely works today on
// the machine it was developed on, without pretending it's portable yet.
#ifdef _WIN32
std::optional<std::filesystem::path> find_esp_idf_dir() {
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
  const auto esp_idf_dir = find_esp_idf_dir();
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

  paths.xtensa_gcc_bin_dir = *xtensa_versioned / "xtensa-esp-elf" / "bin";
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
#ifndef PHYSICALSIM_SOURCE_DIR
#define PHYSICALSIM_SOURCE_DIR ""
#endif
  const std::string source_dir = PHYSICALSIM_SOURCE_DIR;
  if (source_dir.empty()) return std::nullopt;
  const auto candidate = std::filesystem::path(source_dir) / "src" / "esp32_sketch_template";
  std::error_code ec;
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

  const auto toolchain = find_toolchain();
  const auto template_dir = find_sketch_template_dir();
  if (!toolchain || !template_dir) {
    result.log =
        "ESP32 toolchain not found. Expected an esp-idf checkout at C:\\esp-idf and tools "
        "installed under %USERPROFILE%\\.espressif (see `install.ps1 esp32` in an esp-idf "
        "checkout) - see esp32_toolchain.hpp for why this isn't bundled/portable yet.";
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
    // 180s: a from-scratch ESP-IDF component-tree configure (the whole
    // component list, kconfig defaults, sdkconfig generation) is real work
    // - slower than pico-sdk's own configure, bounded but generous.
    const auto configure_run = procexec::run_and_wait(toolchain->cmake_exe, configure_args, dir, 180);
    if (configure_run.exit_code != 0) {
      result.log = "cmake configure failed:\n" + configure_run.output;
      return result;
    }
    g_configured = true;
  }

  // 180s: a first build compiles the whole ESP-IDF component tree
  // (bootloader + every linked component) - later builds only recompile
  // main.c and relink, much faster, but the bound has to cover the slow
  // first case (this was the actual observed order of magnitude during
  // the Phase 0/1 spike's own from-scratch build).
  const auto build_run = procexec::run_and_wait(toolchain->cmake_exe, {"--build", "build"}, dir, 180);
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
  const auto merge_run = procexec::run_and_wait(
      toolchain->python_exe, {"-m", "esptool", "--chip", "esp32", "merge_bin", "-o", "flash_image.bin",
                              "@flash_args"},
      dir / "build", 60);
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

  result.ok = true;
  result.binary = bin_ss.str();
  result.log = build_run.output;
  return result;
}

}  // namespace esp32toolchain
