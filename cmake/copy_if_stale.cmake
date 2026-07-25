# Copies SRC to DEST, but skips the copy entirely when DEST already holds an
# up-to-date copy (a stamp file newer than every file under SRC). This exists
# because `${CMAKE_COMMAND} -E copy_directory` always re-copies every byte on
# every build, even when nothing changed - for the larger vendored trees
# (pico-sdk, avr-toolchain, ArduinoCore-avr) that made every dev build pay a
# multi-second "Copying runtime files" tax it didn't need to. Invoked via
# `cmake -DSRC=... -DDEST=... -DSTAMP=... -P copy_if_stale.cmake` from a
# POST_BUILD add_custom_command.
#
# Required args: SRC, DEST, STAMP (stamp filename written inside DEST).

if(NOT DEFINED SRC OR NOT DEFINED DEST OR NOT DEFINED STAMP)
    message(FATAL_ERROR "copy_if_stale.cmake requires -DSRC=, -DDEST=, -DSTAMP=")
endif()

set(_stamp_file "${DEST}/${STAMP}")
set(_needs_copy TRUE)

if(EXISTS "${_stamp_file}")
    file(GLOB_RECURSE _srcs "${SRC}/*")
    set(_newest 0)
    foreach(_f ${_srcs})
        file(TIMESTAMP "${_f}" _t "%s")
        if(_t AND _t GREATER _newest)
            set(_newest ${_t})
        endif()
    endforeach()
    file(TIMESTAMP "${_stamp_file}" _stamp_t "%s")
    if(_stamp_t AND NOT _newest GREATER _stamp_t)
        set(_needs_copy FALSE)
    endif()
endif()

if(_needs_copy)
    file(REMOVE_RECURSE "${DEST}")
    file(MAKE_DIRECTORY "${DEST}")
    file(COPY "${SRC}/" DESTINATION "${DEST}")
    file(WRITE "${_stamp_file}" "")
else()
    message(STATUS "[physicalsim] ${DEST} already up to date, skipping copy")
endif()
