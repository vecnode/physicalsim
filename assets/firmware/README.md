# Firmware fixtures

Compiled Intel HEX images for testing the "Load .hex…" button (see
[ARCHITECTURE.md](../../ARCHITECTURE.md)'s "Firmware loading (Stage 2)"
section) without needing a real AVR toolchain installed.

## `hello-serial.hex`

A hand-assembled ATmega328p program (no avr-gcc involved - there's no
compiler in this project yet, see ARCHITECTURE.md): prints
`PhysicalSim ready\r\n` over Serial in a loop, with a busy-wait delay
between each print so it doesn't flood the Serial Monitor instantly.

Each instruction's opcode was confirmed directly against `avr8js`'s own
instruction decoder (`simulators/avr8js/src/cpu/instruction.ts`), and the
program was verified by actually assembling and running it against a
real `Avr8Adapter` before this file was written - not hand-typed hex
digits taken on faith. 134 bytes: mostly `LDI`/`STS` pairs writing each
character of the message to `UDR0` (the USART transmit register), plus a
three-level `DEC`/`BRNE` countdown loop and an `RJMP` back to the start.

**To test it:** place an Arduino Uno (Apply), click "Load .hex…" and
pick this file, then Start - the Serial Monitor should immediately begin
filling with `PhysicalSim ready` lines.
