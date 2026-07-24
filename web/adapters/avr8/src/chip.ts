import type { AVRPortConfig } from "avr8js";
import {
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
}

export const ATMEGA328P: AvrChipConfig = {
  flashWords: 0x8000, // 32KB
  ports: { B: portBConfig, C: portCConfig, D: portDConfig },
  adcPortLetter: "C",
  adcChannels: 6,
  eepromBytes: 1024,
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
};
