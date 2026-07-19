#!/usr/bin/env bash
set -euo pipefail

# ===========================================================================
# vecnode 2026 - Linux Portable Release Packager
# Purpose: Build a distributable Release package.
# Usage: package_release.sh
# ===========================================================================

# --- Script context ---------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# --- Output directory -------------------------------------------------------
OUT_DIR="${HOME}/Desktop/Release"

# --- CMake discovery --------------------------------------------------------
CMAKE_EXE=""
if command -v cmake &>/dev/null; then
    CMAKE_EXE="$(command -v cmake)"
fi

if [[ -z "$CMAKE_EXE" ]]; then
    echo "[error] cmake not found. Install CMake and try again."
    echo "        sudo apt install cmake   (Ubuntu/Debian)"
    echo "        sudo dnf install cmake   (Fedora)"
    exit 1
fi

# --- System dependency check (webkit2gtk required by webview on Linux) ------
# webkit2gtk is a system library on Linux — no bundling required.
# Fail early with a clear message if the development headers are missing.
WEBKIT_OK=0
pkg-config --exists webkit2gtk-4.1 2>/dev/null && WEBKIT_OK=1
pkg-config --exists webkit2gtk-4.0 2>/dev/null && WEBKIT_OK=1

if [[ "$WEBKIT_OK" -eq 0 ]]; then
    echo "[error] webkit2gtk not found via pkg-config. Install it and rerun."
    echo "        sudo apt install libwebkit2gtk-4.1-dev   (Ubuntu 22.04+/Debian)"
    echo "        sudo apt install libwebkit2gtk-4.0-dev   (Ubuntu 20.04)"
    echo "        sudo dnf install webkit2gtk4.1-devel     (Fedora)"
    exit 1
fi

# --- Web layer (Vite build -> public/, embedded by CMake) -------------------
if ! command -v npm &>/dev/null; then
    echo "[error] npm not found. Install Node.js and try again."
    exit 1
fi

echo "[1/4] Building web/ (npm install + vite build -> public/)"
(cd web && npm install && npm run build)

# --- Configure portable Release build ---------------------------------------
echo "[2/4] Configuring portable Release build..."
"$CMAKE_EXE" -B build \
    -DCMAKE_BUILD_TYPE=Release

# --- Build Release target ---------------------------------------------------
echo "[3/4] Building physicalsim (Release)..."
"$CMAKE_EXE" --build build --target physicalsim -j

# --- Export portable package ------------------------------------------------
echo "[4/4] Exporting package to: $OUT_DIR"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

cp "build/physicalsim" "$OUT_DIR/physicalsim"
chmod +x "$OUT_DIR/physicalsim"

# Copy assets (PNG preferred on Linux; ICO files included as well)
if [[ -d "assets" ]]; then
    cp -r "assets" "$OUT_DIR/assets"
fi

# On Linux, webkit2gtk is a system library — no runtime folder to bundle.

echo
echo "Package complete."
echo "Folder: $OUT_DIR"
