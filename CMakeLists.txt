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

# qemu-system-arm (the "cortex-m" adapter's backend) is never built or
# fetched by this project - like the WebView2 runtime above, this only
# copies an *already-installed* copy into the packaged output so a
# distributed build doesn't require the end user to have installed QEMU
# themselves. src/qemu_adapter.cpp still falls back to PATH/well-known
# system locations when unbundled (e.g. plain Debug dev builds).
option(BUNDLE_QEMU_ARM "Bundle qemu-system-arm + its DLLs into the output" OFF)
set(QEMU_ARM_DIR "" CACHE PATH "Path to an installed QEMU directory containing qemu-system-arm.exe")

# Same "copy an already-built copy in, don't fetch/build it ourselves"
# posture as BUNDLE_QEMU_ARM above, for the "esp32" adapter's backend
# (src/esp32_qemu_adapter.cpp) - qemu-system-xtensa from vecnode/qemu-esp32
# (a fork of lcgamboa/qemu, itself a fork of espressif/qemu; see that
# repo's README and the esp32-qemu-gpio-spike notes for why this specific
# fork, not the official Espressif one). Unlike qemu-system-arm, there's no
# OS package/installer for this - QEMU_XTENSA_DIR should point at a local
# `ninja qemu-system-xtensa.exe` build's build/ directory (see
# esp32_qemu_adapter.hpp's header comment for the exact build recipe).
# QEMU_XTENSA_PCBIOS_DIR points at that same source checkout's pc-bios/
# (the ROM images qemu-system-xtensa needs via -L, not built - vendored
# in-tree). ESP32_DEMO_FLASH_IMAGE points at a pre-built, esptool-merged
# flash image (bootloader+partition-table+app) - the fixed demo firmware
# the adapter boots until a real sketch-compile pipeline exists for esp32.
option(BUNDLE_QEMU_XTENSA "Bundle qemu-system-xtensa + its DLLs, ROMs, and a demo flash image into the output" OFF)
set(QEMU_XTENSA_DIR "" CACHE PATH "Path to a built qemu-esp32 directory containing qemu-system-xtensa.exe")
set(QEMU_XTENSA_PCBIOS_DIR "" CACHE PATH "Path to qemu-esp32's pc-bios/ directory (ROM images)")
set(ESP32_DEMO_FLASH_IMAGE "" CACHE FILEPATH "Path to a pre-built esp32 demo flash_image.bin")
# Unlike qemu-system-arm.exe (a self-contained official release with its
# DLLs sitting right next to it), a from-source MSYS2/mingw64 build of
# qemu-system-xtensa.exe links against runtime DLLs that live in the
# toolchain's own bin/ (e.g. C:/msys64/mingw64/bin), not next to the exe -
# confirmed with `ldd qemu-system-xtensa.exe` against the Phase 0 spike's
# actual build, not guessed. Separate cache var so QEMU_XTENSA_DIR can stay
# "just the build output directory".
set(QEMU_XTENSA_RUNTIME_DIR "" CACHE PATH "Path to the mingw64 bin/ directory holding qemu-system-xtensa.exe's runtime DLLs")

# The AVR toolchain (avr-gcc/avr-g++/avr-objcopy) backing the in-app
# Arduino sketch compiler (see src/avr_toolchain.cpp). Unlike QEMU/WebView2
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

include(FetchContent)

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
add_executable(physicalsim src/main.cpp src/qemu_adapter.cpp src/esp32_qemu_adapter.cpp
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

    if(BUNDLE_QEMU_ARM)
        set(_qemu_exe "${QEMU_ARM_DIR}/qemu-system-arm.exe")
        if(NOT EXISTS "${_qemu_exe}")
            message(FATAL_ERROR
                "BUNDLE_QEMU_ARM is ON but qemu-system-arm.exe was not found under QEMU_ARM_DIR: ${QEMU_ARM_DIR}"
            )
        endif()

        # qemu-system-arm.exe implicitly (not lazily) links its DLLs, so the
        # whole top-level *.dll set has to travel with it - checked with
        # dumpbin /dependents rather than guessing a minimal subset, which
        # would silently break on a QEMU version bump. The share/ directory
        # (BIOS/UEFI blobs for other architectures, ~355 MB) is not needed:
        # the netduinoplus2 machine boots straight off -kernel, confirmed
        # by actually running it, no -bios required.
        file(GLOB _qemu_dlls "${QEMU_ARM_DIR}/*.dll")

        add_custom_command(TARGET physicalsim POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E make_directory
                $<TARGET_FILE_DIR:physicalsim>/qemu
            COMMAND ${CMAKE_COMMAND} -E copy_if_different
                "${_qemu_exe}"
                $<TARGET_FILE_DIR:physicalsim>/qemu/qemu-system-arm.exe
            COMMAND ${CMAKE_COMMAND} -E copy_if_different
                ${_qemu_dlls}
                $<TARGET_FILE_DIR:physicalsim>/qemu/
            COMMENT "Bundling qemu-system-arm + DLLs"
        )

        if(EXISTS "${QEMU_ARM_DIR}/COPYING")
            add_custom_command(TARGET physicalsim POST_BUILD
                COMMAND ${CMAKE_COMMAND} -E copy_if_different
                    "${QEMU_ARM_DIR}/COPYING"
                    $<TARGET_FILE_DIR:physicalsim>/qemu/COPYING
                COMMENT "Bundling QEMU license (GPLv2)"
            )
        endif()
    endif()

    if(BUNDLE_QEMU_XTENSA)
        set(_qemu_xtensa_exe "${QEMU_XTENSA_DIR}/qemu-system-xtensa.exe")
        if(NOT EXISTS "${_qemu_xtensa_exe}")
            message(FATAL_ERROR
                "BUNDLE_QEMU_XTENSA is ON but qemu-system-xtensa.exe was not found under QEMU_XTENSA_DIR: ${QEMU_XTENSA_DIR}"
            )
        endif()
        if(NOT EXISTS "${QEMU_XTENSA_PCBIOS_DIR}/esp32-v3-rom.bin")
            message(FATAL_ERROR
                "BUNDLE_QEMU_XTENSA is ON but QEMU_XTENSA_PCBIOS_DIR doesn't look like a pc-bios/ directory: ${QEMU_XTENSA_PCBIOS_DIR}"
            )
        endif()
        if(NOT EXISTS "${ESP32_DEMO_FLASH_IMAGE}")
            message(FATAL_ERROR
                "BUNDLE_QEMU_XTENSA is ON but ESP32_DEMO_FLASH_IMAGE doesn't exist: ${ESP32_DEMO_FLASH_IMAGE}"
            )
        endif()

        add_custom_command(TARGET physicalsim POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E make_directory
                $<TARGET_FILE_DIR:physicalsim>/esp32-qemu
            COMMAND ${CMAKE_COMMAND} -E copy_if_different
                "${_qemu_xtensa_exe}"
                $<TARGET_FILE_DIR:physicalsim>/esp32-qemu/qemu-system-xtensa.exe
            COMMENT "Bundling qemu-system-xtensa"
        )

        # Runtime DLLs live in the mingw64 toolchain's own bin/, not next to
        # the exe (see QEMU_XTENSA_RUNTIME_DIR's own comment above) - this
        # exact list is what `ldd qemu-system-xtensa.exe` reported against
        # the Phase 0 spike's actual build, not a guessed minimal subset.
        if(QEMU_XTENSA_RUNTIME_DIR)
            set(_qemu_xtensa_dll_names
                libbrotlicommon.dll libbrotlidec.dll libbrotlienc.dll libbz2-1.dll
                libcrypto-3-x64.dll libcurl-4.dll libffi-8.dll libgcc_s_seh-1.dll
                libgcrypt-20.dll libgio-2.0-0.dll libglib-2.0-0.dll libgmodule-2.0-0.dll
                libgmp-10.dll libgnutls-30.dll libgobject-2.0-0.dll libgpg-error-0.dll
                libhogweed-6.dll libiconv-2.dll libidn2-0.dll libintl-8.dll libjpeg-8.dll
                liblzo2-2.dll libncursesw6.dll libnettle-8.dll libnghttp2-14.dll
                libnghttp3-9.dll libngtcp2_crypto_ossl-0.dll libngtcp2-16.dll
                libp11-kit-0.dll libpcre2-8-0.dll libpixman-1-0.dll libpng16-16.dll
                libpsl-5.dll libssh.dll libssh2-1.dll libssl-3-x64.dll libtasn1-6.dll
                libunistring-5.dll libusb-1.0.dll libwinpthread-1.dll libzstd.dll
                SDL2.dll zlib1.dll
            )
            set(_qemu_xtensa_dlls "")
            foreach(_dll_name ${_qemu_xtensa_dll_names})
                list(APPEND _qemu_xtensa_dlls "${QEMU_XTENSA_RUNTIME_DIR}/${_dll_name}")
            endforeach()
            add_custom_command(TARGET physicalsim POST_BUILD
                COMMAND ${CMAKE_COMMAND} -E copy_if_different
                    ${_qemu_xtensa_dlls}
                    $<TARGET_FILE_DIR:physicalsim>/esp32-qemu/
                COMMENT "Bundling qemu-system-xtensa's mingw64 runtime DLLs"
            )
        endif()

        add_custom_command(TARGET physicalsim POST_BUILD
            COMMAND ${CMAKE_COMMAND}
                -DSRC=${QEMU_XTENSA_PCBIOS_DIR}
                -DDEST=$<TARGET_FILE_DIR:physicalsim>/esp32-qemu/pc-bios
                -DSTAMP=.copied.stamp
                -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/copy_if_stale.cmake
            COMMENT "Bundling qemu-esp32 ROM images (pc-bios/)"
        )

        add_custom_command(TARGET physicalsim POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E make_directory
                $<TARGET_FILE_DIR:physicalsim>/esp32-demo
            COMMAND ${CMAKE_COMMAND} -E copy_if_different
                "${ESP32_DEMO_FLASH_IMAGE}"
                $<TARGET_FILE_DIR:physicalsim>/esp32-demo/flash_image.bin
            COMMENT "Bundling esp32 demo flash image"
        )
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
# (see the FetchContent block above) - large (~150MB), opt-in, same
# "off unless packaging a release" posture as BUNDLE_QEMU_ARM.
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
