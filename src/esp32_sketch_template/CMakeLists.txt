# Vendored template for src/esp32_toolchain.cpp's compile_sketch() - not a
# vendored dependency, physicalsim's own file. Copied into a persistent
# work directory alongside a generated main.c (the user's app_main()
# body), configured once (a full ESP-IDF component-tree configure is real
# work) and rebuilt incrementally per "Compile & Run" click via ninja.
#
# IDF_PATH must be set in the environment (esp32_toolchain.cpp sets it,
# not this file - this file only knows the shape of the project, not
# where the esp-idf checkout/toolchain live on disk).
cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(physicalsim_esp32_sketch)
