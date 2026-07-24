# Vendored template for src/rp2040_toolchain.cpp's compile_sketch() - not a
# vendored dependency, physicalsim's own file. Copied into a persistent work
# directory alongside a generated sketch.c (the user's setup()/loop() body,
# wrapped the same "just the body" way avr_toolchain.cpp's Arduino sketches
# are), then configured once and rebuilt incrementally per "Compile & Run"
# click - a full from-scratch pico-sdk build takes real time (~70 files),
# doing that per request the way avr_toolchain.cpp's per-request temp dirs
# do would make every click slow.
#
# PICO_SDK_PATH/PICO_TOOLCHAIN_PATH/PICO_BOARD are passed on the cmake
# command line by rp2040_toolchain.cpp, not hardcoded here - this file only
# knows the shape of the project, not where things live on disk.
cmake_minimum_required(VERSION 3.13)
include(${PICO_SDK_PATH}/pico_sdk_init.cmake)
project(physicalsim_rp2040_sketch C CXX ASM)
set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)
pico_sdk_init()
# hardware_adc/i2c/spi/pwm linked unconditionally alongside pico_stdlib -
# --gc-sections (pico-sdk's own default link flags) drops whatever a
# given sketch doesn't actually call, so linking them preemptively costs
# nothing at runtime; it just means a sketch can #include "hardware/adc.h"
# (etc.) and use it without this template needing to change per example.
add_executable(sketch sketch.c)
target_link_libraries(sketch pico_stdlib hardware_adc hardware_i2c hardware_spi hardware_pwm)
