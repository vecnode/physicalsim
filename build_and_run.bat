@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM ===========================================================================
REM vecnode 2026 - Windows Debug Build and Run Script
REM Purpose: Configure, build, and run physicalsim using a clean MSVC toolchain.
REM ===========================================================================

REM --- Script context ---------------------------------------------------------
REM Always run from the repository root (the folder this script is in).
pushd "%~dp0"

REM --- CLI options ------------------------------------------------------------
set "CLEAN_BUILD=0"
if /I "%~1"=="--clean" set "CLEAN_BUILD=1"
if /I "%~1"=="clean" set "CLEAN_BUILD=1"
if /I "%~1"=="/clean" set "CLEAN_BUILD=1"

REM ---------------------------------------------------------------------------
REM Locate Visual Studio and initialize a clean MSVC environment.
REM This prevents MSYS2/MinGW include paths from leaking into the build.
REM ---------------------------------------------------------------------------
set "VCVARS="

REM --- Environment sanitization ----------------------------------------------
REM Clear discovery variables that can point CMake at MSYS2/MinGW packages.
set "PKG_CONFIG_PATH="
set "PKG_CONFIG_LIBDIR="
set "PKG_CONFIG_SYSROOT_DIR="
set "CMAKE_PREFIX_PATH="
set "CMAKE_INCLUDE_PATH="
set "CMAKE_LIBRARY_PATH="
set "ZSTD_ROOT="
set "zstd_DIR="
set "BROTLI_ROOT="
set "Brotli_DIR="
set "ICU_ROOT="
set "ICU_DIR="

REM --- Visual Studio toolchain discovery -------------------------------------
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" set "VSWHERE=%ProgramFiles%\Microsoft Visual Studio\Installer\vswhere.exe"

if exist "%VSWHERE%" (
	for /f "delims=" %%I in ('"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find VC\Auxiliary\Build\vcvars64.bat') do (
		if not defined VCVARS set "VCVARS=%%I"
	)
)

if not defined VCVARS if exist "%ProgramFiles(x86)%\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=%ProgramFiles(x86)%\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
if not defined VCVARS if exist "%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not defined VCVARS if exist "%ProgramFiles%\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=%ProgramFiles%\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
if not defined VCVARS if exist "%ProgramFiles%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=%ProgramFiles%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"

if defined VCVARS (
	echo [info] Initialising MSVC environment from: %VCVARS%
	set "INCLUDE="
	set "LIB="
	set "LIBPATH="
	set "CPATH="
	set "C_INCLUDE_PATH="
	set "CPLUS_INCLUDE_PATH="
	set "PKG_CONFIG_PATH="
	set "PKG_CONFIG_LIBDIR="
	set "PKG_CONFIG_SYSROOT_DIR="
	set "CMAKE_PREFIX_PATH="
	set "CMAKE_INCLUDE_PATH="
	set "CMAKE_LIBRARY_PATH="
	set "ZSTD_ROOT="
	set "zstd_DIR="
	set "BROTLI_ROOT="
	set "Brotli_DIR="
	set "ICU_ROOT="
	set "ICU_DIR="
	call "%VCVARS%" >nul 2>&1
	REM Rebuild the MSVC include/library variables from the trusted vcvars output.
	REM This avoids inheriting MSYS2/MinGW headers even when the parent shell is dirty.
	if defined VCToolsInstallDir set "INCLUDE=%VCToolsInstallDir%include;"
	if defined WindowsSdkDir if defined WindowsSDKVersion set "INCLUDE=%INCLUDE%%WindowsSdkDir%Include\%WindowsSDKVersion%ucrt;%WindowsSdkDir%Include\%WindowsSDKVersion%um;%WindowsSdkDir%Include\%WindowsSDKVersion%shared;%WindowsSdkDir%Include\%WindowsSDKVersion%winrt;%WindowsSdkDir%Include\%WindowsSDKVersion%cppwinrt"
	if defined VCToolsInstallDir set "LIB=%VCToolsInstallDir%lib\x64;"
	if defined WindowsSdkDir if defined WindowsSDKVersion set "LIB=%LIB%%WindowsSdkDir%Lib\%WindowsSDKVersion%ucrt\x64;%WindowsSdkDir%Lib\%WindowsSDKVersion%um\x64"
	set "LIBPATH=%VCINSTALLDIR%Auxiliary\VS\lib\x64;"
	if defined VCToolsInstallDir set "LIBPATH=%VCToolsInstallDir%lib\x64;"
	if defined WindowsSdkDir if defined WindowsSDKVersion set "LIBPATH=%LIBPATH%%WindowsSdkDir%UnionMetadata\%WindowsSDKVersion%;%WindowsSdkDir%References\%WindowsSDKVersion%"
) else (
	echo [error] No vcvars64.bat found. Install the Visual Studio C++ Build Tools or run from a Visual Studio Developer Command Prompt.
	goto :error
)

REM --- CMake discovery --------------------------------------------------------
REM Resolve cmake explicitly so the build does not depend on PATH order.
set "CMAKE_EXE="
if exist "%ProgramFiles%\CMake\bin\cmake.exe" set "CMAKE_EXE=%ProgramFiles%\CMake\bin\cmake.exe"
if not defined CMAKE_EXE if exist "%ProgramFiles(x86)%\CMake\bin\cmake.exe" set "CMAKE_EXE=%ProgramFiles(x86)%\CMake\bin\cmake.exe"
if not defined CMAKE_EXE for /f "delims=" %%I in ('where cmake 2^>nul') do if not defined CMAKE_EXE set "CMAKE_EXE=%%I"
if not defined CMAKE_EXE (
	echo [error] cmake.exe not found. Install CMake or add it to the Visual Studio environment.
	goto :error
)

REM Keep incremental builds fast by default. Full cache cleanup is available
REM when explicitly requested: build_and_run.bat --clean
if "%CLEAN_BUILD%"=="1" (
	echo [info] Clean rebuild requested. Clearing CMake caches...
	if exist "build\CMakeCache.txt" del /f /q "build\CMakeCache.txt"
	if exist "build\CMakeFiles" rd /s /q "build\CMakeFiles"
	if exist "build\_deps" (
		for /d %%D in (build\_deps\*-build) do (
			if exist "%%D\CMakeCache.txt" del /f /q "%%D\CMakeCache.txt"
			if exist "%%D\CMakeFiles" rd /s /q "%%D\CMakeFiles"
		)
		for /d %%D in (build\_deps\*-subbuild) do (
			if exist "%%D\CMakeCache.txt" del /f /q "%%D\CMakeCache.txt"
			if exist "%%D\CMakeFiles" rd /s /q "%%D\CMakeFiles"
		)
	)
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

	REM --- Configure / Build / Run -----------------------------------------------
REM BUNDLE_AVR_TOOLCHAIN mirrors package_release.bat's Release config - the
REM in-app sketch compiler (src/avr_toolchain.cpp) needs a real avr-g++ next
REM to the exe, and without this flag a Debug build has none (no bundled
REM copy, and avr-g++ isn't normally on PATH), so "Compile & Run" always
REM fails with "AVR toolchain not found" even though avr-core/ is already
REM covered by the PHYSICALSIM_SOURCE_DIR dev-build fallback below.
echo [2/4] Configuring CMake
"%CMAKE_EXE%" -B build -DBUNDLE_AVR_TOOLCHAIN=ON
if errorlevel 1 goto :error

echo [3/4] Building physicalsim (Debug)
"%CMAKE_EXE%" --build build --target physicalsim -j --config Debug
if errorlevel 1 goto :error

echo [4/4] Running physicalsim
if not exist ".\build\Debug\physicalsim.exe" (
	echo ERROR: .\build\Debug\physicalsim.exe not found.
	goto :error
)

".\build\Debug\physicalsim.exe"
if errorlevel 1 goto :error

echo.
echo Success.
goto :end

:error
echo.
echo Build or run failed.

REM --- Script exit ------------------------------------------------------------
:end
popd
echo.
pause
