// ============================================================================
// qemu_adapter.cpp — see qemu_adapter.hpp for the overview.
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

#include "qemu_adapter.hpp"

#include <array>
#include <chrono>
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

namespace qemu {

namespace {

#ifdef _WIN32
constexpr const char *kExeName = "qemu-system-arm.exe";
#else
constexpr const char *kExeName = "qemu-system-arm";
#endif

std::vector<std::filesystem::path> well_known_locations() {
#ifdef _WIN32
  return {
      "C:\\Program Files\\qemu\\qemu-system-arm.exe",
      "C:\\Program Files (x86)\\qemu\\qemu-system-arm.exe",
  };
#else
  return {
      "/usr/bin/qemu-system-arm",
      "/usr/local/bin/qemu-system-arm",
      "/opt/homebrew/bin/qemu-system-arm",
  };
#endif
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

// Grabs a free TCP port by binding an acceptor to port 0 (OS-assigned)
// and immediately closing it. Small unavoidable race if something else
// grabs the port before QEMU binds it, same tradeoff httplib's own
// bind_to_any_port() accepts.
int reserve_free_port(boost::asio::io_context &io) {
  boost::asio::ip::tcp::acceptor acceptor(
      io, boost::asio::ip::tcp::endpoint(boost::asio::ip::make_address("127.0.0.1"), 0));
  const int port = acceptor.local_endpoint().port();
  acceptor.close();
  return port;
}

// ---- Minimal GDB Remote Serial Protocol client -----------------------------
// Just enough of the $packet#checksum protocol for single-step ('s') and
// register readback ('g'). Not a general-purpose RSP client.
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
  // Expect a single '+' ack byte.
  std::array<char, 1> ack{};
  boost::asio::read(sock, boost::asio::buffer(ack));
}

// Reads one $...#XX packet (blocking) and returns the payload between $
// and #. Sends the '+' ack the protocol expects in return.
std::string rsp_recv(boost::asio::ip::tcp::socket &sock) {
  std::string buf;
  char c = 0;
  // Skip anything before the '$' (e.g. a stray ack byte).
  do {
    boost::asio::read(sock, boost::asio::buffer(&c, 1));
  } while (c != '$');

  while (true) {
    boost::asio::read(sock, boost::asio::buffer(&c, 1));
    if (c == '#') break;
    buf += c;
  }
  // Consume the two checksum hex digits.
  std::array<char, 2> checksum{};
  boost::asio::read(sock, boost::asio::buffer(checksum));

  const char ack = '+';
  boost::asio::write(sock, boost::asio::buffer(&ack, 1));
  return buf;
}

// Little-endian hex-pair-reversed register value, as GDB's 'g' packet
// encodes each register: 4 bytes per register, least-significant byte
// first, two hex digits per byte.
unsigned long long parse_le_hex_register(const std::string &hex_bytes) {
  unsigned long long value = 0;
  for (std::size_t i = hex_bytes.size(); i >= 2; i -= 2) {
    value = (value << 8) | std::stoul(hex_bytes.substr(i - 2, 2), nullptr, 16);
  }
  return value;
}

}  // namespace

// Real ARM Cortex-M silicon (unlike avr8js/rp2040js's simplified CPU
// models) requires a valid vector table at address 0 to boot at all: word
// 0 is the initial SP, word 1 is the initial PC. With flash left
// completely empty, both are 0, and the CPU immediately double-faults
// trying to execute from (and then handle a fault from) address 0 - QEMU
// reports this as a fatal lockup and exits. This is not "no firmware
// loaded" behaving like the JS adapters' empty-but-runnable flash; on
// real hardware semantics, no vector table means no boot at all.
//
// This is a tiny built-in stub, not user firmware: a minimal valid vector
// table (SP = top of netduinoplus2's SRAM, PC = the instruction right
// after it) followed by one Thumb instruction, 0xE7FE ("b ."), an
// infinite loop. Just enough for the CPU to boot into a real, inert,
// steppable running state - matching the other adapters' "runs, executes
// nothing meaningful yet" posture until real firmware loading exists.
std::vector<std::uint8_t> minimal_vector_table_stub() {
  constexpr std::uint32_t kInitialSp = 0x20001000;         // top of a small SRAM region
  constexpr std::uint32_t kEntryPoint = 0x08000008 | 0x1;  // offset 8, Thumb bit set

  std::vector<std::uint8_t> image(10, 0);
  auto put_u32 = [&image](std::size_t offset, std::uint32_t value) {
    image[offset + 0] = static_cast<std::uint8_t>(value & 0xff);
    image[offset + 1] = static_cast<std::uint8_t>((value >> 8) & 0xff);
    image[offset + 2] = static_cast<std::uint8_t>((value >> 16) & 0xff);
    image[offset + 3] = static_cast<std::uint8_t>((value >> 24) & 0xff);
  };
  put_u32(0, kInitialSp);
  put_u32(4, kEntryPoint);
  image[8] = 0xfe;  // "b ." (branch to self), Thumb halfword 0xE7FE, little-endian
  image[9] = 0xe7;
  return image;
}

// Self-contained (deliberately not shared with main.cpp's own
// get_executable_dir() helpers) so qemu_adapter.cpp stays decoupled from
// main.cpp internals - this is the only place it's needed.
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

std::optional<std::filesystem::path> find_bundled() {
  const auto candidate = executable_dir() / "qemu" / kExeName;
  std::error_code ec;
  if (std::filesystem::exists(candidate, ec)) {
    return candidate;
  }
  return std::nullopt;
}

std::optional<std::filesystem::path> find_qemu_system_arm() {
  // A bundled copy (see CMakeLists.txt's BUNDLE_QEMU_ARM) takes priority
  // over whatever happens to be on the system: it's the exact version
  // this adapter was tested against, and its purpose is specifically to
  // make packaged distribution not depend on the end user having
  // installed QEMU themselves.
  if (auto bundled = find_bundled()) {
    return bundled;
  }
  if (auto found = find_on_path()) {
    return found;
  }
  for (const auto &candidate : well_known_locations()) {
    std::error_code ec;
    if (std::filesystem::exists(candidate, ec)) {
      return candidate;
    }
  }
  return std::nullopt;
}

struct QemuInstance::Impl {
  boost::asio::io_context io;
  boost::asio::ip::tcp::socket qmp_socket{io};
  boost::asio::ip::tcp::socket gdb_socket{io};
  int qmp_port = 0;
  int gdb_port = 0;
  std::filesystem::path stub_path;

#ifdef _WIN32
  PROCESS_INFORMATION process_info{};
  bool process_started = false;
  std::filesystem::path log_path;
  // Job object with KILL_ON_JOB_CLOSE: Windows closes every handle a
  // process owns when that process terminates, for any reason (normal
  // exit, crash, or an external TerminateProcess/taskkill /F, which
  // bypasses our own destructors entirely). Closing the job's last
  // handle kills every process assigned to it - so this is what actually
  // guarantees qemu-system-arm doesn't outlive physicalsim, not the
  // destructor below (that only covers the normal-exit path).
  HANDLE job_handle = nullptr;
#else
  pid_t pid = -1;
  bool process_started = false;
#endif

  // Best-effort read of whatever qemu-system-arm has written to its log
  // so far, for error messages. Empty string if unavailable.
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

  ~Impl() {
    kill_process();
    if (!stub_path.empty()) {
      std::error_code ec;
      std::filesystem::remove(stub_path, ec);
    }
  }

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
    qmp_port = reserve_free_port(io);
    gdb_port = reserve_free_port(io);

    stub_path = std::filesystem::temp_directory_path() /
               ("physicalsim-qemu-stub-" + current_process_id_string() + ".bin");
    {
      const auto stub = minimal_vector_table_stub();
      std::ofstream stub_file(stub_path, std::ios::binary);
      stub_file.write(reinterpret_cast<const char *>(stub.data()),
                      static_cast<std::streamsize>(stub.size()));
    }

    std::ostringstream qmp_arg;
    qmp_arg << "tcp:127.0.0.1:" << qmp_port << ",server=on,wait=off";
    std::ostringstream gdb_arg;
    gdb_arg << "tcp:127.0.0.1:" << gdb_port;

#ifdef _WIN32
    std::ostringstream cmd;
    cmd << "\"" << exe.string() << "\""
        << " -M netduinoplus2 -nographic -S"
        << " -kernel \"" << stub_path.string() << "\""
        << " -qmp " << qmp_arg.str()
        << " -gdb " << gdb_arg.str();
    std::string cmd_str = cmd.str();

    // -nographic redirects QEMU's "display" to the console/stdio. Spawned
    // with CREATE_NO_WINDOW and no inherited handles, it has no console
    // to redirect to and exits almost immediately after opening its QMP
    // socket (which is why a naive spawn here looked like it worked -
    // the QMP handshake and one GDB register read can complete in that
    // brief window - before the process was gone by the time anything
    // checked for it). Redirect its stdout/stderr to a log file instead:
    // gives QEMU somewhere valid to write, and gives us real diagnostics
    // if it exits for a different reason later.
    log_path = std::filesystem::temp_directory_path() /
              ("physicalsim-qemu-" + std::to_string(GetCurrentProcessId()) + ".log");

    SECURITY_ATTRIBUTES sa{};
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = TRUE;
    HANDLE log_handle = CreateFileW(log_path.wstring().c_str(), GENERIC_WRITE,
                                    FILE_SHARE_READ, &sa, CREATE_ALWAYS,
                                    FILE_ATTRIBUTE_NORMAL, nullptr);
    if (log_handle == INVALID_HANDLE_VALUE) {
      throw std::runtime_error("failed to create qemu log file at " + log_path.string());
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
      throw std::runtime_error("failed to spawn qemu-system-arm");
    }
    process_started = true;

    job_handle = CreateJobObjectW(nullptr, nullptr);
    if (job_handle) {
      JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
      limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      SetInformationJobObject(job_handle, JobObjectExtendedLimitInformation, &limits,
                              sizeof(limits));
      // Best-effort: if this fails, we fall back to destructor-based
      // cleanup on the normal-exit path only.
      AssignProcessToJobObject(job_handle, process_info.hProcess);
    }
#else
    std::vector<std::string> arg_storage = {
        exe.string(), "-M",    "netduinoplus2", "-nographic", "-S",
        "-kernel",    stub_path.string(),
        "-qmp",       qmp_arg.str(),           "-gdb",       gdb_arg.str(),
    };
    std::vector<char *> argv;
    for (auto &a : arg_storage) argv.push_back(a.data());
    argv.push_back(nullptr);

    int rc = posix_spawn(&pid, exe.c_str(), nullptr, nullptr, argv.data(), environ);
    if (rc != 0) {
      throw std::runtime_error("failed to spawn qemu-system-arm");
    }
    process_started = true;
#endif

    // Give QEMU a moment to bind its QMP/GDB listeners before we connect.
    // Both connect calls below already retry, so this just avoids the
    // first few attempts spinning uselessly.
    std::this_thread::sleep_for(std::chrono::milliseconds(150));
  }

  void connect_with_retry(boost::asio::ip::tcp::socket &sock, int port) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
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
        "timed out connecting to qemu control socket" +
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
    // Skip any async "event" messages, return the first "return"/"error".
    while (true) {
      json msg = qmp_read_message();
      if (msg.contains("return") || msg.contains("error")) {
        return msg;
      }
    }
  }

  void connect_control_sockets() {
    connect_with_retry(qmp_socket, qmp_port);
    // QMP greeting, then enter command mode.
    qmp_read_message();
    qmp_command("qmp_capabilities");

    connect_with_retry(gdb_socket, gdb_port);
  }

  // Single-steps one instruction via the GDB stub and returns the new PC.
  unsigned long long gdb_step_and_read_pc() {
    rsp_send(gdb_socket, "s");
    rsp_recv(gdb_socket);  // stop-reply packet (e.g. T05...); step is done once it arrives.
    return gdb_read_pc();
  }

  unsigned long long gdb_read_pc() {
    rsp_send(gdb_socket, "g");
    const std::string regs = rsp_recv(gdb_socket);
    // ARM 'g' packet: 16 general registers (r0-r15), 4 bytes each, 8 hex
    // chars each. PC is r15, the 16th register -> hex offset 15*8.
    constexpr std::size_t kPcHexOffset = 15 * 8;
    if (regs.size() < kPcHexOffset + 8) {
      throw std::runtime_error("unexpected register packet from qemu gdbstub");
    }
    return parse_le_hex_register(regs.substr(kPcHexOffset, 8));
  }
};

QemuInstance::QemuInstance() : impl_(std::make_unique<Impl>()) {}
QemuInstance::~QemuInstance() = default;

void QemuInstance::start_process() {
  auto exe = find_qemu_system_arm();
  if (!exe) {
    throw std::runtime_error(
        "qemu-system-arm not found on PATH or in well-known install locations");
  }
  impl_->spawn(*exe);
  impl_->connect_control_sockets();
  last_pc_ = impl_->gdb_read_pc();
}

json QemuInstance::start() {
  // Register reads over the GDB stub require the target halted, so once
  // we resume free-running there's no way to keep pc/cycles current
  // without re-stopping it (which would defeat "running"). state() keeps
  // reporting the last known values (frozen) with running:true until
  // stop()/step() next actually halts the target and re-reads them -
  // an intentional, documented simplification, not a bug.
  impl_->qmp_command("cont");
  running_ = true;
  return json::object();
}

json QemuInstance::stop() {
  impl_->qmp_command("stop");
  running_ = false;
  last_pc_ = impl_->gdb_read_pc();
  return json::object();
}

json QemuInstance::step(int n) {
  impl_->qmp_command("stop");
  running_ = false;
  for (int i = 0; i < n; ++i) {
    last_pc_ = impl_->gdb_step_and_read_pc();
    ++step_count_;
  }
  return json::object();
}

json QemuInstance::reset() {
  impl_->qmp_command("stop");
  impl_->qmp_command("system_reset");
  running_ = false;
  step_count_ = 0;
  last_pc_ = impl_->gdb_read_pc();
  return json::object();
}

json QemuInstance::state() const {
  return {
      {"running", running_},
      // Not real CPU cycles - QEMU doesn't expose a cycle counter over
      // QMP/GDB for this target. This is the number of step() calls
      // issued, documented as such rather than silently faked as cycles.
      {"cycles", step_count_},
      {"pc", last_pc_},
  };
}

json QemuInstance::read_pin(const std::string &pin) const {
  throw std::runtime_error(
      "cortex-m does not support pin I/O yet (readPin \"" + pin +
      "\"): QEMU GPIO access is unimplemented, see qemu_adapter.hpp");
}

json QemuInstance::write_pin(const std::string &pin, int /*value*/) {
  throw std::runtime_error(
      "cortex-m does not support pin I/O yet (writePin \"" + pin +
      "\"): QEMU GPIO access is unimplemented, see qemu_adapter.hpp");
}

}  // namespace qemu
