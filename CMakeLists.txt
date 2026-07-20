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

cpp_embedlib_add(WebAssets
    FOLDER    ${CMAKE_CURRENT_SOURCE_DIR}/public
    NAMESPACE Web
)

# ---- Application target and hardening --------------------------------------
add_executable(physicalsim src/main.cpp src/qemu_adapter.cpp)

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
            COMMAND ${CMAKE_COMMAND} -E copy_directory
                "${WEBVIEW2_FIXED_RUNTIME_DIR}"
                $<TARGET_FILE_DIR:physicalsim>/WebView2Runtime
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
endif()
