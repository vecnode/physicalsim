#!/usr/bin/env bash
set -euo pipefail

# ===========================================================================
# vecnode 2026 - Linux Release Build and Run Script
# Purpose: Configure, build, package, and run webview-app using a clean
# GCC/Clang toolchain. Mirrors the functionality of build_and_run.bat and
# package_release.bat on Windows.
# ===========================================================================

# --- Script context ---------------------------------------------------------
# Always run from the repository root (the folder this script is in).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# --- CLI options ------------------------------------------------------------
CLEAN_BUILD=0
if [[ "${1:-}" == "--clean" ]] || [[ "${1:-}" == "clean" ]] || [[ "${1:-}" == "/clean" ]]; then
    CLEAN_BUILD=1
fi

# --- Output directory -------------------------------------------------------
OUT_DIR="${HOME}/Desktop/Release"

# --- CMake discovery --------------------------------------------------------
CMAKE_EXE=""
if command -v cmake &>/dev/null; then
    CMAKE_EXE="$(command -v cmake)"
fi

if [[ -z "$CMAKE_EXE" ]]; then
    echo "[error] cmake not found. Install cmake and try again."
    echo "        sudo apt install cmake   (Ubuntu/Debian)"
    echo "        sudo dnf install cmake   (Fedora)"
    exit 1
fi

# --- System dependency check (webkit2gtk required by webview on Linux) ------
if ! pkg-config --exists webkit2gtk-4.1 2>/dev/null && \
   ! pkg-config --exists webkit2gtk-4.0 2>/dev/null; then
    echo "[warning] webkit2gtk not detected via pkg-config. The build may fail."
    echo "          Install: sudo apt install libwebkit2gtk-4.1-dev   (Ubuntu 22.04+/Debian)"
    echo "                or sudo apt install libwebkit2gtk-4.0-dev   (Ubuntu 20.04)"
    echo "                or sudo dnf install webkit2gtk4.1-devel     (Fedora)"
fi

# --- Optional clean ---------------------------------------------------------
# Keep incremental builds fast by default. Full cache cleanup is available
# when explicitly requested: build_and_run.sh --clean
if [[ "$CLEAN_BUILD" -eq 1 ]]; then
    echo "[info] Clean rebuild requested. Clearing CMake caches..."
    [[ -f "build/CMakeCache.txt" ]] && rm -f "build/CMakeCache.txt"
    [[ -d "build/CMakeFiles" ]]     && rm -rf "build/CMakeFiles"
    if [[ -d "build/_deps" ]]; then
        for dir in build/_deps/*-build build/_deps/*-subbuild; do
            [[ -d "$dir" ]] || continue
            [[ -f "$dir/CMakeCache.txt" ]] && rm -f "$dir/CMakeCache.txt"
            [[ -d "$dir/CMakeFiles" ]]     && rm -rf "$dir/CMakeFiles"
        done
    fi
fi

# --- Web layer (Vite build -> public/, embedded by CMake) -------------------
if ! command -v npm &>/dev/null; then
    echo "[error] npm not found. Install Node.js and try again."
    exit 1
fi

echo "[1/5] Building web/ (npm install + vite build -> public/)"
(cd web && npm install && npm run build)

# --- Configure / Build / Package / Run --------------------------------------
echo "[2/5] Configuring CMake (Release)"
"$CMAKE_EXE" -B build -DCMAKE_BUILD_TYPE=Release

echo "[3/5] Building webview-app (Release)"
"$CMAKE_EXE" --build build --target webview-app -j

echo "[4/5] Packaging to: $OUT_DIR"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

cp "build/webview-app" "$OUT_DIR/webview-app"
chmod +x "$OUT_DIR/webview-app"

# Copy icons if present (source icons/ directory)
if [[ -d "icons" ]]; then
    cp -r "icons" "$OUT_DIR/icons"
fi

# On Linux, webkit2gtk is a system library — no runtime files need bundling.

echo "[5/5] Running webview-app"
if [[ ! -x "$OUT_DIR/webview-app" ]]; then
    echo "ERROR: $OUT_DIR/webview-app not found or not executable."
    exit 1
fi

"$OUT_DIR/webview-app"

echo
echo "Success."
echo "Package: $OUT_DIR"
