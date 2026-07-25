import type { AVRPortConfig } from "avr8js";
import {
  attinyPortBConfig,
  portAConfig,
  portBConfig,
  portCConfig,
  portDConfig,
  portEConfig,
  portFConfig,
  portGConfig,
  portHConfig,
  portJConfig,
  portKConfig,
  portLConfig,
} from "avr8js";

// One Avr8Adapter class runs either chip - the AVR instruction set and
// the peripheral-0 register addresses (USART0, Timer0-2, SPI, TWI, ADC)
// are the same across the whole ATmega family for backward compatibility
// (confirmed against avr8js's own port configs below, which do carry
// real per-chip addresses - portH/J/K/L sit at 0x100+, genuinely
// different from the atmega328p's contiguous 0x23-0x2b block, not a
// simplification). What differs per chip is purely which ports exist and
// how big flash is - everything this interface names.
export interface AvrChipConfig {
  // Program memory size, in 16-bit words (avr8js's CPU takes a
  // Uint16Array program, one entry per instruction word).
  flashWords: number;
  // Port letter ("A".."L", skipping "I" the same way the real chips do)
  // -> that port's register config. Iterated in attachPeripherals() to
  // construct exactly the ports this chip actually has - an
  // atmega328p board resolving a pin on a port outside this set (say,
  // "A0" on an Uno, which has no PORTA at all) fails the same
  // "unknown port" way an unresolvable pin name always has.
  ports: Record<string, AVRPortConfig>;
  // Which port's bits double as ADC input channels, and how many of
  // that port's bits are wired to a real channel - atmega328p ties all
  // 6 of PORTC's bits to ADC0-5, while atmega2560 only ties PORTF's 8
  // bits to ADC0-7 (A8-A15, on PORTK, need the ADCSRB MUX5 bit this
  // fork's adcConfig doesn't model - see the "AVR EEPROM/SPI/I2C/ADC
  // gap" note in ARCHITECTURE.md for why that's a documented, not
  // silent, limitation).
  adcPortLetter: string;
  adcChannels: number;
  // Real EEPROM size, in bytes - 1KB on the atmega328p, 4KB on the
  // atmega2560 (confirmed against both datasheets).
  eepromBytes: number;
  // Whether attachPeripherals() (adapter.ts) should construct the
  // "shared ATmega-family" peripherals it hardcodes at fixed addresses
  // (Timer1, Timer2, USART0, SPI, TWI) - true for every ATmega chip
  // here, false for ATtiny85. ATtiny85 doesn't have USART/SPI/TWI
  // hardware at all (only USI, a different, unmodeled peripheral), and
  // its Timer1 is a completely different 8-bit high-speed timer (see
  // avr8js's timer-attiny.ts), not the 16-bit one timer1Config models.
  // Constructing these anyway wouldn't just be inert: timer1Config's
  // and timer2Config's own TIFR registers sit at 0x36/0x37 - the exact
  // same addresses as ATtiny85's real PINB/DDRB (see attinyPortBConfig
  // below) - so the phantom timers' memory hooks would silently
  // shadow (or be shadowed by, depending on construction order) the
  // GPIO port's own hooks at those addresses. Skipping them for
  // ATtiny85 is what keeps digital I/O genuinely correct rather than
  // depending on registration-order luck.
  hasAtmegaSharedPeripherals: boolean;
  // Whether attachPeripherals() (adapter.ts) needs to patch PLLCSR's
  // PLOCK bit (see the ATMEGA32U4 config below for why) - true only for
  // chips with a real native-USB PLL a compiled sketch's own core code
  // busy-waits on during boot.
  hasUsbPll: boolean;
  // Real hardware fact, only relevant when hasAtmegaSharedPeripherals is
  // true: does this chip have a Timer2/USART0 at all? Both default to
  // true (every chip here except ATmega32u4 has them) - ATmega32u4 has
  // no Timer2 (its third/fourth timers, Timer3/Timer4, aren't modeled by
  // this fork's plain AVRTimer at all) and only USART1, not USART0.
  // Constructing either as if this chip had them wouldn't just be a
  // no-op: their real vector-table slots on THIS chip's actual compiled
  // vector table point at something else entirely (see
  // timer0VectorOverride's own comment below) - not "unused genuinely-
  // absent hardware" but "misdirected interrupts landing wherever this
  // chip's specific compiled program happens to have code".
  hasTimer2?: boolean;
  hasUsart0?: boolean;
  // Interrupt VECTOR ADDRESS overrides - only needed when a chip's real
  // interrupt vector table has a different layout than the ATmega328p/
  // 2560 one timer0Config/timer1Config/spiConfig/twiConfig/adcConfig
  // (avr8js's own exports) hardcode their `*Interrupt`/`ovfInterrupt`/
  // etc fields for. This is a genuinely different thing from register
  // addresses (TCCR0A, TWDR, ADMUX, ...), which really are identical
  // across the whole classic-AVR family (confirmed directly against the
  // real avr-libc <avr/iom32u4.h> vs the atmega328p/2560 case) - only
  // *vector position* differs, and only because a chip with extra
  // peripherals inserted earlier in its vector table (ATmega32u4's two
  // USB vectors, at positions 10-11) shifts every later peripheral's
  // vector number versus a chip without them. Getting this wrong doesn't
  // fail loudly: the CPU still jumps somewhere and keeps executing, just
  // at the address the WRONG chip's vector table would have used - see
  // the ATMEGA32U4 config below for the real bug this caused (a Timer0
  // overflow interrupt landing on this chip's own USB_COM_vect slot,
  // recognizable as a "received SETUP packet" by USBCore.cpp's ISR and
  // hanging forever waiting for a UEINTX flag no real host will ever
  // set - a boot-time hang with no compiler error and no obviously
  // related symptom, only found by disassembling the actual compiled
  // .elf and tracing where the CPU's PC got stuck).
  timer0VectorOverride?: { ovfInterrupt: number; compAInterrupt: number; compBInterrupt: number };
  timer1VectorOverride?: { captureInterrupt: number; compAInterrupt: number; compBInterrupt: number; ovfInterrupt: number };
  spiVectorOverride?: number;
  twiVectorOverride?: number;
  adcVectorOverride?: number;
}

export const ATMEGA328P: AvrChipConfig = {
  flashWords: 0x8000, // 32KB
  ports: { B: portBConfig, C: portCConfig, D: portDConfig },
  adcPortLetter: "C",
  adcChannels: 6,
  eepromBytes: 1024,
  hasAtmegaSharedPeripherals: true,
  hasUsbPll: false,
};

export const ATMEGA2560: AvrChipConfig = {
  flashWords: 0x20000, // 256KB
  ports: {
    A: portAConfig,
    B: portBConfig,
    C: portCConfig,
    D: portDConfig,
    E: portEConfig,
    F: portFConfig,
    G: portGConfig,
    H: portHConfig,
    J: portJConfig,
    K: portKConfig,
    L: portLConfig,
  },
  adcPortLetter: "F",
  adcChannels: 8,
  eepromBytes: 4096,
  hasAtmegaSharedPeripherals: true,
  hasUsbPll: false,
};

// ATtiny85 (Franzininho, boards/franzininho.ts) - genuinely the
// simplest chip here: one port (PORTB, PB0-5), no USART/SPI/TWI
// hardware, no ADC wired yet (see hasAtmegaSharedPeripherals's own
// comment above for why those are skipped rather than faked). Digital
// I/O (pinMode/digitalRead/digitalWrite) is fully, correctly modeled;
// PWM/analogRead/Serial are a real, documented gap, not silently
// wrong - see ARCHITECTURE.md.
export const ATTINY85: AvrChipConfig = {
  flashWords: 0x1000, // 8KB
  ports: { B: attinyPortBConfig },
  adcPortLetter: "B",
  adcChannels: 0,
  eepromBytes: 512,
  hasAtmegaSharedPeripherals: false,
  hasUsbPll: false,
};

// ATmega32u4 (Arduino Leonardo, boards/arduino-leonardo.ts) - ports B/C/
// D/E/F, and every peripheral register address below (Timer0/1, SPI,
// TWI, ADC) sit at the exact same addresses as the other ATmega chips
// above (confirmed against the real datasheet/avr-libc <avr/iom32u4.h>).
// What's genuinely different: no Timer2 (hasTimer2: false), no USART0
// (hasUsart0: false - only USART1 exists), and every remaining shared
// peripheral's INTERRUPT VECTOR position (not register address) - see
// timer0VectorOverride's own doc comment above for the full story of
// the boot-hang bug this fixes (a misdirected Timer0 overflow interrupt
// landing on this chip's own USB_COM_vect slot instead). Values below
// are word addresses (real vector number * 2 - both atmega328p/2560 and
// atmega32u4's compiled vector tables use 4-byte JMP entries, confirmed
// directly against real compiled disassembly, not RJMP's 2-byte ones -
// vector N's own table slot sits at word address N*2), computed directly
// from <avr/iom32u4.h>'s own *_vect_num defines, not estimated:
// TIMER1_CAPT=16, TIMER1_COMPA=17, TIMER1_COMPB=18, TIMER1_OVF=20,
// TIMER0_COMPA=21, TIMER0_COMPB=22, TIMER0_OVF=23, SPI_STC=24, TWI=36,
// ADC=29 (vs. USB_GEN=10/USB_COM=11 inserted where ATmega328p/2560 have
// no vectors at all - the reason every later vector's position shifts).
//
// What's NOT modeled: the Leonardo's real `Serial` is native USB CDC
// (not a physical UART at all - a genuinely different peripheral this
// fork has no USB device controller for), and `Serial1` is a real
// hardware UART but at USART1's own addresses, not modeled either.
// Digital I/O (pinMode/digitalRead/digitalWrite, matching simulators/
// ArduinoCore-avr's own vendored variants/leonardo/pins_arduino.h) and
// analogRead are fully, correctly modeled (including reaching setup()/
// loop() at all, which needed every fix on this page - PLL, Timer2/
// USART0 exclusion, and the vector remapping); Serial and analogWrite's
// exact PWM pin behavior (OC0A/OC1A/etc default to atmega328p/2560's
// own pin wiring, not re-verified against this chip's real PWM pinout)
// are real, documented gaps.
//
// hasUsbPll: true is load-bearing, not cosmetic - ArduinoCore-avr's own
// main.cpp calls USBDevice.attach() unconditionally at boot for any
// USBCON-defined board (every Leonardo/Micro-shaped variant), and
// USBCore.cpp's attach() busy-waits on PLLCSR's PLOCK bit ("wait for
// lock pll") before returning. avr8js has no USB/PLL peripheral at all,
// so that bit would never set and every single Leonardo sketch -
// including ones that never touch Serial - would hang before setup()
// ever runs. attachPeripherals() patches this with a tiny read hook
// that always reports PLOCK set (simulating an instantly-locked PLL,
// accurate enough - no real analog PLL timing is modeled anywhere else
// in this fork either).
export const ATMEGA32U4: AvrChipConfig = {
  flashWords: 0x8000, // 32KB
  ports: { B: portBConfig, C: portCConfig, D: portDConfig, E: portEConfig, F: portFConfig },
  adcPortLetter: "F",
  adcChannels: 8,
  eepromBytes: 1024,
  hasAtmegaSharedPeripherals: true,
  hasUsbPll: true,
  hasTimer2: false,
  hasUsart0: false,
  timer0VectorOverride: { ovfInterrupt: 0x2e, compAInterrupt: 0x2a, compBInterrupt: 0x2c },
  timer1VectorOverride: { captureInterrupt: 0x20, compAInterrupt: 0x22, compBInterrupt: 0x24, ovfInterrupt: 0x28 },
  spiVectorOverride: 0x30,
  twiVectorOverride: 0x48,
  adcVectorOverride: 0x3a,
};
