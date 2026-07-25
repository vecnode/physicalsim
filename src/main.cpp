// ============================================================================
/******************************************************************************
 * physicalsim main.cpp
 *
 * Copyright (c) 2026 vecnode
 *
 * Purpose: Entry point for physicalsim. Launches a self-contained HTTP
 * server and embedded webview hosting the browser-side simulator control UI
 * (web/shell). Also exposes a native<->JS bridge (see install_bridge below)
 * so external callers (e.g. droidcli) can drive simulator adapters through
 * this process's HTTP server without going through the UI.
 *
 * Attribution: vecnode 2026
 ******************************************************************************/
// ============================================================================

// -----------------------------
// Build/Version Metadata
// -----------------------------
#ifndef PHYSICALSIM_VERSION
#define PHYSICALSIM_VERSION "0.1.0"
#endif
#ifndef PHYSICALSIM_BUILD
#define PHYSICALSIM_BUILD __DATE__ " " __TIME__
#endif


// Third-party headers produce warnings under -Wshadow / -Wconversion that we
// cannot fix (they are in library code). Suppress them only for these includes.
#ifdef __GNUC__
#  pragma GCC diagnostic push
#  pragma GCC diagnostic ignored "-Wshadow"
#  pragma GCC diagnostic ignored "-Wconversion"
#endif

#include <httplib.h>
#include <cpp-embedlib-httplib.h>
#include "WebAssets.h"
#include "webview/webview.h"
#include "qemu_adapter.hpp"
#include "esp32_qemu_adapter.hpp"
#include "qemu_backed_adapter.hpp"
#include "avr_toolchain.hpp"
#include "rp2040_toolchain.hpp"
#include "esp32_toolchain.hpp"
#include <nlohmann/json.hpp>

#include <boost/asio.hpp>

#ifdef __GNUC__
#  pragma GCC diagnostic pop
#endif

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <cstddef>
#include <filesystem>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>

#ifdef __linux__
#include <gtk/gtk.h>
#include <limits.h>
#include <unistd.h>
#endif

#ifdef _WIN32
#include <windows.h>
#endif

#ifndef INCLUDE_TERMINAL_ON_RELEASE
#define INCLUDE_TERMINAL_ON_RELEASE 0
#endif

const bool kIncludeTerminalOnRelease = (INCLUDE_TERMINAL_ON_RELEASE != 0);

#ifndef USE_FIXED_WEBVIEW2_RUNTIME
#define USE_FIXED_WEBVIEW2_RUNTIME 0
#endif

using json = nlohmann::json;

#ifdef _WIN32
std::filesystem::path get_executable_dir() {
  wchar_t path[MAX_PATH]{};
  auto len = GetModuleFileNameW(nullptr, path, MAX_PATH);
  if (len == 0 || len >= MAX_PATH) {
    return std::filesystem::current_path();
  }
  return std::filesystem::path(path).parent_path();
}

void apply_windows_icons(webview::webview &w) {
  auto window_result = w.window();
  if (!window_result.ok()) {
    return;
  }

  auto hwnd = static_cast<HWND>(window_result.value());
  if (!hwnd) {
    return;
  }

  const auto icon_dir = get_executable_dir() / "assets";
  const auto small_icon_path = (icon_dir / "app_icon_small.ico").wstring();
  const auto large_icon_path = (icon_dir / "app_icon.ico").wstring();

  auto small_icon = static_cast<HICON>(LoadImageW(
      nullptr, small_icon_path.c_str(), IMAGE_ICON,
      GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON),
      LR_LOADFROMFILE));

  auto large_icon = static_cast<HICON>(LoadImageW(
      nullptr, large_icon_path.c_str(), IMAGE_ICON,
      GetSystemMetrics(SM_CXICON), GetSystemMetrics(SM_CYICON),
      LR_LOADFROMFILE));

  if (small_icon) {
    SendMessageW(hwnd, WM_SETICON, ICON_SMALL, reinterpret_cast<LPARAM>(small_icon));
    SetClassLongPtrW(hwnd, GCLP_HICONSM, reinterpret_cast<LONG_PTR>(small_icon));
  }

  if (large_icon) {
    SendMessageW(hwnd, WM_SETICON, ICON_BIG, reinterpret_cast<LPARAM>(large_icon));
    SetClassLongPtrW(hwnd, GCLP_HICON, reinterpret_cast<LONG_PTR>(large_icon));
  }
}
#endif

#ifdef __linux__
std::filesystem::path get_executable_dir() {
  char path[PATH_MAX]{};
  auto len = readlink("/proc/self/exe", path, sizeof(path) - 1);
  if (len <= 0) {
    return std::filesystem::current_path();
  }

  path[len] = '\0';
  return std::filesystem::path(path).parent_path();
}

void apply_linux_icon(webview::webview &w) {
  auto window_result = w.window();
  if (!window_result.ok()) {
    return;
  }

  auto gtk_window = GTK_WINDOW(window_result.value());
  if (!gtk_window) {
    return;
  }

  const auto exe_dir = get_executable_dir();
  // Prefer PNG (reliably supported by gdk-pixbuf on all distros).
  // ICO entries are kept as fallback for environments that have the loader.
  const std::filesystem::path candidates[] = {
      exe_dir / "assets" / "app_icon.png",
      exe_dir / "assets" / "app_icon.ico",
      exe_dir / "assets" / "app_icon_small.ico",
      std::filesystem::current_path() / "assets" / "app_icon.png",
      std::filesystem::current_path() / "assets" / "app_icon.ico",
      std::filesystem::current_path() / "assets" / "app_icon_small.ico"};

  for (const auto &icon_path : candidates) {
    if (!std::filesystem::exists(icon_path)) {
      continue;
    }

    GError *error = nullptr;
    if (gtk_window_set_icon_from_file(
            gtk_window, icon_path.string().c_str(), &error)) {
      if (error) {
        g_error_free(error);
      }
      return;
    }

    if (error) {
      g_error_free(error);
    }
  }
}
#endif

// physicalsim still runs the webview's own message loop in --headless mode
// (JS/TS adapters execute inside that embedded browser engine — there is
// nowhere else for them to run), just with the window hidden.
void hide_window(webview::webview &w) {
#ifdef _WIN32
  auto window_result = w.window();
  if (window_result.ok()) {
    auto hwnd = static_cast<HWND>(window_result.value());
    if (hwnd) ShowWindow(hwnd, SW_HIDE);
  }
#elif defined(__linux__)
  auto window_result = w.window();
  if (window_result.ok()) {
    auto gtk_window = GTK_WINDOW(window_result.value());
    if (gtk_window) gtk_widget_hide(GTK_WIDGET(gtk_window));
  }
#else
  (void)w;
#endif
}

// Schedules a recurring Boost.Asio steady_timer that fires every `interval`.
// Automatically reschedules itself until the io_context is stopped.
void schedule_heartbeat(boost::asio::steady_timer &timer,
                        std::chrono::seconds interval) {
  timer.expires_after(interval);
  timer.async_wait([&timer, interval](const boost::system::error_code &ec) {
    if (ec) return; // cancelled or destroyed
    schedule_heartbeat(timer, interval);
  });
}

// 64KB was enough for every request this bridge took until ESP32's
// loadFirmware: its merged flash image (bootloader + partition table +
// app, unpadded - see esp32_toolchain.cpp's own comment on why it isn't
// padded to the full 4MB flash size) runs to roughly 244KB, ~500KB once
// hex-encoded to cross the JSON bridge (see decode_hex_bytes() below) -
// raised enough to comfortably cover that plus headroom for a somewhat
// larger sketch, while staying a real bound, not "unlimited", for a
// bridge that's still meant to be hardened against oversized requests.
constexpr std::size_t kMaxRequestBodyBytes = 2 * 1024 * 1024;

// --- Ctrl-C / SIGTERM handling for --headless mode -------------------------
std::atomic<bool> g_shutdown_requested{false};
std::mutex g_shutdown_mutex;
std::condition_variable g_shutdown_cv;

void handle_shutdown_signal(int) {
  g_shutdown_requested.store(true);
  g_shutdown_cv.notify_all();
}

void wait_for_shutdown_signal() {
  std::signal(SIGINT, handle_shutdown_signal);
  std::signal(SIGTERM, handle_shutdown_signal);
  std::unique_lock<std::mutex> lock(g_shutdown_mutex);
  g_shutdown_cv.wait(lock, [] { return g_shutdown_requested.load(); });
}

// --- Native <-> JS bridge ----------------------------------------------------
// C++ side of the protocol implemented in web/shell/src/native-bridge.ts and
// web/shell/src/adapter-registry.ts. Commands go C++ -> JS via webview
// eval() (window.physicalsimBridge.dispatch); replies and unsolicited
// stateChange events come back JS -> C++ via a webview bind()
// (window.physicalsimReply), correlated here by request id.
struct PendingBridgeCall {
  bool done = false;
  json response;
};

std::mutex g_bridge_mutex;
std::condition_variable g_bridge_cv;
std::unordered_map<int, PendingBridgeCall> g_bridge_pending;
std::atomic<int> g_bridge_next_id{1};

std::mutex g_bridge_state_mutex;
std::unordered_map<std::string, json> g_bridge_latest_state;

// Registers the JS -> C++ half of the bridge. Must be called before
// w.navigate() so the binding exists before the page's own scripts run.
void install_bridge(webview::webview &w) {
  w.bind("physicalsimReply", [](const std::string &req) -> std::string {
    // req is already the JSON-encoded array of arguments the JS side passed
    // to window.physicalsimReply(...) — webview's own {id,method,params}
    // envelope is unwrapped by the library before reaching this callback.
    try {
      const auto args = json::parse(req);
      if (args.empty()) {
        return "null";
      }
      const auto &payload = args.at(0);

      if (payload.contains("event") && payload.at("event") == "stateChange") {
        const auto adapter = payload.value("adapter", std::string{});
        std::lock_guard<std::mutex> lock(g_bridge_state_mutex);
        g_bridge_latest_state[adapter] = payload.value("state", json::object());
        return "null";
      }

      if (payload.contains("id")) {
        const int id = payload.at("id").get<int>();
        std::lock_guard<std::mutex> lock(g_bridge_mutex);
        auto it = g_bridge_pending.find(id);
        if (it != g_bridge_pending.end()) {
          it->second.response = payload;
          it->second.done = true;
        }
      }
    } catch (const std::exception &e) {
      std::cerr << "[bridge] malformed reply: " << e.what() << std::endl;
    }
    g_bridge_cv.notify_all();
    return "null";
  });
}

// --- QEMU-backed adapters (e.g. "cortex-m", "esp32") ------------------------
// Unlike avr8/rp2040 (JS/TS running in a Worker, reached via eval()/bind()
// above), a QEMU-backed adapter has no JS side at all — the C++ shell
// spawns and controls a real qemu-system-* process directly (see
// qemu_adapter.hpp/.cpp for "cortex-m"/qemu-system-arm,
// esp32_qemu_adapter.hpp/.cpp for "esp32"/qemu-system-xtensa). Both
// implement the same QemuBackedAdapter interface, so this dispatch table
// doesn't grow a new special case per adapter kind - just a new entry here.
// Writes into the same g_bridge_latest_state map install_bridge()'s
// JS->C++ handler populates, so GET /bridge/:adapter/state needs no
// separate code path for any adapter kind.
bool is_qemu_backed_adapter(const std::string &adapter) {
  return adapter == "cortex-m" || adapter == "esp32";
}

std::mutex g_qemu_mutex;
std::unordered_map<std::string, std::unique_ptr<QemuBackedAdapter>> g_qemu_instances;

QemuBackedAdapter &get_or_create_qemu_instance(const std::string &adapter) {
  std::lock_guard<std::mutex> lock(g_qemu_mutex);
  auto it = g_qemu_instances.find(adapter);
  if (it == g_qemu_instances.end()) {
    std::unique_ptr<QemuBackedAdapter> instance;
    if (adapter == "esp32") {
      instance = std::make_unique<esp32qemu::Esp32QemuInstance>();
    } else {
      instance = std::make_unique<qemu::QemuInstance>();
    }
    instance->start_process();
    it = g_qemu_instances.emplace(adapter, std::move(instance)).first;
  }
  return *it->second;
}

// Decodes a plain hex-pair-per-byte string (the same "binHex" convention
// /compile already uses for RP2040's response) into raw bytes - the
// counterpart encode loop lives in the /compile handler below. Needed
// because loadFirmware crosses the native HTTP bridge as JSON
// (native-adapter-client.ts's call()), not a Worker's postMessage
// structured clone, so a raw Uint8Array can't cross directly the way it
// does for avr8/rp2040's loadFirmware.
std::string encode_hex_bytes(const std::string &binary) {
  static const char *hex_digits = "0123456789abcdef";
  std::string hex;
  hex.reserve(binary.size() * 2);
  for (unsigned char byte : binary) {
    hex.push_back(hex_digits[byte >> 4]);
    hex.push_back(hex_digits[byte & 0xf]);
  }
  return hex;
}

std::string decode_hex_bytes(const std::string &hex) {
  std::string out;
  out.reserve(hex.size() / 2);
  auto nibble = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    throw std::runtime_error("invalid hex character in loadFirmware payload");
  };
  for (std::size_t i = 0; i + 1 < hex.size(); i += 2) {
    out.push_back(static_cast<char>((nibble(hex[i]) << 4) | nibble(hex[i + 1])));
  }
  return out;
}

json handle_qemu_bridge_call(const std::string &adapter, const std::string &method,
                              const json &params) {
  try {
    auto &instance = get_or_create_qemu_instance(adapter);

    // Plain number, matching worker-host.ts's SimulatorAdapter.readPin()
    // shape (adapter-types.ts) - native-adapter-client.ts's call() returns
    // this "result" field straight through to circuit-pin.ts, which
    // expects a bare number|undefined, not a wrapper object.
    json read_pin_result = nullptr;

    if (method == "start") {
      instance.start();
    } else if (method == "stop") {
      instance.stop();
    } else if (method == "step") {
      const int n = params.is_number() ? params.get<int>() : 1;
      instance.step(n);
    } else if (method == "reset") {
      instance.reset();
    } else if (method == "init") {
      // Process is already started by get_or_create_qemu_instance() above.
    } else if (method == "readPin") {
      const std::string pin = params.is_object() && params.contains("pin")
                                   ? params.at("pin").get<std::string>()
                                   : "";
      // Throws for cortex-m (unimplemented, see qemu_adapter.hpp); for
      // esp32 returns {"value": 0|1} (see esp32_qemu_adapter.hpp).
      read_pin_result = instance.read_pin(pin).value("value", json(nullptr));
    } else if (method == "writePin") {
      const std::string pin = params.is_object() && params.contains("pin")
                                   ? params.at("pin").get<std::string>()
                                   : "";
      const int value = params.is_object() && params.contains("value")
                             ? params.at("value").get<int>()
                             : 0;
      instance.write_pin(pin, value);  // always throws today, see the adapter headers
    } else if (method == "loadFirmware") {
      // main.ts's compileAndRun() sends a plain hex string here for
      // native-backed adapters (see decode_hex_bytes() above) - a raw
      // Uint8Array, the shape avr8/rp2040's Worker-side loadFirmware()
      // takes, can't cross the JSON HTTP bridge directly.
      const std::string hex = params.is_string() ? params.get<std::string>() : "";
      instance.load_firmware(decode_hex_bytes(hex));  // throws for cortex-m, see qemu_adapter.hpp
    } else {
      return json{{"error", "Unknown method: " + method}};
    }

    {
      std::lock_guard<std::mutex> lock(g_bridge_state_mutex);
      g_bridge_latest_state[adapter] = instance.state();
    }
    return json{{"result", read_pin_result}};
  } catch (const std::exception &e) {
    return json{{"error", e.what()}};
  }
}

// Dispatches one adapter command into JS and blocks (with a timeout) for the
// matching reply. Safe to call from any thread — the actual eval() runs on
// the UI thread via w.dispatch().
json dispatch_bridge_call(webview::webview &w, const std::string &adapter,
                          const std::string &method, const json &params,
                          std::chrono::milliseconds timeout = std::chrono::seconds{5}) {
  const int id = g_bridge_next_id.fetch_add(1);
  {
    std::lock_guard<std::mutex> lock(g_bridge_mutex);
    g_bridge_pending[id] = PendingBridgeCall{};
  }

  const json request = {
      {"id", id}, {"adapter", adapter}, {"method", method}, {"params", params}};
  const std::string js = "window.physicalsimBridge.dispatch(" + request.dump() + ")";
  w.dispatch([&w, js]() { w.eval(js); });

  json result;
  {
    std::unique_lock<std::mutex> lock(g_bridge_mutex);
    const bool completed = g_bridge_cv.wait_for(
        lock, timeout, [&] { return g_bridge_pending[id].done; });
    result = completed ? g_bridge_pending[id].response
                       : json{{"error", "bridge call timed out"}};
    g_bridge_pending.erase(id);
  }
  return result;
}

int main(int argc, char **argv) {
  bool headless = false;
  for (int i = 1; i < argc; ++i) {
    if (std::string(argv[i]) == "--headless") {
      headless = true;
    }
  }

  // --- Print version/build info on startup (stdout, not UI) ---
  std::cout << "physicalsim v" << PHYSICALSIM_VERSION
            << " (" << PHYSICALSIM_BUILD << ")\n"
            << "Copyright (c) 2026 vecnode\n";


#ifdef _WIN32
#if USE_FIXED_WEBVIEW2_RUNTIME
  // Defensive: Check for fixed WebView2 runtime directory
  {
    const auto runtime_dir = get_executable_dir() / "WebView2Runtime";
    if (!std::filesystem::exists(runtime_dir) || !std::filesystem::is_directory(runtime_dir)) {
      std::cerr << "[fatal] WebView2Runtime directory missing: " << runtime_dir << std::endl;
      return 2;
    }
    const auto runtime_dir_w = runtime_dir.wstring();
    if (!SetEnvironmentVariableW(L"WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", runtime_dir_w.c_str())) {
      std::cerr << "[fatal] Failed to set WEBVIEW2_BROWSER_EXECUTABLE_FOLDER env var" << std::endl;
      return 3;
    }
  }
#endif
#endif


  // -----------------------------
  // Boost.Asio io_context — owns all async operations.
  // -----------------------------
  boost::asio::io_context ioc;
  auto work_guard = boost::asio::make_work_guard(ioc);

  // Periodic timer: fires every 5 seconds and logs a heartbeat.
  boost::asio::steady_timer heartbeat_timer{ioc};
  schedule_heartbeat(heartbeat_timer, std::chrono::seconds{5});

  // Run the io_context on a dedicated thread so it never blocks the UI thread.
  std::thread asio_thread([&ioc]() { ioc.run(); });


  // -----------------------------
  // Webview — created in both modes. In --headless mode this is the same
  // embedded browser engine, just hidden: it's where the JS/TS simulator
  // adapters actually execute (see web/shell), so headless still needs it.
  // -----------------------------
  webview::webview w(false, nullptr);
  w.set_title("physicalsim");
  install_bridge(w);


  // -----------------------------
  // Embedded HTTP server setup
  // -----------------------------
  httplib::Server server;
  server.set_read_timeout(std::chrono::seconds{3});
  server.set_write_timeout(std::chrono::seconds{3});
  server.set_keep_alive_max_count(1);
  server.set_payload_max_length(kMaxRequestBodyBytes);


  // Health check endpoint
  server.Get("/health", [](const httplib::Request &, httplib::Response &res) {
    res.set_content("ok", "text/plain");
    res.set_header("Cache-Control", "no-store");
    res.set_header("X-Content-Type-Options", "nosniff");
  });

  // Example API endpoint
  server.Get("/api/hello", [](const httplib::Request &, httplib::Response &res) {
    res.set_content("hello world", "text/plain");
    res.set_header("Cache-Control", "no-store");
    res.set_header("X-Content-Type-Options", "nosniff");
  });

  // Native<->JS bridge: drive a simulator adapter from outside the process
  // (e.g. droidcli) without going through the UI.
  // POST /bridge/<adapter>/<method>  body: JSON params object, or empty.
  server.Post(
      R"(/bridge/([^/]+)/([^/]+))",
      [&w](const httplib::Request &req, httplib::Response &res) {
        const std::string adapter = req.matches[1];
        const std::string method = req.matches[2];

        json params = json::object();
        if (!req.body.empty()) {
          try {
            params = json::parse(req.body);
          } catch (const std::exception &) {
            res.status = 400;
            res.set_header("Cache-Control", "no-store");
            res.set_content(R"({"error":"invalid JSON body"})", "application/json");
            return;
          }
        }

        const json result = is_qemu_backed_adapter(adapter)
                                ? handle_qemu_bridge_call(adapter, method, params)
                                : dispatch_bridge_call(w, adapter, method, params);
        res.set_header("Cache-Control", "no-store");
        res.status = result.contains("error") ? 502 : 200;
        res.set_content(result.dump(), "application/json");
      });

  // GET /bridge/<adapter>/state -> last known state from a stateChange event.
  server.Get(
      R"(/bridge/([^/]+)/state)",
      [](const httplib::Request &req, httplib::Response &res) {
        const std::string adapter = req.matches[1];
        std::lock_guard<std::mutex> lock(g_bridge_state_mutex);
        res.set_header("Cache-Control", "no-store");
        const auto it = g_bridge_latest_state.find(adapter);
        if (it == g_bridge_latest_state.end()) {
          res.status = 404;
          res.set_content(R"({"error":"no state yet"})", "application/json");
          return;
        }
        res.set_content(it->second.dump(), "application/json");
      });


  // Compiles a real Arduino sketch (setup()/loop(), digitalRead/Write,
  // Serial, etc.) into an Intel HEX image using a bundled/system avr-gcc -
  // see avr_toolchain.hpp. Deliberately outside the /bridge/:adapter/...
  // abstraction above: compiling isn't scoped to a running adapter
  // instance the way pin I/O is, it's a standalone build step whose
  // output (hex text) the browser then feeds through the exact same
  // parseIntelHex() -> loadFirmware() path "Load .hex..." already uses.
  // POST /compile  body: {"source": "<sketch text>", "board": "<CircuitBoard.type, optional>"}
  // "board" selects the -mmcu=/variant target (see avr_toolchain.hpp's
  // resolve_board_target()) - omitted or unrecognized falls back to
  // Arduino Uno, matching this endpoint's original single-board behavior.
  // "nano-rp2040-connect" routes to rp2040_toolchain.cpp instead (a
  // genuinely different toolchain - arm-none-eabi-gcc + pico-sdk, driven
  // through cmake rather than avr_toolchain.cpp's flat per-file gcc
  // invocations - see rp2040_toolchain.hpp and ARCHITECTURE.md's "RP2040
  // firmware pipeline" section). Its output is a raw flash binary, not
  // Intel HEX (RP2040 has no such convention), so it comes back as
  // "binHex" (plain hex-pair-per-byte, no Intel HEX record framing) rather
  // than reusing "hexText" - the two boards' compile outputs are shaped
  // differently enough that overloading one field name would be
  // misleading, not simplifying.
  server.Post("/compile", [](const httplib::Request &req, httplib::Response &res) {
    json body;
    try {
      body = json::parse(req.body);
    } catch (const std::exception &) {
      res.status = 400;
      res.set_header("Cache-Control", "no-store");
      res.set_content(R"({"ok":false,"log":"invalid JSON body"})", "application/json");
      return;
    }
    const std::string source = body.value("source", std::string{});
    if (source.empty()) {
      res.status = 400;
      res.set_header("Cache-Control", "no-store");
      res.set_content(R"({"ok":false,"log":"empty sketch source"})", "application/json");
      return;
    }
    const std::string board = body.value("board", std::string{"arduino-uno"});

    if (board == "esp32-devkit-v1") {
      // Real ESP-IDF build via esp32_toolchain.cpp - a genuinely heavier
      // pipeline than avr-gcc's flat per-file compile or pico-sdk's
      // cmake-driven one (a full multi-component CMake project: sdkconfig,
      // partition table, bootloader, esptool merge_bin), and its toolchain
      // discovery is dev-machine-only today, not bundled/portable yet -
      // see esp32_toolchain.hpp. toolchain_available() check first so a
      // machine without it gets a clear, immediate error rather than a
      // confusing failure partway through a real compile attempt.
      if (!esp32toolchain::toolchain_available()) {
        res.status = 501;
        res.set_header("Cache-Control", "no-store");
        res.set_content(
            R"({"ok":false,"log":"ESP32 toolchain not found on this machine - see )"
            R"(esp32_toolchain.hpp for the expected esp-idf/tooling layout."})",
            "application/json");
        return;
      }
      const auto result = esp32toolchain::compile_sketch(source);
      json out = {{"ok", result.ok}, {"log", result.log}};
      if (result.ok) {
        out["binHex"] = encode_hex_bytes(result.binary);
      }
      res.set_header("Cache-Control", "no-store");
      res.status = result.ok ? 200 : 422;
      res.set_content(out.dump(), "application/json");
      return;
    }

    if (board == "nano-rp2040-connect" || board == "pi-pico" || board == "pi-pico-w") {
      const auto result = rp2040toolchain::compile_sketch(source);
      json out = {{"ok", result.ok}, {"log", result.log}};
      if (result.ok) {
        out["binHex"] = encode_hex_bytes(result.binary);
      }
      res.set_header("Cache-Control", "no-store");
      res.status = result.ok ? 200 : 422;
      res.set_content(out.dump(), "application/json");
      return;
    }

    const auto result = avrtoolchain::compile_sketch(source, board);
    json out = {{"ok", result.ok}, {"log", result.log}};
    if (result.ok) {
      out["hexText"] = result.hex_text;
    }
    res.set_header("Cache-Control", "no-store");
    res.status = result.ok ? 200 : 422;
    res.set_content(out.dump(), "application/json");
  });

  // Serve embedded static assets from public/.
  httplib::mount(server, Web::FS);


  // -----------------------------
  // Bind server to available port
  // -----------------------------
  auto port = server.bind_to_any_port("127.0.0.1");
  if (port <= 0) {
    std::cerr << "[fatal] Failed to bind HTTP server to 127.0.0.1 (port in use?)" << std::endl;
    return 1;
  }


  // Start HTTP server thread
  std::thread server_thread([&]() { server.listen_after_bind(); });


  // -----------------------------
  // Show (or hide) the webview and start its message loop.
  // -----------------------------
  std::thread shutdown_watcher;
  if (headless) {
    hide_window(w);
    std::cout << "[physicalsim] listening on 127.0.0.1:" << port
              << " (headless)" << std::endl;
    shutdown_watcher = std::thread([&w]() {
      wait_for_shutdown_signal();
      w.dispatch([&w]() { w.terminate(); });
    });
  } else {
    w.set_size(1440, 800, WEBVIEW_HINT_NONE);
#ifdef _WIN32
    apply_windows_icons(w);
#endif
#ifdef __linux__
    apply_linux_icon(w);
#endif
  }

  w.navigate("http://127.0.0.1:" + std::to_string(port));
  w.run();

  if (shutdown_watcher.joinable()) {
    shutdown_watcher.join();
  }


  // -----------------------------
  // Shutdown sequence
  // -----------------------------
  server.stop();
  server_thread.join();
  work_guard.reset();
  heartbeat_timer.cancel();
  ioc.stop();
  asio_thread.join();

  return 0;
}
