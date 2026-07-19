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

constexpr std::size_t kMaxRequestBodyBytes = 64 * 1024;

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

        const json result = dispatch_bridge_call(w, adapter, method, params);
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
    w.set_size(900, 640, WEBVIEW_HINT_NONE);
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
