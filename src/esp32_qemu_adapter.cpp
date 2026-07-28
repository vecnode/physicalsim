// ============================================================================
// esp32_qemu_adapter.cpp — see esp32_qemu_adapter.hpp for the overview.
// ============================================================================
#ifdef __GNUC__
#  pragma GCC diagnostic push
#  pragma GCC diagnostic ignored "-Wshadow"
#  pragma GCC diagnostic ignored "-Wconversion"
#endif
#include <boost/asio.hpp>
#ifdef __GNUC__
#  pragma GCC diagnostic pop
#endif

#include "esp32_qemu_adapter.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#else
#include <signal.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>
extern char **environ;
#endif

namespace esp32qemu {

namespace {

#ifdef _WIN32
constexpr const char *kExeName = "qemu-system-xtensa.exe";
#else
constexpr const char *kExeName = "qemu-system-xtensa";
#endif

// GPIO peripheral base address on real ESP32 silicon (and in QEMU's model,
// hw/esp32/esp32_gpio.c) - GPIO_OUT_REG sits at offset 0x04 within it,
// GPIO_ENABLE_REG (direction, 1 = output) at offset 0x20.
constexpr std::uint32_t kGpioOutRegAddress = 0x3ff44004;
constexpr std::uint32_t kGpioEnableRegAddress = 0x3ff44020;

// ESP32 ADC1's fixed GPIO-to-channel map (TRM Table 4-3) - the only 8 pins
// with a real SAR ADC channel behind them. -1 means "not ADC1-capable".
int adc1_channel_for_gpio(int gpio) {
  switch (gpio) {
    case 36: return 0;
    case 37: return 1;
    case 38: return 2;
    case 39: return 3;
    case 32: return 4;
    case 33: return 5;
    case 34: return 6;
    case 35: return 7;
    default: return -1;
  }
}

std::optional<std::filesystem::path> find_on_path() {
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
          std::filesystem::path(path_str.substr(start, end - start)) / kExeName;
      std::error_code ec;
      if (std::filesystem::exists(candidate, ec)) {
        return candidate;
      }
    }
    start = end + 1;
  }
  return std::nullopt;
}

std::string current_process_id_string() {
#ifdef _WIN32
  return std::to_string(GetCurrentProcessId());
#else
  return std::to_string(getpid());
#endif
}

// Same "bind port 0, read it back, close" trick as qemu_adapter.cpp's
// reserve_free_port() - duplicated rather than shared, see this file's own
// header comment on why these two QEMU-backed adapters stay self-contained.
int reserve_free_port(boost::asio::io_context &io) {
  boost::asio::ip::tcp::acceptor acceptor(
      io, boost::asio::ip::tcp::endpoint(boost::asio::ip::make_address("127.0.0.1"), 0));
  const int port = acceptor.local_endpoint().port();
  acceptor.close();
  return port;
}

// ---- Minimal GDB Remote Serial Protocol client -----------------------------
// Just enough of the $packet#checksum protocol for memory reads ('m') and
// monitor commands ('qRcmd', run_monitor_command() below).
std::string rsp_checksum(const std::string &data) {
  unsigned int sum = 0;
  for (unsigned char c : data) sum += c;
  sum &= 0xff;
  std::ostringstream oss;
  oss << std::hex << std::setfill('0') << std::setw(2) << sum;
  return oss.str();
}

void rsp_send(boost::asio::ip::tcp::socket &sock, const std::string &data) {
  const std::string packet = "$" + data + "#" + rsp_checksum(data);
  boost::asio::write(sock, boost::asio::buffer(packet));
  std::array<char, 1> ack{};
  boost::asio::read(sock, boost::asio::buffer(ack));
}

std::string rsp_recv(boost::asio::ip::tcp::socket &sock) {
  std::string buf;
  char c = 0;
  do {
    boost::asio::read(sock, boost::asio::buffer(&c, 1));
  } while (c != '$');

  while (true) {
    boost::asio::read(sock, boost::asio::buffer(&c, 1));
    if (c == '#') break;
    buf += c;
  }
  std::array<char, 2> checksum{};
  boost::asio::read(sock, boost::asio::buffer(checksum));

  const char ack = '+';
  boost::asio::write(sock, boost::asio::buffer(&ack, 1));
  return buf;
}

std::string to_hex(const std::string &data) {
  static const char *digits = "0123456789abcdef";
  std::string hex;
  hex.reserve(data.size() * 2);
  for (unsigned char c : data) {
    hex.push_back(digits[c >> 4]);
    hex.push_back(digits[c & 0xf]);
  }
  return hex;
}

// Runs an HMP monitor command line (e.g. "esp32_set_gpio_input 5 1") over
// the same GDB RSP connection read_memory_word() uses, via GDB's "monitor"
// extension (qRcmd, hex-encoded) - gdbstub/system.c's
// gdb_handle_query_rcmd() dispatches this straight into QEMU's HMP monitor.
// Any monitor_printf() output the command produces comes back as one or
// more "O<hex>" packets before the final "OK"/"E<nn>" - discarded here
// (the two commands this adapter needs print nothing), but still read off
// the socket so a later, unrelated read doesn't pick up a stale reply.
void run_monitor_command(boost::asio::ip::tcp::socket &sock, const std::string &command) {
  rsp_send(sock, "qRcmd," + to_hex(command));
  while (true) {
    const std::string reply = rsp_recv(sock);
    if (reply == "OK") return;
    if (!reply.empty() && reply[0] == 'E') {
      throw std::runtime_error("esp32 adapter: monitor command \"" + command + "\" failed: " + reply);
    }
    // "O<hex>" (monitor output) - keep reading until OK/E.
  }
}

// Parses a byte string from GDB's 'm' (read memory) reply - unlike
// register dumps, memory bytes come back in normal address order (byte 0
// is the lowest address), so a little-endian 32-bit word is
// b0 | b1<<8 | b2<<16 | b3<<24, not the reversed-pairs decoding
// parse_le_hex_register() does for register packets.
std::uint32_t parse_le_hex_memory_word(const std::string &hex_bytes) {
  if (hex_bytes.size() < 8) {
    throw std::runtime_error("unexpected memory-read packet from qemu gdbstub");
  }
  std::uint32_t value = 0;
  for (int i = 0; i < 4; ++i) {
    const auto byte = static_cast<std::uint32_t>(
        std::stoul(hex_bytes.substr(static_cast<std::size_t>(i) * 2, 2), nullptr, 16));
    value |= byte << (i * 8);
  }
  return value;
}

// "D18" / "GP18" / "GPIO18" / "18" -> 18. Throws if no trailing digits are
// found - a clearer error than silently treating an unparsable pin as 0.
int parse_gpio_number(const std::string &pin) {
  std::size_t i = pin.size();
  while (i > 0 && std::isdigit(static_cast<unsigned char>(pin[i - 1]))) --i;
  if (i == pin.size()) {
    throw std::runtime_error("esp32 adapter: pin \"" + pin + "\" has no GPIO number");
  }
  return std::stoi(pin.substr(i));
}

}  // namespace

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

std::optional<std::filesystem::path> find_qemu_system_xtensa() {
  const auto bundled = executable_dir() / "esp32-qemu" / kExeName;
  std::error_code ec;
  if (std::filesystem::exists(bundled, ec)) {
    return bundled;
  }
  return find_on_path();
}

namespace {

// "esp32-qemu/pc-bios" next to the executable (CMake's BUNDLE_QEMU_XTENSA
// copies vecnode/qemu-esp32's pc-bios/ ROM images there - esp32-v3-rom.bin
// etc. - the same files -L pointed at during the Phase 0 spike) - falls
// back to a directory alongside whatever qemu-system-xtensa was found on,
// in case a dev has it on PATH with its pc-bios/ next to it.
std::optional<std::filesystem::path> find_bios_dir(const std::filesystem::path &exe) {
  const auto bundled = executable_dir() / "esp32-qemu" / "pc-bios";
  std::error_code ec;
  if (std::filesystem::exists(bundled, ec)) {
    return bundled;
  }
  const auto next_to_exe = exe.parent_path() / "pc-bios";
  if (std::filesystem::exists(next_to_exe, ec)) {
    return next_to_exe;
  }
  return std::nullopt;
}

// "esp32-demo/flash_image.bin" next to the executable - the fixed demo
// firmware this adapter boots until a real sketch-compile pipeline exists
// for esp32 (see this file's header comment). CMake's BUNDLE_QEMU_XTENSA
// copies it there from a dev-provided path, same posture as the QEMU
// binary/ROMs above.
std::optional<std::filesystem::path> find_demo_flash_image() {
  const auto bundled = executable_dir() / "esp32-demo" / "flash_image.bin";
  std::error_code ec;
  if (std::filesystem::exists(bundled, ec)) {
    return bundled;
  }
  return std::nullopt;
}

}  // namespace

struct Esp32QemuInstance::Impl {
  boost::asio::io_context io;
  boost::asio::ip::tcp::socket qmp_socket{io};
  boost::asio::ip::tcp::socket gdb_socket{io};
  int qmp_port = 0;
  int gdb_port = 0;
  std::filesystem::path resolved_exe;
  // Set by load_firmware() (see Esp32QemuInstance::load_firmware below) -
  // when present, spawn() boots this instead of the bundled demo image.
  std::optional<std::filesystem::path> firmware_override;

#ifdef _WIN32
  PROCESS_INFORMATION process_info{};
  bool process_started = false;
  std::filesystem::path log_path;
  // Same KILL_ON_JOB_CLOSE rationale as qemu_adapter.cpp's Impl - guarantees
  // qemu-system-xtensa doesn't outlive physicalsim even if it's killed
  // externally (taskkill /F, crash) rather than exiting through our own
  // destructor.
  HANDLE job_handle = nullptr;
#else
  pid_t pid = -1;
  bool process_started = false;
#endif

  std::string read_log_tail() const {
#ifdef _WIN32
    if (log_path.empty()) return {};
    std::ifstream f(log_path);
    if (!f) return {};
    std::ostringstream ss;
    ss << f.rdbuf();
    return ss.str();
#else
    return {};
#endif
  }

  ~Impl() { kill_process(); }

  void kill_process() {
    if (!process_started) return;
#ifdef _WIN32
    TerminateProcess(process_info.hProcess, 0);
    WaitForSingleObject(process_info.hProcess, 2000);
    CloseHandle(process_info.hProcess);
    CloseHandle(process_info.hThread);
    if (job_handle) {
      CloseHandle(job_handle);
      job_handle = nullptr;
    }
#else
    kill(pid, SIGTERM);
    int status = 0;
    waitpid(pid, &status, 0);
#endif
    process_started = false;
  }

  void spawn(const std::filesystem::path &exe) {
    resolved_exe = exe;
    const auto bios_dir = find_bios_dir(exe);
    if (!bios_dir) {
      throw std::runtime_error(
          "esp32 adapter: qemu-esp32/pc-bios (ROM images) not found next to "
          "qemu-system-xtensa - see CMakeLists.txt's BUNDLE_QEMU_XTENSA");
    }
    const auto flash_image = firmware_override ? firmware_override : find_demo_flash_image();
    if (!flash_image) {
      throw std::runtime_error(
          "esp32 adapter: no demo flash image bundled (esp32-demo/flash_image.bin) - "
          "see esp32_qemu_adapter.hpp's header comment on why this adapter needs one "
          "until a real sketch-compile pipeline exists for esp32");
    }

    qmp_port = reserve_free_port(io);
    gdb_port = reserve_free_port(io);

    std::ostringstream qmp_arg;
    qmp_arg << "tcp:127.0.0.1:" << qmp_port << ",server=on,wait=off";
    std::ostringstream gdb_arg;
    gdb_arg << "tcp:127.0.0.1:" << gdb_port;

#ifdef _WIN32
    std::ostringstream cmd;
    cmd << "\"" << exe.string() << "\""
        << " -machine esp32 -nographic -S"
        << " -L \"" << bios_dir->string() << "\""
        << " -drive file=\"" << flash_image->string() << "\",if=mtd,format=raw"
        << " -qmp " << qmp_arg.str()
        << " -gdb " << gdb_arg.str();
    std::string cmd_str = cmd.str();

    // Same "redirect stdout/stderr to a log file" reasoning as
    // qemu_adapter.cpp's Impl::spawn() - -nographic has nowhere to go with
    // no inherited console handles, and a log file gives real diagnostics
    // if the process exits early.
    log_path = std::filesystem::temp_directory_path() /
              ("physicalsim-qemu-esp32-" + std::to_string(GetCurrentProcessId()) + ".log");

    SECURITY_ATTRIBUTES sa{};
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = TRUE;
    HANDLE log_handle = CreateFileW(log_path.wstring().c_str(), GENERIC_WRITE,
                                    FILE_SHARE_READ, &sa, CREATE_ALWAYS,
                                    FILE_ATTRIBUTE_NORMAL, nullptr);
    if (log_handle == INVALID_HANDLE_VALUE) {
      throw std::runtime_error("failed to create qemu-esp32 log file at " + log_path.string());
    }

    STARTUPINFOA startup_info{};
    startup_info.cb = sizeof(startup_info);
    startup_info.dwFlags = STARTF_USESTDHANDLES;
    startup_info.hStdOutput = log_handle;
    startup_info.hStdError = log_handle;
    startup_info.hStdInput = GetStdHandle(STD_INPUT_HANDLE);

    const BOOL spawned =
        CreateProcessA(nullptr, cmd_str.data(), nullptr, nullptr, TRUE,
                        CREATE_NO_WINDOW, nullptr, nullptr, &startup_info, &process_info);
    CloseHandle(log_handle);
    if (!spawned) {
      throw std::runtime_error("failed to spawn qemu-system-xtensa");
    }
    process_started = true;

    job_handle = CreateJobObjectW(nullptr, nullptr);
    if (job_handle) {
      JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
      limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      SetInformationJobObject(job_handle, JobObjectExtendedLimitInformation, &limits,
                              sizeof(limits));
      AssignProcessToJobObject(job_handle, process_info.hProcess);
    }
#else
    std::vector<std::string> arg_storage = {
        exe.string(),
        "-machine", "esp32",
        "-nographic",
        "-S",
        "-L", bios_dir->string(),
        "-drive", "file=" + flash_image->string() + ",if=mtd,format=raw",
        "-qmp", qmp_arg.str(),
        "-gdb", gdb_arg.str(),
    };
    std::vector<char *> argv;
    for (auto &a : arg_storage) argv.push_back(a.data());
    argv.push_back(nullptr);

    int rc = posix_spawn(&pid, exe.c_str(), nullptr, nullptr, argv.data(), environ);
    if (rc != 0) {
      throw std::runtime_error("failed to spawn qemu-system-xtensa");
    }
    process_started = true;
#endif

    std::this_thread::sleep_for(std::chrono::milliseconds(150));
  }

  void connect_with_retry(boost::asio::ip::tcp::socket &sock, int port) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(8);
    boost::system::error_code ec;
    while (std::chrono::steady_clock::now() < deadline) {
      sock.connect(boost::asio::ip::tcp::endpoint(
                       boost::asio::ip::make_address("127.0.0.1"), static_cast<unsigned short>(port)),
                   ec);
      if (!ec) return;
      sock.close();
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    const std::string log = read_log_tail();
    throw std::runtime_error(
        "timed out connecting to qemu-system-xtensa control socket" +
        (log.empty() ? std::string{} : (" - qemu log:\n" + log)));
  }

  json qmp_read_message() {
    boost::asio::streambuf buf;
    boost::asio::read_until(qmp_socket, buf, '\n');
    std::istream is(&buf);
    std::string line;
    std::getline(is, line);
    return json::parse(line);
  }

  void qmp_send(const json &msg) {
    const std::string payload = msg.dump() + "\n";
    boost::asio::write(qmp_socket, boost::asio::buffer(payload));
  }

  json qmp_command(const std::string &execute) {
    qmp_send({{"execute", execute}});
    while (true) {
      json msg = qmp_read_message();
      if (msg.contains("return") || msg.contains("error")) {
        return msg;
      }
    }
  }

  void connect_control_sockets() {
    connect_with_retry(qmp_socket, qmp_port);
    qmp_read_message();  // QMP greeting
    qmp_command("qmp_capabilities");

    connect_with_retry(gdb_socket, gdb_port);
  }

  // Reads a 32-bit word from ESP32 physical memory over the GDB stub's
  // 'm addr,length' command - works whether the vCPU is currently running
  // or halted (QEMU's gdbstub services the socket independent of the vCPU
  // thread), so unlike step()/reset() below this never needs to stop the
  // target first - reading GPIO_OUT_REG this way while firmware keeps
  // running is exactly what the Phase 0 spike verified.
  std::uint32_t read_memory_word(std::uint32_t address) {
    std::ostringstream cmd;
    cmd << "m" << std::hex << address << ",4";
    rsp_send(gdb_socket, cmd.str());
    const std::string reply = rsp_recv(gdb_socket);
    return parse_le_hex_memory_word(reply);
  }

  void run_monitor(const std::string &command) { run_monitor_command(gdb_socket, command); }

  // Tears down the current process/sockets and boots `firmware_path`
  // fresh - the QEMU-backed equivalent of avr8/rp2040's
  // loadFirmware()-then-reset() (see Esp32QemuInstance::load_firmware).
  // Boots halted (spawn() always passes -S), matching those adapters'
  // "loaded but not yet running until Start is clicked" behavior.
  void respawn_with_firmware(const std::filesystem::path &firmware_path) {
    boost::system::error_code ec;
    qmp_socket.close(ec);
    gdb_socket.close(ec);
    kill_process();

    firmware_override = firmware_path;
    spawn(resolved_exe);
    connect_control_sockets();
  }
};

Esp32QemuInstance::Esp32QemuInstance() : impl_(std::make_unique<Impl>()) {}
Esp32QemuInstance::~Esp32QemuInstance() = default;

void Esp32QemuInstance::start_process() {
  auto exe = find_qemu_system_xtensa();
  if (!exe) {
    throw std::runtime_error(
        "qemu-system-xtensa not found next to physicalsim's executable or on PATH "
        "(see esp32_qemu_adapter.hpp / CMakeLists.txt's BUNDLE_QEMU_XTENSA)");
  }
  impl_->spawn(*exe);
  impl_->connect_control_sockets();
}

json Esp32QemuInstance::start() {
  impl_->qmp_command("cont");
  running_ = true;
  return json::object();
}

json Esp32QemuInstance::stop() {
  impl_->qmp_command("stop");
  running_ = false;
  return json::object();
}

json Esp32QemuInstance::step(int n) {
  // No single-instruction step exposed for this target yet (Xtensa's GDB
  // 's' packet support in this QEMU fork wasn't part of the Phase 0 spike -
  // only memory reads were verified) - approximate a "step" as a short
  // timed run, matching the coarse granularity users actually interact
  // with (watching an LED blink), not real single-instruction stepping.
  impl_->qmp_command("cont");
  std::this_thread::sleep_for(std::chrono::milliseconds(10 * (n > 0 ? n : 1)));
  impl_->qmp_command("stop");
  running_ = false;
  step_count_ += (n > 0 ? n : 1);
  return json::object();
}

json Esp32QemuInstance::reset() {
  impl_->qmp_command("stop");
  impl_->qmp_command("system_reset");
  running_ = false;
  step_count_ = 0;
  return json::object();
}

json Esp32QemuInstance::load_firmware(const std::string &binary) {
  if (binary.empty()) {
    throw std::runtime_error("esp32 adapter: loadFirmware called with an empty image");
  }
  // esp32_toolchain.cpp's merge_bin deliberately doesn't pad this to the
  // full declared flash size (see that file's own comment - it made an
  // 8MB+ hex payload cross the HTTP bridge, hit and fixed during Phase 1
  // verification) - QEMU's -drive still needs a file matching the
  // esp32 machine's flash chip size, so the trailing 0xFF
  // filler esptool would have added is reconstructed here instead,
  // right before writing to disk, never transported.
  constexpr std::size_t kFlashImageSize = 4 * 1024 * 1024;
  std::string padded = binary;
  if (padded.size() < kFlashImageSize) {
    padded.resize(kFlashImageSize, '\xff');
  }

  // A fixed path (not one temp file per call) - old images are simply
  // overwritten, matching avr8/rp2040's own "each loadFirmware replaces
  // the previous program" semantics rather than accumulating garbage in
  // the temp directory across repeated "Compile & Run" clicks.
  const auto path = std::filesystem::temp_directory_path() / "physicalsim-esp32-firmware.bin";
  {
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    if (!out) {
      throw std::runtime_error("esp32 adapter: failed to write firmware to " + path.string());
    }
    out.write(padded.data(), static_cast<std::streamsize>(padded.size()));
  }

  impl_->respawn_with_firmware(path);
  running_ = false;
  step_count_ = 0;
  return json::object();
}

json Esp32QemuInstance::state() const {
  return {
      {"running", running_},
      {"cycles", step_count_},
      {"pc", last_pc_},
  };
}

json Esp32QemuInstance::read_pin(const std::string &pin) const {
  const int gpio = parse_gpio_number(pin);
  if (gpio < 0 || gpio > 31) {
    throw std::runtime_error(
        "esp32 adapter: readPin \"" + pin + "\" resolves to GPIO" + std::to_string(gpio) +
        ", outside the 0-31 range GPIO_OUT_REG covers (GPIO32+ needs GPIO_OUT1_REG, not "
        "wired up yet)");
  }
  // This QEMU fork's gdbstub only services 'm' memory reads while the
  // vCPU is halted - confirmed empirically (a read sent while running
  // just times out; the identical request succeeds immediately once QMP
  // "stop" halts the target), not assumed from general GDB-stub folklore.
  // So: briefly stop, read, and resume if it was running - a small
  // "polled state costs a tiny stutter" tradeoff, accepted the same way
  // by every other gdbstub round-trip this adapter makes (write_pin(),
  // read_pin_direction(), write_analog_pin() below).
  const bool was_running = running_;
  if (was_running) {
    impl_->qmp_command("stop");
  }
  const std::uint32_t out_reg = impl_->read_memory_word(kGpioOutRegAddress);
  if (was_running) {
    impl_->qmp_command("cont");
  }
  const int level = static_cast<int>((out_reg >> gpio) & 1u);
  return json{{"value", level}};
}

json Esp32QemuInstance::write_pin(const std::string &pin, int value) {
  const int gpio = parse_gpio_number(pin);
  if (gpio < 0 || gpio > 31) {
    throw std::runtime_error(
        "esp32 adapter: writePin \"" + pin + "\" resolves to GPIO" + std::to_string(gpio) +
        ", outside the 0-31 range esp32_set_gpio_input covers");
  }
  // Same "briefly halt around a gdbstub round-trip" bracketing read_pin()
  // uses - the monitor command still runs through the same GDB RSP
  // connection, and this fork's gdbstub was only confirmed to service it
  // reliably while the vCPU is halted.
  const bool was_running = running_;
  if (was_running) impl_->qmp_command("stop");
  impl_->run_monitor("esp32_set_gpio_input " + std::to_string(gpio) + " " + std::to_string(value ? 1 : 0));
  if (was_running) impl_->qmp_command("cont");
  return json::object();
}

json Esp32QemuInstance::read_pin_direction(const std::string &pin) const {
  const int gpio = parse_gpio_number(pin);
  if (gpio < 0 || gpio > 31) {
    throw std::runtime_error(
        "esp32 adapter: readPinDirection \"" + pin + "\" resolves to GPIO" + std::to_string(gpio) +
        ", outside the 0-31 range GPIO_ENABLE_REG covers");
  }
  const bool was_running = running_;
  if (was_running) impl_->qmp_command("stop");
  const std::uint32_t enable_reg = impl_->read_memory_word(kGpioEnableRegAddress);
  if (was_running) impl_->qmp_command("cont");
  const bool is_output = ((enable_reg >> gpio) & 1u) != 0;
  return json{{"value", is_output ? "output" : "input"}};
}

json Esp32QemuInstance::write_analog_pin(const std::string &pin, double voltage) {
  const int gpio = parse_gpio_number(pin);
  const int channel = adc1_channel_for_gpio(gpio);
  if (channel < 0) {
    // Not one of GPIO32-39 - no ADC1 channel behind it. Matches avr8/
    // rp2040's own "reject a non-ADC pin, caught not thrown" posture
    // (adapter-types.ts's writeAnalogPin doc comment) rather than an error.
    return json::object();
  }
  // ESP32 ADC1 is a 12-bit SAR ADC against a (default, no attenuation)
  // ~1.1V reference in real hardware, but esp32_sens.c's ADC_values[] is
  // just a raw count with no register-level attenuation/calibration model
  // - approximated here as a plain 0-3.3V -> 0-4095 linear scale (the
  // Arduino-core default full-scale most sketches assume), not a faithful
  // per-attenuation curve.
  const double clamped = std::max(0.0, std::min(3.3, voltage));
  const int raw = static_cast<int>(clamped / 3.3 * 4095.0 + 0.5);
  const bool was_running = running_;
  if (was_running) impl_->qmp_command("stop");
  impl_->run_monitor("esp32_set_adc " + std::to_string(channel) + " " + std::to_string(raw));
  if (was_running) impl_->qmp_command("cont");
  return json::object();
}

}  // namespace esp32qemu
