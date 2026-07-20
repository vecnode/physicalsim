@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM ===========================================================================
REM vecnode 2026 - Windows Portable Release Packager
REM Purpose: Build a distributable Release package with bundled fixed WebView2.
REM Usage: package_release.bat
REM ===========================================================================

REM --- Script context ---------------------------------------------------------
pushd "%~dp0"

REM --- Output and runtime resolution state -----------------------------------
set "OUT_DIR=%USERPROFILE%\Desktop\Release"
set "FIXED_RUNTIME_DIR="
set "QEMU_ARM_DIR="
set "QEMU_ARM_ARGS="

REM --- CMake discovery --------------------------------------------------------
set "CMAKE_EXE="
if exist "%ProgramFiles%\CMake\bin\cmake.exe" set "CMAKE_EXE=%ProgramFiles%\CMake\bin\cmake.exe"
if not defined CMAKE_EXE if exist "%ProgramFiles(x86)%\CMake\bin\cmake.exe" set "CMAKE_EXE=%ProgramFiles(x86)%\CMake\bin\cmake.exe"
if not defined CMAKE_EXE for /f "delims=" %%I in ('where cmake 2^>nul') do if not defined CMAKE_EXE set "CMAKE_EXE=%%I"
if not defined CMAKE_EXE (
  echo [error] cmake.exe not found. Install CMake and try again.
  goto :error
)

REM --- Web layer (Vite build -> public/, embedded by CMake) -------------------
where npm >nul 2>&1
if errorlevel 1 (
  echo [error] npm not found. Install Node.js and try again.
  goto :error
)

echo [1/4] Building web\ (npm install + vite build -^> public\)
pushd web
call npm install
if errorlevel 1 (popd & goto :error)
call npm run build
if errorlevel 1 (popd & goto :error)
popd

REM --- Configure portable Release with fixed WebView2 ------------------------
echo [2/4] Configuring portable Release build...
set "WEBVIEW2_APP_BASE=%ProgramFiles(x86)%\Microsoft\EdgeWebView\Application"
if not exist "!WEBVIEW2_APP_BASE!" (
  echo [error] WebView2 Runtime installation not found at:
  echo         !WEBVIEW2_APP_BASE!
  echo         Install Microsoft Edge WebView2 Runtime and rerun.
  goto :error
)

for /f "usebackq delims=" %%I in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$base = [IO.Path]::GetFullPath($env:WEBVIEW2_APP_BASE); $best = Get-ChildItem -Path $base -Directory -ErrorAction SilentlyContinue | ForEach-Object { try { [pscustomobject]@{ Path = $_.FullName; Version = [version]$_.Name } } catch {} } | Sort-Object Version -Descending | Select-Object -First 1; if ($best) { Write-Output $best.Path }"`) do (
  if not defined FIXED_RUNTIME_DIR set "FIXED_RUNTIME_DIR=%%I"
)

if not defined FIXED_RUNTIME_DIR (
  echo [error] Could not resolve installed WebView2 Runtime version folder.
  goto :error
)

if not exist "!FIXED_RUNTIME_DIR!\msedgewebview2.exe" (
  echo [error] Resolved WebView2 Runtime folder is invalid:
  echo         !FIXED_RUNTIME_DIR!
  goto :error
)

set "FIXED_RUNTIME_DIR_FOR_CMAKE="
for %%I in ("!FIXED_RUNTIME_DIR!") do set "FIXED_RUNTIME_DIR_FOR_CMAKE=%%~sI"
if not defined FIXED_RUNTIME_DIR_FOR_CMAKE set "FIXED_RUNTIME_DIR_FOR_CMAKE=!FIXED_RUNTIME_DIR!"

echo     Using fixed runtime from: !FIXED_RUNTIME_DIR!

REM qemu-system-arm (the "cortex-m" adapter's backend) is optional -
REM physicalsim runs fine without it, just without that one adapter, so
REM this is a warning, not a packaging failure, when not found.
if exist "%ProgramFiles%\qemu\qemu-system-arm.exe" set "QEMU_ARM_DIR=%ProgramFiles%\qemu"
if not defined QEMU_ARM_DIR if exist "%ProgramFiles(x86)%\qemu\qemu-system-arm.exe" set "QEMU_ARM_DIR=%ProgramFiles(x86)%\qemu"

if defined QEMU_ARM_DIR (
  echo     Bundling qemu-system-arm from: !QEMU_ARM_DIR!
  set QEMU_ARM_ARGS=-DBUNDLE_QEMU_ARM=ON "-DQEMU_ARM_DIR=!QEMU_ARM_DIR!"
) else (
  echo     [warning] qemu-system-arm not found - packaging without it.
  echo               The cortex-m adapter will need QEMU installed separately
  echo               on the machine this package runs on. Install from
  echo               https://www.qemu.org/download/ and rerun to bundle it.
)

"%CMAKE_EXE%" -B build ^
  -DINCLUDE_TERMINAL_ON_RELEASE=OFF ^
  -DSTATIC_MSVC_RUNTIME_RELEASE=ON ^
  -DBUNDLE_WEBVIEW2_FIXED_RUNTIME=ON ^
  "-DWEBVIEW2_FIXED_RUNTIME_DIR=!FIXED_RUNTIME_DIR_FOR_CMAKE!" ^
  !QEMU_ARM_ARGS!
if errorlevel 1 goto :error

REM --- Build Release target ---------------------------------------------------
echo [3/4] Building physicalsim ^(Release^)...
"%CMAKE_EXE%" --build build --target physicalsim -j --config Release
if errorlevel 1 goto :error

REM --- Export portable package ------------------------------------------------
echo [4/4] Exporting package to: %OUT_DIR%
if exist "%OUT_DIR%" rd /s /q "%OUT_DIR%"
mkdir "%OUT_DIR%"

copy /y "build\Release\physicalsim.exe" "%OUT_DIR%\physicalsim.exe" >nul
if errorlevel 1 goto :error

if exist "build\Release\WebView2Loader.dll" (
  copy /y "build\Release\WebView2Loader.dll" "%OUT_DIR%\WebView2Loader.dll" >nul
)

if exist "build\Release\assets" (
  xcopy "build\Release\assets" "%OUT_DIR%\assets" /E /I /Y >nul
)

if exist "build\Release\WebView2Runtime" (
  xcopy "build\Release\WebView2Runtime" "%OUT_DIR%\WebView2Runtime" /E /I /Y >nul
)

if exist "build\Release\qemu" (
  xcopy "build\Release\qemu" "%OUT_DIR%\qemu" /E /I /Y >nul
)

echo.
echo Package complete.
echo Folder: %OUT_DIR%
goto :end

:error
echo.
echo Packaging failed.

REM --- Script exit ------------------------------------------------------------
:end
popd
exit /b 0
