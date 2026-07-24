// ============================================================================
// rp2040_toolchain.cpp — see rp2040_toolchain.hpp for the overview, and
// ARCHITECTURE.md's "RP2040 firmware pipeline" section for why this shells
// out to cmake/ninja rather than mirroring avr_toolchain.cpp's flat
// per-file gcc invocations, and why it jumps straight to the application's
// vector table instead of simulating the real ROM bootrom/boot2 cold boot.
// ============================================================================
#include "rp2040_toolchain.hpp"

#include <cstdlib>
#include <fstream>
#include <mutex>
#include <sstream>

#include "process_exec.hpp"

#ifdef _WIN32
#include <windows.h>
#else
#include <unistd.h>
#endif

#ifndef PHYSICALSIM_SOURCE_DIR
#define PHYSICALSIM_SOURCE_DIR ""
#endif

namespace rp2040toolchain {

namespace {

#ifdef _WIN32
constexpr const char *kGccName = "arm-none-eabi-gcc.exe";
constexpr const char *kCMakeName = "cmake.exe";
constexpr const char *kObjcopyName = "arm-none-eabi-objcopy.exe";
constexpr const char *kNinjaName = "ninja.exe";
#else
constexpr const char *kGccName = "arm-none-eabi-gcc";
constexpr const char *kCMakeName = "cmake";
constexpr const char *kObjcopyName = "arm-none-eabi-objcopy";
constexpr const char *kNinjaName = "ninja";
#endif

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

// Bundled "arm-toolchain/bin" next to the executable (BUNDLE_ARM_TOOLCHAIN
// in CMakeLists.txt, mirroring BUNDLE_AVR_TOOLCHAIN), then PATH.
std::optional<std::filesystem::path> find_toolchain_bin_dir() {
  const auto bundled = executable_dir() / "arm-toolchain" / "bin";
  std::error_code ec;
  if (std::filesystem::exists(bundled / kGccName, ec)) return bundled;
#ifdef _WIN32
#pragma warning(push)
#pragma warning(disable : 4996)  // std::getenv - fine for a read-only PATH lookup
#endif
  const char *path_env = std::getenv("PATH");
#ifdef _WIN32
#pragma warning(pop)
#endif
  if (!path_env) return std::nullopt;
  std::stringstream ss(path_env);
  std::string dir;
#ifdef _WIN32
  const char sep = ';';
#else
  const char sep = ':';
#endif
  while (std::getline(ss, dir, sep)) {
    std::filesystem::path candidate = std::filesystem::path(dir) / kGccName;
    if (std::filesystem::exists(candidate, ec)) return std::filesystem::path(dir);
  }
  return std::nullopt;
}

// Bundled "pico-sdk" next to the executable (CMakeLists.txt copies
// simulators/pico-sdk there unconditionally - it's a full, untrimmed vendored
// fork of raspberrypi/pico-sdk, ~9MB, small enough to always ship, the same
// posture ArduinoCore-avr already has), with a source-tree fallback for dev
// builds.
std::optional<std::filesystem::path> find_pico_sdk_dir() {
  const auto bundled = executable_dir() / "pico-sdk";
  std::error_code ec;
  if (std::filesystem::exists(bundled / "pico_sdk_init.cmake", ec)) return bundled;
  if (std::string(PHYSICALSIM_SOURCE_DIR).size() > 0) {
    const auto from_source = std::filesystem::path(PHYSICALSIM_SOURCE_DIR) / "simulators" / "pico-sdk";
    if (std::filesystem::exists(from_source / "pico_sdk_init.cmake", ec)) return from_source;
  }
  return std::nullopt;
}

std::optional<std::filesystem::path> find_sketch_template_dir() {
  const auto bundled = executable_dir() / "rp2040-sketch-template";
  std::error_code ec;
  if (std::filesystem::exists(bundled / "CMakeLists.txt", ec)) return bundled;
  if (std::string(PHYSICALSIM_SOURCE_DIR).size() > 0) {
    const auto from_source =
        std::filesystem::path(PHYSICALSIM_SOURCE_DIR) / "src" / "rp2040_sketch_template";
    if (std::filesystem::exists(from_source / "CMakeLists.txt", ec)) return from_source;
  }
  return std::nullopt;
}

std::filesystem::path find_program(const std::filesystem::path &bin_dir, const char *name) {
  return bin_dir / name;
}

// One persistent work directory for the whole process lifetime, reused
// across compiles - a fresh from-scratch pico-sdk CMake configure+build is
// real work (~70 translation units the first time); reusing the directory
// lets ninja's own incremental rebuild do what it's designed for (only the
// changed sketch.c needs recompiling on repeat "Compile & Run" clicks).
// Guarded by g_compile_mutex below since two concurrent compiles sharing
// this one directory would race each other's build.
std::filesystem::path work_dir() {
  return std::filesystem::temp_directory_path() / "physicalsim-rp2040-sketch";
}

std::mutex g_compile_mutex;
bool g_configured = false;

}  // namespace

bool toolchain_available() {
  return find_toolchain_bin_dir().has_value() && find_pico_sdk_dir().has_value() &&
         find_sketch_template_dir().has_value();
}

CompileResult compile_sketch(const std::string &source) {
  CompileResult result;
  std::lock_guard<std::mutex> lock(g_compile_mutex);

  const auto bin_dir = find_toolchain_bin_dir();
  const auto sdk_dir = find_pico_sdk_dir();
  const auto template_dir = find_sketch_template_dir();
  if (!bin_dir || !sdk_dir || !template_dir) {
    result.log =
        "ARM toolchain not found. Expected either a bundled copy next to "
        "physicalsim's executable (arm-toolchain/bin/) or arm-none-eabi-gcc "
        "on PATH; and the vendored pico-sdk + sketch template "
        "(pico-sdk/, rp2040-sketch-template/ next to the executable, or "
        "simulators/pico-sdk + src/rp2040_sketch_template in a dev build).";
    return result;
  }

  const auto dir = work_dir();
  std::error_code ec;
  std::filesystem::create_directories(dir, ec);

  // sketch.c: setup()/loop() bodies, wrapped the same "just the body, not a
  // full translation unit" way avr_toolchain.cpp's Arduino sketches are -
  // except this API surface is pico-sdk's own (gpio_put(), sleep_ms()), not
  // Arduino's, since no Arduino-compatible core is vendored yet (see
  // ARCHITECTURE.md).
  {
    std::ofstream sketch_file(dir / "sketch.c");
    sketch_file << "#include \"pico/stdlib.h\"\n\nvoid setup(void);\nvoid loop(void);\n\n"
                << source
                << "\n\nint main(void) {\n  setup();\n  while (true) {\n    loop();\n  }\n  "
                   "return 0;\n}\n";
  }

  if (!g_configured) {
    std::error_code copy_ec;
    std::filesystem::copy_file(*template_dir / "CMakeLists.txt", dir / "CMakeLists.txt",
                                std::filesystem::copy_options::overwrite_existing, copy_ec);

    const auto cmake = find_program(*bin_dir, kCMakeName);
    // If cmake/ninja aren't in the ARM toolchain's own bin dir (they
    // usually aren't - those are separate system tools), fall back to
    // whatever's on PATH, the same way find_toolchain_bin_dir() itself
    // falls back to PATH for arm-none-eabi-gcc.
    const auto cmake_exe = std::filesystem::exists(cmake) ? cmake : std::filesystem::path(kCMakeName);
    const std::vector<std::string> configure_args = {
        "-G",
        "Ninja",
        "-B",
        "build",
        "-DPICO_SDK_PATH=" + sdk_dir->string(),
        "-DPICO_TOOLCHAIN_PATH=" + bin_dir->string(),
        "-DPICO_BOARD=arduino_nano_rp2040_connect",
        "-DPICO_NO_PICOTOOL=1",
    };
    // 120s: a from-scratch pico-sdk configure (toolchain detection +
    // feature probing) is slower than a single AVR compile step, but still
    // bounded.
    const auto configure_run = procexec::run_and_wait(cmake_exe, configure_args, dir, 120);
    if (configure_run.exit_code != 0) {
      result.log = "cmake configure failed:\n" + configure_run.output;
      return result;
    }
    g_configured = true;
  }

  const auto cmake = find_program(*bin_dir, kCMakeName);
  const auto cmake_exe = std::filesystem::exists(cmake) ? cmake : std::filesystem::path(kCMakeName);
  // 120s: a first build compiles the whole pico-sdk (~70 files); later
  // builds only recompile sketch.c and relink, much faster, but the bound
  // has to cover the slow first case.
  const auto build_run =
      procexec::run_and_wait(cmake_exe, {"--build", "build"}, dir, 120);
  if (build_run.exit_code != 0) {
    result.log = "build failed:\n" + build_run.output;
    return result;
  }

  const auto elf_path = dir / "build" / "sketch.elf";
  const auto bin_path = dir / "build" / "sketch.bin";
  const auto objcopy = find_program(*bin_dir, kObjcopyName);
  const auto objcopy_run =
      procexec::run_and_wait(objcopy, {"-O", "binary", elf_path.string(), bin_path.string()}, dir, 30);
  if (objcopy_run.exit_code != 0) {
    result.log = "objcopy failed:\n" + objcopy_run.output;
    return result;
  }

  std::ifstream bin_file(bin_path, std::ios::binary);
  std::ostringstream bin_ss;
  bin_ss << bin_file.rdbuf();

  result.ok = true;
  result.binary = bin_ss.str();
  result.log = build_run.output;
  return result;
}

}  // namespace rp2040toolchain
