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

# The AVR toolchain (avr-gcc/avr-g++/avr-objcopy) backing the in-app
# Arduino sketch compiler (see src/avr_toolchain.cpp). Unlike WebView2
# above, this isn't "copy an already-installed directory" - it's fetched
# as Arduino's own prebuilt, redistributable toolchain archive (the exact
# one arduino-cli itself downloads) via FetchContent below, the same
# "download a URL tarball, don't build from source" shape already used for
# Boost's official release tarball. Off by default: it's a ~150MB
# download, only needed to actually compile sketches - src/avr_toolchain.cpp
# falls back to PATH/an existing Arduino IDE install when unbundled.
option(BUNDLE_AVR_TOOLCHAIN "Fetch and bundle a prebuilt avr-gcc toolchain for the in-app sketch compiler" OFF)
# Same shape and reasoning as BUNDLE_AVR_TOOLCHAIN above, for the RP2040
# sketch compiler (src/rp2040_toolchain.cpp) - a ~330MB xPack arm-none-eabi-
# gcc release rather than Arduino's own avr-gcc mirror, since Arduino
# doesn't publish a prebuilt arm-none-eabi-gcc at the same well-known URL
# pattern BUNDLE_AVR_TOOLCHAIN's avr-gcc lives at (confirmed by trying).
option(BUNDLE_ARM_TOOLCHAIN "Fetch and bundle a prebuilt arm-none-eabi-gcc toolchain for the in-app RP2040 sketch compiler" OFF)

# simulators/esp-idf (vendored, see below) is genuinely too big to always
# ship the way pico-sdk's ~9MB unconditionally does - a real ESP-IDF
# checkout with its own submodules runs to hundreds of MB, with no clean
# per-file trim boundary (same reasoning BUNDLE_XTENSA_TOOLCHAIN's own
# comment gives for why pico-sdk's own "just always ship it" precedent
# doesn't apply here). Off by default; a dev build without this still
# works via esp32_toolchain.cpp's PHYSICALSIM_SOURCE_DIR fallback straight
# to simulators/esp-idf, the same way avr-core/pico-sdk fall back to their
# own source trees before their own copy steps have run.
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

# Boost — fetched as the official CMake-aware source tarball.
# Only the listed component libraries are configured/built; everything else is skipped.
set(BOOST_INCLUDE_LIBRARIES asio system)
set(BOOST_ENABLE_CMAKE ON)
FetchContent_Declare(Boost
    URL https://github.com/boostorg/boost/releases/download/boost-1.87.0/boost-1.87.0-cmake.tar.gz
)
FetchContent_MakeAvailable(Boost)

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

# Prebuilt avr-gcc toolchain (see BUNDLE_AVR_TOOLCHAIN above). This archive
# has no CMakeLists.txt of its own - FetchContent_MakeAvailable populates
# (downloads + extracts) it and, finding nothing to add_subdirectory(),
# stops there, which is exactly what's wanted for a plain prebuilt-binary
# vendor. AVR_TOOLCHAIN_BIN_DIR is only meaningful when BUNDLE_AVR_TOOLCHAIN
# is ON; src/avr_toolchain.cpp's own PATH/well-known-location fallback
# covers the OFF case.
set(AVR_TOOLCHAIN_BIN_DIR "")
if(BUNDLE_AVR_TOOLCHAIN)
    if(WIN32)
        set(_avr_toolchain_url "https://downloads.arduino.cc/tools/avr-gcc-7.3.0-atmel3.6.1-arduino7-i686-w64-mingw32.zip")
    elseif(APPLE)
        set(_avr_toolchain_url "https://downloads.arduino.cc/tools/avr-gcc-7.3.0-atmel3.6.1-arduino7-x86_64-apple-darwin14.tar.bz2")
    elseif(UNIX)
        set(_avr_toolchain_url "https://downloads.arduino.cc/tools/avr-gcc-7.3.0-atmel3.6.1-arduino7-x86_64-pc-linux-gnu.tar.bz2")
    endif()

    if(_avr_toolchain_url)
        FetchContent_Declare(avr_gcc_toolchain URL ${_avr_toolchain_url})
        FetchContent_MakeAvailable(avr_gcc_toolchain)
        # Despite the name, this is the *root* directory that gets mirrored
        # wholesale into avr-toolchain/ below (copy_directory copies
        # AVR_TOOLCHAIN_BIN_DIR's *contents*, so it needs to be "the thing
        # containing bin/, libexec/, etc.", not bin/ itself) - src/
        # avr_toolchain.cpp then looks for avr-toolchain/bin/avr-g++.exe.
        # Layout differs by platform archive, confirmed by actually
        # extracting and looking (not assumed): the macOS/Linux archives
        # nest the *entire* toolchain (bin/, include/, lib/, libexec/, the
        # "avr-"-prefixed compiler drivers and all) one level down inside a
        # top-level "avr/" directory. The Windows zip is flatter - bin/
        # (with the real avr-g++.exe/avr-gcc.exe/avr-objcopy.exe) and
        # libexec/ (cc1plus, needed at compile time) already sit at the
        # archive root; its own "avr/" subdirectory is just the AVR target
        # sysroot (unprefixed binutils only - ar.exe, ld.exe, no compiler
        # driver at all), not a second nested copy of the toolchain. Using
        # avr/bin/ on Windows silently drops the whole compiler while still
        # leaving something on disk (a real bug: BUNDLE_AVR_TOOLCHAIN
        # "succeeded" but Compile & Run still failed with the exact
        # toolchain-not-found error this whole feature exists to fix).
        if(EXISTS "${avr_gcc_toolchain_SOURCE_DIR}/bin/avr-g++.exe" OR EXISTS "${avr_gcc_toolchain_SOURCE_DIR}/bin/avr-g++")
            set(AVR_TOOLCHAIN_BIN_DIR "${avr_gcc_toolchain_SOURCE_DIR}")
        else()
            set(AVR_TOOLCHAIN_BIN_DIR "${avr_gcc_toolchain_SOURCE_DIR}/avr")
        endif()
    else()
        message(WARNING "[physicalsim] BUNDLE_AVR_TOOLCHAIN is ON but this platform has no known prebuilt avr-gcc URL - skipping")
    endif()
endif()

# Prebuilt arm-none-eabi-gcc toolchain (see BUNDLE_ARM_TOOLCHAIN above) - the
# xPack release archive is flat (bin/, lib/, etc. at its root, confirmed by
# extracting one), unlike the AVR archive's per-platform layout quirks above,
# so this doesn't need the same nested-vs-flat detection.
set(ARM_TOOLCHAIN_BIN_DIR "")
if(BUNDLE_ARM_TOOLCHAIN)
    set(_arm_toolchain_version "v15.2.1-1.1")
    set(_arm_toolchain_base "https://github.com/xpack-dev-tools/arm-none-eabi-gcc-xpack/releases/download/${_arm_toolchain_version}/xpack-arm-none-eabi-gcc-15.2.1-1.1")
    if(WIN32)
        set(_arm_toolchain_url "${_arm_toolchain_base}-win32-x64.zip")
    elseif(APPLE)
        if(CMAKE_SYSTEM_PROCESSOR MATCHES "arm64")
            set(_arm_toolchain_url "${_arm_toolchain_base}-darwin-arm64.tar.gz")
        else()
            set(_arm_toolchain_url "${_arm_toolchain_base}-darwin-x64.tar.gz")
        endif()
    elseif(UNIX)
        if(CMAKE_SYSTEM_PROCESSOR MATCHES "aarch64")
            set(_arm_toolchain_url "${_arm_toolchain_base}-linux-arm64.tar.gz")
        else()
            set(_arm_toolchain_url "${_arm_toolchain_base}-linux-x64.tar.gz")
        endif()
    endif()

    if(_arm_toolchain_url)
        FetchContent_Declare(arm_gcc_toolchain URL ${_arm_toolchain_url})
        FetchContent_MakeAvailable(arm_gcc_toolchain)
        set(ARM_TOOLCHAIN_BIN_DIR "${arm_gcc_toolchain_SOURCE_DIR}")
    else()
        message(WARNING "[physicalsim] BUNDLE_ARM_TOOLCHAIN is ON but this platform has no known prebuilt arm-none-eabi-gcc URL - skipping")
    endif()
endif()

# Prebuilt xtensa-esp-elf-gcc toolchain (the "esp32" adapter's Compile & Run
# pipeline, src/esp32_toolchain.cpp) - same "copy an already-published
# archive in, don't build it ourselves" posture as BUNDLE_AVR_TOOLCHAIN/
# BUNDLE_ARM_TOOLCHAIN above. Not xPack this time (checked directly -
# xpack-dev-tools publishes no xtensa/esp32 toolchain at all): Espressif
# publishes it themselves on espressif/crosstool-NG's GitHub releases -
# these are the exact URLs esp-idf's own installer (install.ps1/
# idf_tools.py) downloads, read straight out of a real esp-idf checkout's
# tools/tools.json rather than guessed. The Windows archive nests
# everything one level down inside its own "xtensa-esp-elf/" directory
# (confirmed by actually extracting it) - unlike BUNDLE_ARM_TOOLCHAIN's
# xPack archive, which is flat at its root. Not yet confirmed whether
# macOS/Linux releases nest the same way (this project's ESP32 work so
# far has only run on Windows), so the same EXISTS-based detection
# BUNDLE_AVR_TOOLCHAIN uses for its own per-platform nesting difference is
# applied here too, rather than assuming.
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
    src/avr_toolchain.cpp src/rp2040_toolchain.cpp src/esp32_toolchain.cpp src/process_exec.cpp)

# Dev-build fallback so src/avr_toolchain.cpp can find simulators/ArduinoCore-avr
# straight from the source tree before the POST_BUILD copy below has ever
# run (e.g. the very first debug build). Packaged builds always have the
# POST_BUILD-copied avr-core/ next to the executable and never need this.
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
    Boost::asio
    Boost::system
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
    # Boost.Asio on Windows requires Winsock and the correct API-level define.
    # _WIN32_WINNT=0x0A00 targets Windows 10 and enables modern async I/O APIs.
    # WIN32_LEAN_AND_MEAN keeps windows.h slim so it doesn't clash with Boost/STL.
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

# ---- AVR sketch-compiler assets (cross-platform, not gated on WIN32) -------
# The vendored core (simulators/ArduinoCore-avr's trimmed cores/arduino +
# variants/standard + variants/mega + variants/leonardo, LGPL 2.1) is
# small enough to always copy next to the executable, dev or packaged
# build alike - src/avr_toolchain.cpp looks for it there first, falling
# back to the source tree (PHYSICALSIM_SOURCE_DIR above) only if this
# hasn't run yet. Every variant is copied unconditionally (not just
# "standard") because avr_toolchain.cpp's resolve_board_target() picks
# between them per board at compile time, not at CMake configure time -
# Arduino Mega needs variants/mega's own pins_arduino.h (different port/
# pin mapping than the atmega328p boards' "standard" variant - see
# arduino-mega.ts on the JS side for the same D0-D53/A0-A15 mapping this
# variant's own tables encode), and Arduino Leonardo needs variants/
# leonardo's own (a genuinely different chip, atmega32u4 - see
# arduino-leonardo.ts).
add_custom_command(TARGET physicalsim POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory
        $<TARGET_FILE_DIR:physicalsim>/avr-core/cores
    COMMAND ${CMAKE_COMMAND}
        -DSRC=${CMAKE_CURRENT_SOURCE_DIR}/simulators/ArduinoCore-avr/cores/arduino
        -DDEST=$<TARGET_FILE_DIR:physicalsim>/avr-core/cores/arduino
        -DSTAMP=.copied.stamp
        -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/copy_if_stale.cmake
    COMMAND ${CMAKE_COMMAND} -E make_directory
        $<TARGET_FILE_DIR:physicalsim>/avr-core/variants
    COMMAND ${CMAKE_COMMAND}
        -DSRC=${CMAKE_CURRENT_SOURCE_DIR}/simulators/ArduinoCore-avr/variants/standard
        -DDEST=$<TARGET_FILE_DIR:physicalsim>/avr-core/variants/standard
        -DSTAMP=.copied.stamp
        -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/copy_if_stale.cmake
    COMMAND ${CMAKE_COMMAND}
        -DSRC=${CMAKE_CURRENT_SOURCE_DIR}/simulators/ArduinoCore-avr/variants/mega
        -DDEST=$<TARGET_FILE_DIR:physicalsim>/avr-core/variants/mega
        -DSTAMP=.copied.stamp
        -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/copy_if_stale.cmake
    COMMAND ${CMAKE_COMMAND}
        -DSRC=${CMAKE_CURRENT_SOURCE_DIR}/simulators/ArduinoCore-avr/variants/leonardo
        -DDEST=$<TARGET_FILE_DIR:physicalsim>/avr-core/variants/leonardo
        -DSTAMP=.copied.stamp
        -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/copy_if_stale.cmake
    COMMENT "Copying vendored ArduinoCore-avr (cores/arduino + variants/standard + variants/mega + variants/leonardo)"
)

# ATtiny85 (Franzininho, boards/franzininho.ts) needs a genuinely
# different core tree, not just a different variant of ArduinoCore-avr's
# own cores/arduino - ATtiny85 has no USART/SPI/TWI hardware and a much
# smaller register set, so its Arduino.h/wiring.c are written completely
# differently (SpenceKonde/ATTinyCore, LGPL 2.1, forked to
# vecnode/ATTinyCore). Bundled the same small-enough-to-always-ship way
# as ArduinoCore-avr above, under its own attiny-core/ folder rather than
# mixing into avr-core/ - avr_toolchain.cpp's resolve_board_target()
# picks which core tree to use per board, same as it already picks
# between variants/standard and variants/mega.
add_custom_command(TARGET physicalsim POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory
        $<TARGET_FILE_DIR:physicalsim>/attiny-core/cores
    COMMAND ${CMAKE_COMMAND}
        -DSRC=${CMAKE_CURRENT_SOURCE_DIR}/simulators/ATTinyCore/avr/cores/tiny
        -DDEST=$<TARGET_FILE_DIR:physicalsim>/attiny-core/cores/tiny
        -DSTAMP=.copied.stamp
        -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/copy_if_stale.cmake
    COMMAND ${CMAKE_COMMAND} -E make_directory
        $<TARGET_FILE_DIR:physicalsim>/attiny-core/variants
    COMMAND ${CMAKE_COMMAND}
        -DSRC=${CMAKE_CURRENT_SOURCE_DIR}/simulators/ATTinyCore/avr/variants/tinyx5
        -DDEST=$<TARGET_FILE_DIR:physicalsim>/attiny-core/variants/tinyx5
        -DSTAMP=.copied.stamp
        -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/copy_if_stale.cmake
    COMMENT "Copying vendored ATTinyCore (cores/tiny + variants/tinyx5)"
)

# Vendored Arduino libraries a sketch can #include - same "small enough to
# always copy, dev or packaged build alike" posture as the core above, and
# src/avr_toolchain.cpp falls back to the source tree the same way too.
# Each entry is one git submodule under simulators/ (LiquidCrystal is
# LGPL 2.1, same license as the core), following the modern Arduino 1.5+
# library layout (a src/ subfolder holding the real headers/sources) -
# adding a second library later is one more line here, not a new copying
# mechanism.
set(AVR_LIBRARIES LiquidCrystal)
foreach(_avr_lib ${AVR_LIBRARIES})
    add_custom_command(TARGET physicalsim POST_BUILD
        COMMAND ${CMAKE_COMMAND}
            -DSRC=${CMAKE_CURRENT_SOURCE_DIR}/simulators/${_avr_lib}/src
            -DDEST=$<TARGET_FILE_DIR:physicalsim>/avr-libraries/${_avr_lib}/src
            -DSTAMP=.copied.stamp
            -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/copy_if_stale.cmake
        COMMENT "Copying vendored Arduino library: ${_avr_lib}"
    )
endforeach()

# The toolchain itself, only when BUNDLE_AVR_TOOLCHAIN actually fetched one
# (see the FetchContent block above) - large (~150MB), opt-in.
if(BUNDLE_AVR_TOOLCHAIN AND AVR_TOOLCHAIN_BIN_DIR)
    add_custom_command(TARGET physicalsim POST_BUILD
        COMMAND ${CMAKE_COMMAND}
            -DSRC=${AVR_TOOLCHAIN_BIN_DIR}
            -DDEST=$<TARGET_FILE_DIR:physicalsim>/avr-toolchain
            -DSTAMP=.copied.stamp
            -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/copy_if_stale.cmake
        COMMENT "Bundling avr-gcc toolchain"
    )

    # The archive ships its own license text (GPLv3 for gcc/binutils) under
    # a version-specific name (e.g. "AVR Toolchain (GPL).txt") rather than
    # a fixed "COPYING" - globbed rather than hardcoded so this doesn't
    # silently stop bundling a license file on a toolchain version bump.
    file(GLOB _avr_toolchain_license_files
        "${AVR_TOOLCHAIN_BIN_DIR}/*[Ll][Ii][Cc][Ee][Nn][Ss][Ee]*"
        "${AVR_TOOLCHAIN_BIN_DIR}/*COPYING*"
    )
    if(_avr_toolchain_license_files)
        add_custom_command(TARGET physicalsim POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different
                ${_avr_toolchain_license_files}
                $<TARGET_FILE_DIR:physicalsim>/avr-toolchain/
            COMMENT "Bundling avr-gcc toolchain license"
        )
    endif()
endif()

# ---- RP2040 sketch-compiler assets (cross-platform, not gated on WIN32) ----
# simulators/pico-sdk is vendored *untrimmed* (unlike ArduinoCore-avr) -
# ~9MB, small enough to always ship, and its CMake build reaches into many
# more of its own subdirectories dynamically than ArduinoCore-avr's flat
# cores/arduino ever did, so there's no clean per-file trim boundary the way
# there was there (see ARCHITECTURE.md's "RP2040 firmware pipeline" section
# for how this was confirmed, not assumed).
add_custom_command(TARGET physicalsim POST_BUILD
    COMMAND ${CMAKE_COMMAND}
        -DSRC=${CMAKE_CURRENT_SOURCE_DIR}/simulators/pico-sdk
        -DDEST=$<TARGET_FILE_DIR:physicalsim>/pico-sdk
        -DSTAMP=.copied.stamp
        -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/copy_if_stale.cmake
    COMMAND ${CMAKE_COMMAND}
        -DSRC=${CMAKE_CURRENT_SOURCE_DIR}/src/rp2040_sketch_template
        -DDEST=$<TARGET_FILE_DIR:physicalsim>/rp2040-sketch-template
        -DSTAMP=.copied.stamp
        -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/copy_if_stale.cmake
    COMMENT "Copying vendored pico-sdk + RP2040 sketch template"
)

# ---- ESP32 sketch-compiler assets (cross-platform, not gated on WIN32) -----
# src/esp32_sketch_template is tiny (two CMakeLists.txt files) - always
# copied, same "small enough to always ship" posture as the RP2040 sketch
# template above. simulators/esp-idf itself is the opposite case (see
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

# The toolchain itself, only when BUNDLE_ARM_TOOLCHAIN actually fetched one -
# same "off unless packaging a release" posture as BUNDLE_AVR_TOOLCHAIN.
if(BUNDLE_ARM_TOOLCHAIN AND ARM_TOOLCHAIN_BIN_DIR)
    add_custom_command(TARGET physicalsim POST_BUILD
        COMMAND ${CMAKE_COMMAND}
            -DSRC=${ARM_TOOLCHAIN_BIN_DIR}
            -DDEST=$<TARGET_FILE_DIR:physicalsim>/arm-toolchain
            -DSTAMP=.copied.stamp
            -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/copy_if_stale.cmake
        COMMENT "Bundling arm-none-eabi-gcc toolchain"
    )

    file(GLOB _arm_toolchain_license_files
        "${ARM_TOOLCHAIN_BIN_DIR}/*[Ll][Ii][Cc][Ee][Nn][Ss][Ee]*"
        "${ARM_TOOLCHAIN_BIN_DIR}/*COPYING*"
    )
    if(_arm_toolchain_license_files)
        add_custom_command(TARGET physicalsim POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different
                ${_arm_toolchain_license_files}
                $<TARGET_FILE_DIR:physicalsim>/arm-toolchain/
            COMMENT "Bundling arm-none-eabi-gcc toolchain license"
        )
    endif()
endif()

# The xtensa-esp-elf toolchain itself, only when BUNDLE_XTENSA_TOOLCHAIN
# actually fetched one - same "off unless packaging a release" posture as
# BUNDLE_AVR_TOOLCHAIN/BUNDLE_ARM_TOOLCHAIN. Lands at
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

