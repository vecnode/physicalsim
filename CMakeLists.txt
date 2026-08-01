# ============================================================================
# vecnode 2026 - Build Configuration
# Purpose: Configure physicalsim with secure defaults and portable
# Windows packaging support.
# ============================================================================

# ---- Project baseline -------------------------------------------------------
cmake_minimum_required(VERSION 3.20)
project(physicalsim CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# ---- User-configurable build options ---------------------------------------
option(INCLUDE_TERMINAL_ON_RELEASE "Keep console window visible for Windows Release builds" OFF)
option(STATIC_MSVC_RUNTIME_RELEASE "Use static MSVC runtime in non-Debug configs" ON)
option(BUNDLE_WEBVIEW2_FIXED_RUNTIME "Bundle a fixed WebView2 runtime folder into the output" OFF)
set(WEBVIEW2_FIXED_RUNTIME_DIR "" CACHE PATH "Path to fixed WebView2 runtime directory")

include(FetchContent)

# simulators/esp-idf (vendored, see below) is genuinely too big to always
# ship - a real ESP-IDF checkout with its own submodules runs to hundreds
# of MB, with no clean per-file trim boundary (same reasoning
# BUNDLE_XTENSA_TOOLCHAIN's own comment gives). Off by default; a dev
# build without this still works via esp32_toolchain.cpp's
# PHYSICALSIM_SOURCE_DIR fallback straight to simulators/esp-idf before
# a packaged build's own copy step has run.
option(BUNDLE_ESP_IDF "Bundle vendored esp-idf next to the executable for a packaged ESP32 Compile & Run" OFF)

if(POLICY CMP0135)
    cmake_policy(SET CMP0135 NEW)
endif()

# Windows + MSVC: fail closed if MSYS2/MinGW include paths would contaminate the
# build. PATH contamination is reported as a warning so the launcher script can
# still repair the environment by loading vcvars and clearing include vars.
if(WIN32 AND MSVC)
    set(_mingw_patterns "msys64" "msys2" "mingw64" "mingw32")
    set(_env_vars "INCLUDE" "CPATH" "C_INCLUDE_PATH" "CPLUS_INCLUDE_PATH" "PATH")
    foreach(_var ${_env_vars})
        if(DEFINED ENV{${_var}})
            string(TOLOWER "$ENV{${_var}}" _value_lower)
            foreach(_pat ${_mingw_patterns})
                if(_value_lower MATCHES "${_pat}")
                    if(_var STREQUAL "PATH")
                        message(WARNING
                            "[physicalsim] PATH contains '${_pat}'. The Windows launcher will try to repair the build environment, but a clean Visual Studio Developer Command Prompt is recommended.")
                    else()
                        message(FATAL_ERROR
                            "[physicalsim] Unsafe Windows build environment detected. "
                            "${_var} contains '${_pat}', so MSVC may pick up MinGW/MSYS2 "
                            "headers instead of the Windows SDK. Use a clean Visual Studio "
                            "Developer Command Prompt and remove MSYS2/MinGW entries from include variables."
                        )
                    endif()
                endif()
            endforeach()
        endif()
    endforeach()
endif()

# Lightweight HTTP server.
# On Windows/MSVC in mixed shell environments, optional compression package
# discovery can accidentally bind to MinGW/MSYS pkg-config libraries.
if(WIN32)
    set(HTTPLIB_USE_BROTLI_IF_AVAILABLE OFF CACHE BOOL "" FORCE)
    set(HTTPLIB_USE_ZSTD_IF_AVAILABLE OFF CACHE BOOL "" FORCE)
endif()

# ---- Third-party dependencies (FetchContent) -------------------------------
FetchContent_Declare(httplib
    GIT_REPOSITORY https://github.com/yhirose/cpp-httplib
    GIT_TAG        master
)
FetchContent_MakeAvailable(httplib)

# Native desktop webview window.
FetchContent_Declare(webview
    GIT_REPOSITORY https://github.com/webview/webview
    GIT_TAG        master
    GIT_SHALLOW    TRUE
)
FetchContent_MakeAvailable(webview)

# Embed static frontend files into the binary.
FetchContent_Declare(cpp-embedlib
    GIT_REPOSITORY https://github.com/yhirose/cpp-embedlib
    GIT_TAG        main
)
FetchContent_MakeAvailable(cpp-embedlib)

# JSON, for the native<->JS bridge protocol (src/main.cpp <-> web/shell/src/native-bridge.ts).
FetchContent_Declare(nlohmann_json
    GIT_REPOSITORY https://github.com/nlohmann/json
    GIT_TAG        v3.11.3
)
FetchContent_MakeAvailable(nlohmann_json)

# Prebuilt xtensa-esp-elf-gcc toolchain (the "esp32" adapter's Compile & Run
# pipeline, src/esp32_toolchain.cpp) - a "copy an already-published
# archive in, don't build it ourselves" posture. Not xPack (checked
# directly - xpack-dev-tools publishes no
# xtensa/esp32 toolchain at all): Espressif
# publishes it themselves on espressif/crosstool-NG's GitHub releases -
# these are the exact URLs esp-idf's own installer (install.ps1/
# idf_tools.py) downloads, read straight out of a real esp-idf checkout's
# tools/tools.json rather than guessed. The Windows archive nests
# everything one level down inside its own "xtensa-esp-elf/" directory
# (confirmed by actually extracting it). Not yet confirmed whether
# macOS/Linux releases nest the same way (this project's ESP32 work so
# far has only run on Windows), so an EXISTS-based detection is applied
# here rather than assuming.
option(BUNDLE_XTENSA_TOOLCHAIN "Fetch and bundle a prebuilt xtensa-esp-elf-gcc toolchain for the in-app ESP32 sketch compiler" OFF)
set(XTENSA_TOOLCHAIN_BIN_DIR "")
if(BUNDLE_XTENSA_TOOLCHAIN)
    set(_xtensa_toolchain_version "esp-13.2.0_20240530")
    set(_xtensa_toolchain_base "https://github.com/espressif/crosstool-NG/releases/download/${_xtensa_toolchain_version}/xtensa-esp-elf-13.2.0_20240530")
    if(WIN32)
        set(_xtensa_toolchain_url "${_xtensa_toolchain_base}-x86_64-w64-mingw32_hotfix.zip")
    elseif(APPLE)
        if(CMAKE_SYSTEM_PROCESSOR MATCHES "arm64")
            set(_xtensa_toolchain_url "${_xtensa_toolchain_base}-aarch64-apple-darwin.tar.xz")
        else()
            set(_xtensa_toolchain_url "${_xtensa_toolchain_base}-x86_64-apple-darwin.tar.xz")
        endif()
    elseif(UNIX)
        if(CMAKE_SYSTEM_PROCESSOR MATCHES "aarch64")
            set(_xtensa_toolchain_url "${_xtensa_toolchain_base}-aarch64-linux-gnu.tar.xz")
        else()
            set(_xtensa_toolchain_url "${_xtensa_toolchain_base}-x86_64-linux-gnu.tar.xz")
        endif()
    endif()

    if(_xtensa_toolchain_url)
        FetchContent_Declare(xtensa_esp_toolchain URL ${_xtensa_toolchain_url})
        FetchContent_MakeAvailable(xtensa_esp_toolchain)
        if(EXISTS "${xtensa_esp_toolchain_SOURCE_DIR}/bin/xtensa-esp32-elf-gcc.exe" OR
           EXISTS "${xtensa_esp_toolchain_SOURCE_DIR}/bin/xtensa-esp32-elf-gcc")
            set(XTENSA_TOOLCHAIN_BIN_DIR "${xtensa_esp_toolchain_SOURCE_DIR}")
        else()
            set(XTENSA_TOOLCHAIN_BIN_DIR "${xtensa_esp_toolchain_SOURCE_DIR}/xtensa-esp-elf")
        endif()
    else()
        message(WARNING "[physicalsim] BUNDLE_XTENSA_TOOLCHAIN is ON but this platform has no known prebuilt xtensa-esp-elf-gcc URL - skipping")
    endif()
endif()

cpp_embedlib_add(WebAssets
    FOLDER    ${CMAKE_CURRENT_SOURCE_DIR}/public
    NAMESPACE Web
)

# ---- Application target and hardening --------------------------------------
add_executable(physicalsim src/main.cpp
    src/esp32_toolchain.cpp src/process_exec.cpp)

# Dev-build fallback so src/esp32_toolchain.cpp can find simulators/esp-idf
# straight from the source tree before the POST_BUILD copy below has ever
# run (e.g. the very first debug build). Packaged builds always have the
# POST_BUILD-copied esp-idf/ next to the executable and never need this.
target_compile_definitions(physicalsim PRIVATE
    PHYSICALSIM_SOURCE_DIR="${CMAKE_CURRENT_SOURCE_DIR}"
)

function(apply_hardening target_name)
    if(MSVC)
        target_compile_options(${target_name} PRIVATE
            /W4
            /wd4459
            /permissive-
            /sdl
            /guard:cf
        )
        target_link_options(${target_name} PRIVATE
            /DYNAMICBASE
            /NXCOMPAT
            /HIGHENTROPYVA
            /GUARD:CF
            /INCREMENTAL:NO
        )
    elseif(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
        target_compile_options(${target_name} PRIVATE
            -Wall
            -Wextra
            -Wpedantic
            -Wshadow
            -Wconversion
            -fstack-protector-strong
        )
        if(UNIX AND NOT APPLE)
            target_compile_options(${target_name} PRIVATE -fPIE)
            target_link_options(${target_name} PRIVATE -Wl,-z,relro,-z,now)
        endif()
    endif()
endfunction()

apply_hardening(physicalsim)

target_link_libraries(physicalsim PRIVATE
    httplib::httplib
    webview::core
    WebAssets
    cpp-embedlib-httplib
    nlohmann_json::nlohmann_json
)

if(APPLE)
    target_link_libraries(physicalsim PRIVATE
        "-framework CoreFoundation"
        "-framework Security"
    )
endif()

# ---- Windows compile/link configuration ------------------------------------
if(WIN32)
    # httplib's own sockets need Winsock and the correct API-level define.
    # _WIN32_WINNT=0x0A00 targets Windows 10 and enables modern async I/O APIs.
    # WIN32_LEAN_AND_MEAN keeps windows.h slim so it doesn't clash with the STL.
    # NOMINMAX prevents the windows.h min/max macros from conflicting with std::min/max.
    target_compile_definitions(physicalsim PRIVATE
        _WIN32_WINNT=0x0A00
        WIN32_LEAN_AND_MEAN
        NOMINMAX
    )
    target_link_libraries(physicalsim PRIVATE
        ws2_32
        mswsock
    )

    target_compile_definitions(physicalsim PRIVATE
        $<$<BOOL:${INCLUDE_TERMINAL_ON_RELEASE}>:INCLUDE_TERMINAL_ON_RELEASE=1>
        $<$<NOT:$<BOOL:${INCLUDE_TERMINAL_ON_RELEASE}>>:INCLUDE_TERMINAL_ON_RELEASE=0>
    )

    if(MSVC AND NOT INCLUDE_TERMINAL_ON_RELEASE)
        target_link_options(physicalsim PRIVATE
            $<$<CONFIG:Release>:/SUBSYSTEM:WINDOWS>
            $<$<CONFIG:Release>:/ENTRY:mainCRTStartup>
        )
    endif()

    if(MSVC AND STATIC_MSVC_RUNTIME_RELEASE)
        set_property(TARGET physicalsim PROPERTY
            MSVC_RUNTIME_LIBRARY "$<$<CONFIG:Debug>:MultiThreadedDebugDLL>$<$<NOT:$<CONFIG:Debug>>:MultiThreaded>"
        )
    endif()
endif()

# ---- Windows post-build runtime staging ------------------------------------
if(WIN32)
    # WebView2Loader.dll is shipped inside the MSWebView2 NuGet package that the
    # webview cmake fetches via FetchContent. Its path is architecture-specific.
    if(CMAKE_SYSTEM_PROCESSOR MATCHES "ARM64|arm64|aarch64")
        set(_wv2_arch "arm64")
    elseif(CMAKE_SIZEOF_VOID_P EQUAL 8)
        set(_wv2_arch "x64")
    else()
        set(_wv2_arch "x86")
    endif()
    set(_webview2_loader_dll
        "${CMAKE_BINARY_DIR}/_deps/microsoft_web_webview2-src/build/native/${_wv2_arch}/WebView2Loader.dll"
    )

    add_custom_command(TARGET physicalsim POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${_webview2_loader_dll}"
            $<TARGET_FILE_DIR:physicalsim>/WebView2Loader.dll
        COMMAND ${CMAKE_COMMAND} -E make_directory
            $<TARGET_FILE_DIR:physicalsim>/assets
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            ${CMAKE_CURRENT_SOURCE_DIR}/assets/app_icon_small.ico
            $<TARGET_FILE_DIR:physicalsim>/assets/app_icon_small.ico
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            ${CMAKE_CURRENT_SOURCE_DIR}/assets/app_icon.ico
            $<TARGET_FILE_DIR:physicalsim>/assets/app_icon.ico
        COMMENT "Copying runtime files to executable directory"
    )

    if(BUNDLE_WEBVIEW2_FIXED_RUNTIME)
        if(NOT EXISTS "${WEBVIEW2_FIXED_RUNTIME_DIR}")
            message(FATAL_ERROR
                "BUNDLE_WEBVIEW2_FIXED_RUNTIME is ON but WEBVIEW2_FIXED_RUNTIME_DIR is invalid: ${WEBVIEW2_FIXED_RUNTIME_DIR}"
            )
        endif()

        target_compile_definitions(physicalsim PRIVATE USE_FIXED_WEBVIEW2_RUNTIME=1)

        add_custom_command(TARGET physicalsim POST_BUILD
            COMMAND ${CMAKE_COMMAND}
                -DSRC=${WEBVIEW2_FIXED_RUNTIME_DIR}
                -DDEST=$<TARGET_FILE_DIR:physicalsim>/WebView2Runtime
                -DSTAMP=.copied.stamp
                -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/copy_if_stale.cmake
            COMMENT "Bundling fixed WebView2 runtime"
        )
    else()
        target_compile_definitions(physicalsim PRIVATE USE_FIXED_WEBVIEW2_RUNTIME=0)
    endif()

endif()

# ---- ESP32 sketch-compiler assets (cross-platform, not gated on WIN32) -----
# ArduinoCore-avr, ATTinyCore, and LiquidCrystal are all gone - every AVR
# board (Uno/Nano/Mega/Leonardo/Franzininho) runs through a JS-native
# runtime now (avr8js/arduino, see that repo), no C/C++ Arduino core
# needed for any of them. ESP32 is the one board family that still
# compiles for real.
#
# src/esp32_sketch_template is tiny (two CMakeLists.txt files) - always
# copied, same "small enough to always ship" posture the vendored AVR
# cores used to have. simulators/esp-idf itself is the opposite case (see
# BUNDLE_ESP_IDF's own comment above) - only copied when explicitly
# requested.
add_custom_command(TARGET physicalsim POST_BUILD
    COMMAND ${CMAKE_COMMAND}
        -DSRC=${CMAKE_CURRENT_SOURCE_DIR}/src/esp32_sketch_template
        -DDEST=$<TARGET_FILE_DIR:physicalsim>/esp32-sketch-template
        -DSTAMP=.copied.stamp
        -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/copy_if_stale.cmake
    COMMENT "Copying ESP32 sketch template"
)

if(BUNDLE_ESP_IDF)
    add_custom_command(TARGET physicalsim POST_BUILD
        COMMAND ${CMAKE_COMMAND}
            -DSRC=${CMAKE_CURRENT_SOURCE_DIR}/simulators/esp-idf
            -DDEST=$<TARGET_FILE_DIR:physicalsim>/esp-idf
            -DSTAMP=.copied.stamp
            -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/copy_if_stale.cmake
        COMMENT "Bundling vendored esp-idf (this can take a while - hundreds of MB)"
    )
endif()

# The xtensa-esp-elf toolchain itself, only when BUNDLE_XTENSA_TOOLCHAIN
# actually fetched one - off unless packaging a release. Lands at
# esp32-toolchain/bin/xtensa-esp32-elf-gcc.exe next to the executable -
# src/esp32_toolchain.cpp's find_toolchain() checks there first, before
# falling back to this dev machine's fixed C:\esp-idf/.espressif paths.
if(BUNDLE_XTENSA_TOOLCHAIN AND XTENSA_TOOLCHAIN_BIN_DIR)
    add_custom_command(TARGET physicalsim POST_BUILD
        COMMAND ${CMAKE_COMMAND}
            -DSRC=${XTENSA_TOOLCHAIN_BIN_DIR}
            -DDEST=$<TARGET_FILE_DIR:physicalsim>/esp32-toolchain
            -DSTAMP=.copied.stamp
            -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/copy_if_stale.cmake
        COMMENT "Bundling xtensa-esp-elf-gcc toolchain"
    )

    file(GLOB _xtensa_toolchain_license_files
        "${XTENSA_TOOLCHAIN_BIN_DIR}/*[Ll][Ii][Cc][Ee][Nn][Ss][Ee]*"
        "${XTENSA_TOOLCHAIN_BIN_DIR}/*COPYING*"
    )
    if(_xtensa_toolchain_license_files)
        add_custom_command(TARGET physicalsim POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different
                ${_xtensa_toolchain_license_files}
                $<TARGET_FILE_DIR:physicalsim>/esp32-toolchain/
            COMMENT "Bundling xtensa-esp-elf-gcc toolchain license"
        )
    endif()
endif()

