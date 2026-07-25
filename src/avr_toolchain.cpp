// ============================================================================
// avr_toolchain.cpp — see avr_toolchain.hpp for the overview.
// ============================================================================
#include "avr_toolchain.hpp"

#include <atomic>
#include <cstdlib>
#include <fstream>
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

namespace avrtoolchain {

namespace {

// ---- Locating things, mirroring qemu_adapter.cpp's own helpers ------------

#ifdef _WIN32
constexpr const char *kGxxName = "avr-g++.exe";
constexpr const char *kGccName = "avr-gcc.exe";
constexpr const char *kObjcopyName = "avr-objcopy.exe";
#else
constexpr const char *kGxxName = "avr-g++";
constexpr const char *kGccName = "avr-gcc";
constexpr const char *kObjcopyName = "avr-objcopy";
#endif

std::filesystem::path executable_dir() {
#ifdef _WIN32
  wchar_t path[MAX_PATH]{};
  const auto len = GetModuleFileNameW(nullptr, path, MAX_PATH);
  if (len == 0 || len >= MAX_PATH) {
    return std::filesystem::current_path();
  }
  return std::filesystem::path(path).parent_path();
#else
  char path[4096]{};
  const auto len = readlink("/proc/self/exe", path, sizeof(path) - 1);
  if (len <= 0) {
    return std::filesystem::current_path();
  }
  path[len] = '\0';
  return std::filesystem::path(path).parent_path();
#endif
}

std::optional<std::filesystem::path> find_on_path(const std::string &exe_name) {
#ifdef _WIN32
  const char separator = ';';
  char *raw_path = nullptr;
  std::size_t raw_path_len = 0;
  if (_dupenv_s(&raw_path, &raw_path_len, "PATH") != 0 || !raw_path) {
    return std::nullopt;
  }
  std::string path_str(raw_path);
  free(raw_path);
#else
  const char separator = ':';
  const char *path_env = std::getenv("PATH");
  if (!path_env) return std::nullopt;
  std::string path_str(path_env);
#endif
  std::size_t start = 0;
  while (start <= path_str.size()) {
    auto end = path_str.find(separator, start);
    if (end == std::string::npos) end = path_str.size();
    if (end > start) {
      std::filesystem::path candidate =
          std::filesystem::path(path_str.substr(start, end - start)) / exe_name;
      std::error_code ec;
      if (std::filesystem::exists(candidate, ec)) {
        return candidate.parent_path();
      }
    }
    start = end + 1;
  }
  return std::nullopt;
}

// The real Arduino IDE/arduino-cli install their own copy of avr-gcc under
// a per-platform "packages/arduino/tools/avr-gcc/<version>/bin" directory -
// if the user happens to already have the Arduino IDE installed, reuse it
// rather than requiring physicalsim's own bundled copy.
std::vector<std::filesystem::path> well_known_toolchain_roots() {
#ifdef _WIN32
  std::vector<std::filesystem::path> roots;
  char *local_appdata = nullptr;
  std::size_t len = 0;
  if (_dupenv_s(&local_appdata, &len, "LOCALAPPDATA") == 0 && local_appdata) {
    roots.push_back(std::filesystem::path(local_appdata) / "Arduino15" / "packages" /
                     "arduino" / "tools" / "avr-gcc");
    free(local_appdata);
  }
  return roots;
#else
  std::vector<std::filesystem::path> roots;
  const char *home = std::getenv("HOME");
  if (home) {
    roots.push_back(std::filesystem::path(home) / ".arduino15" / "packages" / "arduino" /
                     "tools" / "avr-gcc");
  }
  return roots;
#endif
}

// Arduino's own install lays out multiple versions side by side
// ("avr-gcc/7.3.0-atmel3.6.1-arduino7/bin/..."); return the first version
// directory whose bin/ actually contains avr-g++, not just the first
// directory entry.
std::optional<std::filesystem::path> find_well_known_toolchain() {
  for (const auto &root : well_known_toolchain_roots()) {
    std::error_code ec;
    if (!std::filesystem::is_directory(root, ec)) continue;
    for (const auto &entry : std::filesystem::directory_iterator(root, ec)) {
      if (!entry.is_directory()) continue;
      const auto bin = entry.path() / "bin";
      if (std::filesystem::exists(bin / kGxxName, ec)) {
        return bin;
      }
    }
  }
  return std::nullopt;
}

std::optional<std::filesystem::path> find_toolchain_bin_dir() {
  // A bundled copy (CMake's BUNDLE_AVR_TOOLCHAIN option) takes priority -
  // packaged builds shouldn't depend on what happens to already be
  // installed, same reasoning as find_qemu_system_arm().
  const auto bundled = executable_dir() / "avr-toolchain" / "bin";
  std::error_code ec;
  if (std::filesystem::exists(bundled / kGxxName, ec)) {
    return bundled;
  }
  if (auto on_path = find_on_path(kGxxName)) {
    return on_path;
  }
  return find_well_known_toolchain();
}

// "arduino" (ArduinoCore-avr's cores/arduino - every ATmega board) or
// "tiny" (ATTinyCore's cores/tiny - ATtiny85/Franzininho, see
// resolve_board_target() below) - a genuinely different core tree, not
// just a different variant of the same one, since ATtiny85 has no
// USART/SPI/TWI hardware and a much smaller register set.
std::optional<std::filesystem::path> find_core_dir(const std::string &core_kind) {
  const auto bundled_root = core_kind == "tiny" ? "attiny-core" : "avr-core";
  const auto source_repo = core_kind == "tiny" ? "ATTinyCore" : "ArduinoCore-avr";
  const auto core_subpath = core_kind == "tiny"
                                 ? std::filesystem::path("avr") / "cores" / "tiny"
                                 : std::filesystem::path("cores") / "arduino";
  const auto bundled_subpath =
      core_kind == "tiny" ? std::filesystem::path("cores") / "tiny" : std::filesystem::path("cores") / "arduino";

  const auto bundled = executable_dir() / bundled_root / bundled_subpath;
  std::error_code ec;
  if (std::filesystem::exists(bundled / "Arduino.h", ec)) {
    return bundled;
  }
  if (std::string(PHYSICALSIM_SOURCE_DIR).size() > 0) {
    const auto from_source =
        std::filesystem::path(PHYSICALSIM_SOURCE_DIR) / "simulators" / source_repo / core_subpath;
    if (std::filesystem::exists(from_source / "Arduino.h", ec)) {
      return from_source;
    }
  }
  return std::nullopt;
}

// Board -> {-mmcu= value, which core tree, its own variants/ subdirectory,
// the ARDUINO_AVR_* define real Arduino board.txt files set for it,
// F_CPU}. Every entry here is atmega328p + "arduino" core + 16MHz except
// Mega (a genuinely different chip - see chip.ts's own AvrChipConfig on
// the JS/TS side for the CPU-emulation half of this same board/chip
// split) and Franzininho (a genuinely different chip AND core tree - see
// find_core_dir() above). Keyed by circuit.ts's CircuitBoard.type string,
// so it stays in lockstep with boardAdapterId there without either file
// importing the other (this is native C++, that's TS - there's no shared
// module to put one canonical table in).
struct BoardTarget {
  std::string mcu;        // avr-gcc -mmcu=
  std::string core_kind;  // find_core_dir()'s "arduino" or "tiny"
  std::string variant;    // <core tree>/variants/<variant>
  std::string define;     // -D<define>
  std::string f_cpu;      // -DF_CPU=<f_cpu>
  // USB vendor/product id, only non-empty for USBCON boards (Leonardo) -
  // ArduinoCore-avr's own USBCore.cpp references USB_VID/USB_PID as bare
  // preprocessor symbols with no fallback definition anywhere in the
  // core/variant tree; the real Arduino IDE supplies them from boards.txt
  // as compiler -D flags (leonardo.build.vid/build.pid there), which
  // isn't something this project reads, so the real values are inlined
  // here instead.
  std::string usb_vid;
  std::string usb_pid;
};

BoardTarget resolve_board_target(const std::string &board) {
  if (board == "arduino-nano") {
    return BoardTarget{"atmega328p", "arduino", "standard", "ARDUINO_AVR_NANO", "16000000L", "", ""};
  }
  if (board == "arduino-mega") {
    return BoardTarget{"atmega2560", "arduino", "mega", "ARDUINO_AVR_MEGA2560", "16000000L", "", ""};
  }
  // ATmega32u4 - still ArduinoCore-avr's own core (unlike Franzininho),
  // just its "leonardo" variant instead of "standard"/"mega" - already
  // vendored (simulators/ArduinoCore-avr/variants/leonardo), just not
  // bundled by CMakeLists.txt's POST_BUILD copy step until now. Real
  // Leonardo runs a 16MHz crystal, same as every other ATmega board here.
  // usb_vid/usb_pid are ArduinoCore-avr's own boards.txt values
  // (leonardo.build.vid/build.pid) - required for USBCore.cpp to even
  // compile (see BoardTarget's own comment on usb_vid/usb_pid above).
  if (board == "arduino-leonardo") {
    return BoardTarget{"atmega32u4", "arduino", "leonardo", "ARDUINO_AVR_LEONARDO",
                        "16000000L",  "0x2341", "0x8036"};
  }
  // ATTinyCore's own boards.txt: attinyx5.build.mcu=attiny85 (the "no
  // bootloader" ATtiny85/45/25 target, its default clock menu entry -
  // 8MHz internal oscillator, no crystal, matching real ATtiny85 chips'
  // out-of-box fuse configuration and Franzininho's own bare-board
  // design, which has no external crystal footprint).
  if (board == "franzininho") {
    return BoardTarget{"attiny85", "tiny", "tinyx5", "ARDUINO_AVR_ATTINYX5", "8000000UL", "", ""};
  }
  // "arduino-uno", empty, or anything unrecognized - the original
  // single-board behavior this function generalizes, preserved as the
  // fallback rather than failing outright.
  return BoardTarget{"atmega328p", "arduino", "standard", "ARDUINO_AVR_UNO", "16000000L", "", ""};
}

std::optional<std::filesystem::path> find_variant_dir(const std::string &core_kind, const std::string &variant) {
  const auto bundled_root = core_kind == "tiny" ? "attiny-core" : "avr-core";
  const auto source_repo = core_kind == "tiny" ? "ATTinyCore" : "ArduinoCore-avr";
  const auto variant_subpath = core_kind == "tiny" ? std::filesystem::path("avr") / "variants" / variant
                                                    : std::filesystem::path("variants") / variant;

  const auto bundled = executable_dir() / bundled_root / "variants" / variant;
  std::error_code ec;
  if (std::filesystem::exists(bundled / "pins_arduino.h", ec)) {
    return bundled;
  }
  if (std::string(PHYSICALSIM_SOURCE_DIR).size() > 0) {
    const auto from_source =
        std::filesystem::path(PHYSICALSIM_SOURCE_DIR) / "simulators" / source_repo / variant_subpath;
    if (std::filesystem::exists(from_source / "pins_arduino.h", ec)) {
      return from_source;
    }
  }
  return std::nullopt;
}

// Every vendored Arduino library a sketch is allowed to #include - one
// git submodule per name (simulators/<name>), each following the modern
// Arduino 1.5+ layout (headers/sources directly under its own src/).
// Adding a second library is one more name here plus one more line in
// CMakeLists.txt's own AVR_LIBRARIES list - nothing else in this file
// needs to change, since compile_sketch() below just iterates whatever
// find_library_dirs() returns.
const std::vector<std::string> &known_libraries() {
  static const std::vector<std::string> libs = {"LiquidCrystal"};
  return libs;
}

// Same bundled-next-to-executable-first, source-tree-fallback shape as
// find_core_dir()/find_variant_dir() above, just per-library and
// tolerant of a missing one (returns whatever resolved, not all-or-
// nothing) - a library that hasn't been bundled yet (or was dropped from
// CMakeLists.txt) just isn't available to #include, it doesn't break
// every other sketch.
std::vector<std::filesystem::path> find_library_dirs() {
  std::vector<std::filesystem::path> dirs;
  std::error_code ec;
  for (const auto &name : known_libraries()) {
    const auto bundled = executable_dir() / "avr-libraries" / name / "src";
    if (std::filesystem::is_directory(bundled, ec)) {
      dirs.push_back(bundled);
      continue;
    }
    if (std::string(PHYSICALSIM_SOURCE_DIR).size() > 0) {
      const auto from_source =
          std::filesystem::path(PHYSICALSIM_SOURCE_DIR) / "simulators" / name / "src";
      if (std::filesystem::is_directory(from_source, ec)) {
        dirs.push_back(from_source);
      }
    }
  }
  return dirs;
}

using procexec::RunResult;
using procexec::run_and_wait;

std::atomic<int> g_step_counter{0};

// Common flags shared by every compile step, matching what a real
// arduino-cli build uses for the target board: -Os for flash-size-
// conscious code, LTO + --gc-sections to drop unused core functions, and
// the board's own ARDUINO_AVR_*/ARDUINO_ARCH_AVR defines since some core
// code branches on them. F_CPU comes from target.f_cpu - 16MHz for every
// ATmega board (Uno/Nano/Mega all run their crystal at 16MHz), 8MHz for
// Franzininho (ATtiny85's internal oscillator, no external crystal).
std::vector<std::string> common_flags(const ToolchainPaths &tc, const BoardTarget &target) {
  std::vector<std::string> flags = {
      "-w", "-Os", "-g", "-ffunction-sections", "-fdata-sections", "-flto",
      "-mmcu=" + target.mcu, "-DF_CPU=" + target.f_cpu, "-DARDUINO=10819",
      "-D" + target.define, "-DARDUINO_ARCH_AVR",
      "-I" + tc.core_dir.string(), "-I" + tc.variant_dir.string(),
  };
  // USBCON boards only (Leonardo) - USBCore.cpp references these as bare
  // preprocessor symbols with no fallback definition anywhere in the
  // core/variant tree (see BoardTarget's own comment).
  if (!target.usb_vid.empty()) flags.push_back("-DUSB_VID=" + target.usb_vid);
  if (!target.usb_pid.empty()) flags.push_back("-DUSB_PID=" + target.usb_pid);
  // Each vendored library's own src/ dir, so "#include <LiquidCrystal.h>"
  // resolves the same way it would against a real Arduino IDE install -
  // one -I per library, not a single shared include root, since each
  // library's headers live directly under its own src/ (no shared parent
  // directory to point at instead).
  for (const auto &dir : tc.library_dirs) flags.push_back("-I" + dir.string());
  return flags;
}

}  // namespace

std::optional<ToolchainPaths> find_toolchain(const std::string &board) {
  const auto target = resolve_board_target(board);
  auto bin_dir = find_toolchain_bin_dir();
  auto core_dir = find_core_dir(target.core_kind);
  auto variant_dir = find_variant_dir(target.core_kind, target.variant);
  if (!bin_dir || !core_dir || !variant_dir) {
    return std::nullopt;
  }
  return ToolchainPaths{*bin_dir, *core_dir, *variant_dir, find_library_dirs()};
}

CompileResult compile_sketch(const std::string &source, const std::string &board) {
  CompileResult result;

  const auto target = resolve_board_target(board);
  const auto toolchain = find_toolchain(board);
  if (!toolchain) {
    const std::string core_root = target.core_kind == "tiny" ? "attiny-core/" : "avr-core/";
    const std::string core_repo = target.core_kind == "tiny" ? "ATTinyCore" : "ArduinoCore-avr";
    result.log =
        "AVR toolchain not found for board \"" + board + "\" (resolved variant \"" + target.variant +
        "\"). Expected either a bundled copy next to physicalsim's executable "
        "(avr-toolchain/bin/), avr-g++ on PATH, or an Arduino IDE install; and "
        "the vendored core + variant (" + core_root + " next to the executable, or "
        "simulators/" + core_repo + " in a dev build).";
    return result;
  }

  // A fresh temp directory per compile - every intermediate .o/.elf/.hex
  // and this session's step logs live here, all removed at the end
  // (success or failure) so repeated "Compile & Run" clicks don't leak
  // files.
  const auto work_dir = std::filesystem::temp_directory_path() /
                         ("physicalsim-compile-" + std::to_string(g_step_counter.fetch_add(1)));
  std::error_code ec;
  std::filesystem::create_directories(work_dir, ec);

  auto cleanup = [&work_dir]() {
    std::error_code rm_ec;
    std::filesystem::remove_all(work_dir, rm_ec);
  };

  // Sketches are plain function bodies + setup()/loop(), not full
  // translation units - the same assumption the real .ino -> .cpp wrapping
  // step makes.
  {
    std::ofstream sketch_file(work_dir / "sketch.cpp");
    sketch_file << "#include <Arduino.h>\n" << source;
  }

  const auto gxx = toolchain->bin_dir / kGxxName;
  const auto gcc = toolchain->bin_dir / kGccName;
  const auto objcopy = toolchain->bin_dir / kObjcopyName;
  const auto flags = common_flags(*toolchain, target);

  std::vector<std::filesystem::path> object_files;
  std::ostringstream full_log;

  auto compile_one = [&](const std::filesystem::path &src, bool is_cpp) -> bool {
    // Prefixed with a running counter, not just the filename - core and
    // library directories are compiled from separate source trees now
    // (see the library loop below), so two files sharing a basename
    // (e.g. two "utility.cpp"s) would otherwise silently overwrite each
    // other's .o in this shared work_dir.
    const auto obj =
        work_dir / (std::to_string(g_step_counter.fetch_add(1)) + "-" + src.filename().string() + ".o");
    std::vector<std::string> args = flags;
    if (is_cpp) {
      args.insert(args.end(), {"-std=gnu++11", "-fpermissive", "-fno-exceptions",
                                "-fno-threadsafe-statics"});
    } else {
      args.insert(args.end(), {"-std=gnu11"});
    }
    args.push_back("-c");
    args.push_back(src.string());
    args.push_back("-o");
    args.push_back(obj.string());

    const auto run = run_and_wait(is_cpp ? gxx : gcc, args, work_dir);
    full_log << run.output;
    if (run.exit_code != 0) return false;
    object_files.push_back(obj);
    return true;
  };

  bool ok = compile_one(work_dir / "sketch.cpp", /*is_cpp=*/true);

  if (ok) {
    for (const auto &entry : std::filesystem::directory_iterator(toolchain->core_dir, ec)) {
      if (!ok) break;
      if (!entry.is_regular_file()) continue;
      const auto ext = entry.path().extension().string();
      if (ext == ".c") {
        ok = compile_one(entry.path(), /*is_cpp=*/false);
      } else if (ext == ".cpp") {
        ok = compile_one(entry.path(), /*is_cpp=*/true);
      }
    }
  }

  // Every vendored library's own sources, compiled unconditionally
  // alongside the core - same posture as the core loop above: whether a
  // given sketch actually #includes a library or not, -ffunction-
  // sections/--gc-sections (already in common_flags()/the link step
  // below) drops whatever the linker never reaches, so there's no need
  // to detect which #includes a sketch actually has first.
  if (ok) {
    for (const auto &lib_dir : toolchain->library_dirs) {
      if (!ok) break;
      for (const auto &entry : std::filesystem::directory_iterator(lib_dir, ec)) {
        if (!ok) break;
        if (!entry.is_regular_file()) continue;
        const auto ext = entry.path().extension().string();
        if (ext == ".c") {
          ok = compile_one(entry.path(), /*is_cpp=*/false);
        } else if (ext == ".cpp") {
          ok = compile_one(entry.path(), /*is_cpp=*/true);
        }
      }
    }
  }

  if (!ok) {
    result.log = full_log.str();
    cleanup();
    return result;
  }

  // Link - avr-gcc (not avr-g++) as the final linker driver, matching
  // arduino-cli's own convention; -lm for the libm functions the core
  // itself (and common sketches) pull in.
  const auto elf_path = work_dir / "sketch.elf";
  {
    std::vector<std::string> link_args = {
        "-w", "-Os", "-g", "-flto", "-fuse-linker-plugin", "-Wl,--gc-sections",
        "-mmcu=" + target.mcu, "-o", elf_path.string(),
    };
    for (const auto &obj : object_files) link_args.push_back(obj.string());
    link_args.push_back("-lm");

    const auto run = run_and_wait(gcc, link_args, work_dir);
    full_log << run.output;
    if (run.exit_code != 0) {
      result.log = full_log.str();
      cleanup();
      return result;
    }
  }

  // Intel HEX, matching exactly what "Load .hex..." already expects.
  const auto hex_path = work_dir / "sketch.hex";
  {
    const std::vector<std::string> objcopy_args = {
        "-O", "ihex", "-R", ".eeprom", elf_path.string(), hex_path.string(),
    };
    const auto run = run_and_wait(objcopy, objcopy_args, work_dir);
    full_log << run.output;
    if (run.exit_code != 0) {
      result.log = full_log.str();
      cleanup();
      return result;
    }
  }

  std::ifstream hex_file(hex_path);
  std::ostringstream hex_ss;
  hex_ss << hex_file.rdbuf();

  result.ok = true;
  result.hex_text = hex_ss.str();
  result.log = full_log.str();
  cleanup();
  return result;
}

}  // namespace avrtoolchain
