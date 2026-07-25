import { beforeEach, describe, expect, it, vi } from "vitest";
import { Avr8Adapter } from "./adapter.js";
import { ATMEGA2560, ATMEGA32U4, ATTINY85 } from "./chip.js";

// AVRIOPort internals accessed directly to drive the CPU's write hooks the
// same way real AVR instructions (e.g. SBI DDRB,5 / OUT PORTB,r) would -
// exercising the exact path attachPeripherals() wires onPinChange through,
// without needing to hand-assemble a firmware image.
function cpuOf(adapter: Avr8Adapter) {
  return (adapter as unknown as { cpu: { writeData(addr: number, value: number): void; data: Uint8Array } }).cpu;
}
function portBOf(adapter: Avr8Adapter) {
  const ports = (adapter as unknown as { ports: Map<string, { portConfig: { DDR: number; PORT: number } }> }).ports;
  return ports.get("B")!;
}

// AVRUSART's UDR register address (usart0Config.UDR from avr8js) - writing
// to it is exactly what Serial.write()/Serial.print() compile down to on
// real firmware, and AVRUSART's writeHooks[UDR] fires onByteTransmit
// unconditionally on any write regardless of UCSRB's TXEN bit (confirmed
// directly in avr8js's usart.ts - a deliberately simplified, not cycle-
// accurate, USART model), so no register setup beyond this one write is
// needed to exercise onSerialData.
const UDR_ADDRESS = 0xc6;

describe("Avr8Adapter pin I/O", () => {
  let adapter: Avr8Adapter;

  beforeEach(async () => {
    adapter = new Avr8Adapter();
    await adapter.init(undefined);
  });

  it("writePin drives an input pin's value, readable via readPin", () => {
    expect(adapter.readPin("B5")).toBe(0);
    adapter.writePin("B5", 1);
    expect(adapter.readPin("B5")).toBe(1);
    adapter.writePin("B5", 0);
    expect(adapter.readPin("B5")).toBe(0);
  });

  it("onPinChange fires when writePin changes a pin's value, not when it doesn't", () => {
    const cb = vi.fn();
    const unsubscribe = adapter.onPinChange("B5", cb);

    adapter.writePin("B5", 1);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(1);

    adapter.writePin("B5", 1); // no change
    expect(cb).toHaveBeenCalledTimes(1);

    unsubscribe();
    adapter.writePin("B5", 0);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("onPinChange fires when the CPU drives an output pin (simulated firmware write)", () => {
    const cb = vi.fn();
    adapter.onPinChange("B5", cb);

    const cpu = cpuOf(adapter);
    const { DDR, PORT } = portBOf(adapter).portConfig;
    cpu.writeData(DDR, 0b0010_0000); // set B5 as output
    cpu.writeData(PORT, 0b0010_0000); // drive B5 high

    expect(cb).toHaveBeenCalledWith(1);
    expect(adapter.readPin("B5")).toBe(1);

    cpu.writeData(PORT, 0b0000_0000); // drive B5 low
    expect(cb).toHaveBeenLastCalledWith(0);
  });

  it("resolvePin rejects unknown ports and out-of-range bits", () => {
    expect(() => adapter.readPin("Z0")).toThrow();
    expect(() => adapter.readPin("B8")).toThrow();
  });
});

// avr8js's adcConfig register addresses (already SRAM-mapped, same as
// portBOf()'s DDR/PORT above - no raw I/O offset translation needed).
const ADMUX_ADDRESS = 0x7c;
const ADCSRA_ADDRESS = 0x7a;
const ADCL_ADDRESS = 0x78;
const ADCH_ADDRESS = 0x79;
const ADMUX_REFS_AVCC = 0x40; // REFS1:0 = 01 -> AVCC as reference (avr8js's ADCReference.AVCC)
const ADCSRA_ADEN_ADSC = 0xc0; // ADEN | ADSC - enable and start a conversion in one write

describe("Avr8Adapter analog input", () => {
  let adapter: Avr8Adapter;

  beforeEach(async () => {
    adapter = new Avr8Adapter();
    await adapter.init(undefined);
  });

  function readAdcChannel0(): number {
    const cpu = cpuOf(adapter);
    cpu.writeData(ADMUX_ADDRESS, ADMUX_REFS_AVCC); // channel 0 (low 5 bits already 0), AVCC reference
    cpu.writeData(ADCSRA_ADDRESS, ADCSRA_ADEN_ADSC);
    adapter.step(500); // plenty past sampleCycles (~50 at default prescaler) to let the conversion complete
    return cpu.data[ADCL_ADDRESS] | (cpu.data[ADCH_ADDRESS] << 8);
  }

  it("writeAnalogPin on an A0-A5 pin feeds the matching ADC channel", () => {
    adapter.writeAnalogPin("C0", 5); // A0, full-scale against the 5V AVCC reference
    expect(readAdcChannel0()).toBe(1023);

    adapter.writeAnalogPin("C0", 0);
    expect(readAdcChannel0()).toBe(0);

    adapter.writeAnalogPin("C0", 2.5); // mid-rail
    expect(readAdcChannel0()).toBeCloseTo(511, -1);
  });

  it("clamps out-of-range voltages to 0..5", () => {
    adapter.writeAnalogPin("C0", 10);
    expect(readAdcChannel0()).toBe(1023);

    adapter.writeAnalogPin("C0", -1);
    expect(readAdcChannel0()).toBe(0);
  });

  it("rejects a non-ADC-capable pin", () => {
    expect(() => adapter.writeAnalogPin("B5", 3)).toThrow(/ADC-capable/);
  });
});

// twiConfig's register addresses (avr8js) - already SRAM-mapped, same as
// the ADC/GPIO addresses above.
const TWCR_ADDRESS = 0xbc;
const TWDR_ADDRESS = 0xbb;
const TWSR_ADDRESS = 0xb9;
const TWCR_START = 0xa4; // TWSTA | TWINT | TWEN
const TWCR_GO = 0x84; // TWINT | TWEN - clears TWINT, lets the bus continue
const TWCR_GO_ACK = 0xc4; // TWEA | TWINT | TWEN - continue, ack the next received byte
const DS1307_WRITE = 0x68 << 1; // SLA+W
const DS1307_READ = (0x68 << 1) | 1; // SLA+R

describe("Avr8Adapter I2C (DS1307 RTC)", () => {
  let adapter: Avr8Adapter;

  beforeEach(async () => {
    adapter = new Avr8Adapter();
    await adapter.init(undefined);
  });

  // Drives the exact register sequence the Arduino Wire library's own
  // TWI driver produces for `Wire.beginTransmission(0x68); Wire.write(reg);
  // Wire.endTransmission(false); Wire.requestFrom(0x68, 1);` - START,
  // SLA+W, register pointer byte, repeated START, SLA+R, one data byte -
  // confirmed against avr8js's own twi.ts state machine (status codes in
  // its STATUS_* constants) rather than general I2C folklore, the same
  // rigor hd44780-decoder.test.ts holds its own protocol replay to.
  function readRegister(reg: number): number {
    const cpu = cpuOf(adapter);

    cpu.writeData(TWCR_ADDRESS, TWCR_START);
    adapter.step(20);
    cpu.writeData(TWDR_ADDRESS, DS1307_WRITE);
    cpu.writeData(TWCR_ADDRESS, TWCR_GO);
    adapter.step(20);
    cpu.writeData(TWDR_ADDRESS, reg);
    cpu.writeData(TWCR_ADDRESS, TWCR_GO);
    adapter.step(20);

    cpu.writeData(TWCR_ADDRESS, TWCR_START); // repeated start
    adapter.step(20);
    cpu.writeData(TWDR_ADDRESS, DS1307_READ);
    cpu.writeData(TWCR_ADDRESS, TWCR_GO);
    adapter.step(20);
    cpu.writeData(TWCR_ADDRESS, TWCR_GO_ACK);
    adapter.step(20);

    return cpu.data[TWDR_ADDRESS];
  }

  it("acks the DS1307's real address (0x68) and reports the bus idle beforehand", () => {
    const cpu = cpuOf(adapter);
    expect(cpu.data[TWSR_ADDRESS] & 0xf8).toBe(0xf8); // STATUS_TWI_IDLE
  });

  it("register 0 (seconds) reads back a valid BCD seconds value", () => {
    const value = readRegister(0);
    const high = value >> 4;
    const low = value & 0xf;
    expect(high).toBeLessThanOrEqual(5); // BCD tens-of-seconds digit: 0-5
    expect(low).toBeLessThanOrEqual(9);
    expect(high * 10 + low).toBeLessThanOrEqual(59);
  });

  it("NVRAM (register 0x08+) round-trips a written byte", () => {
    const cpu = cpuOf(adapter);

    // Write 0x42 to NVRAM register 0x08.
    cpu.writeData(TWCR_ADDRESS, TWCR_START);
    adapter.step(20);
    cpu.writeData(TWDR_ADDRESS, DS1307_WRITE);
    cpu.writeData(TWCR_ADDRESS, TWCR_GO);
    adapter.step(20);
    cpu.writeData(TWDR_ADDRESS, 0x08);
    cpu.writeData(TWCR_ADDRESS, TWCR_GO);
    adapter.step(20);
    cpu.writeData(TWDR_ADDRESS, 0x42);
    cpu.writeData(TWCR_ADDRESS, TWCR_GO);
    adapter.step(20);
    cpu.writeData(TWCR_ADDRESS, 0x94); // TWSTO | TWINT | TWEN - stop
    adapter.step(20);

    expect(readRegister(0x08)).toBe(0x42);
  });

  it("NACKs an address that isn't the DS1307's", () => {
    const cpu = cpuOf(adapter);
    cpu.writeData(TWCR_ADDRESS, TWCR_START);
    adapter.step(20);
    cpu.writeData(TWDR_ADDRESS, 0x50 << 1); // some other device's address
    cpu.writeData(TWCR_ADDRESS, TWCR_GO);
    adapter.step(20);
    expect(cpu.data[TWSR_ADDRESS] & 0xf8).toBe(0x20); // STATUS_SLAW_NACK
  });
});

describe("Avr8Adapter serial output", () => {
  let adapter: Avr8Adapter;

  beforeEach(async () => {
    adapter = new Avr8Adapter();
    await adapter.init(undefined);
  });

  it("onSerialData fires with each byte the firmware writes to UDR", () => {
    const cb = vi.fn();
    adapter.onSerialData(cb);

    const cpu = cpuOf(adapter);
    cpu.writeData(UDR_ADDRESS, "A".charCodeAt(0));
    cpu.writeData(UDR_ADDRESS, "B".charCodeAt(0));

    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenNthCalledWith(1, "A".charCodeAt(0));
    expect(cb).toHaveBeenNthCalledWith(2, "B".charCodeAt(0));
  });

  it("unsubscribing onSerialData stops further callbacks", () => {
    const cb = vi.fn();
    const unsubscribe = adapter.onSerialData(cb);

    const cpu = cpuOf(adapter);
    cpu.writeData(UDR_ADDRESS, 1);
    unsubscribe();
    cpu.writeData(UDR_ADDRESS, 2);

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(1);
  });

  it("keeps forwarding serial output to the same subscriber across reset()", () => {
    const cb = vi.fn();
    adapter.onSerialData(cb);

    adapter.reset();
    const cpu = cpuOf(adapter); // a fresh CPU instance after reset()
    cpu.writeData(UDR_ADDRESS, 42);

    expect(cb).toHaveBeenCalledWith(42);
  });
});

// eepromConfig's register addresses (avr8js) - already SRAM-mapped.
const EECR_ADDRESS = 0x3f;
const EEDR_ADDRESS = 0x40;
const EEARL_ADDRESS = 0x41;
const EEARH_ADDRESS = 0x42;
const EECR_EEMPE_EEPE = 0x06; // EEMPE | EEPE - arm and immediately commit an erase+write
const EECR_EERE = 0x01; // EERE - synchronous read

describe("Avr8Adapter EEPROM", () => {
  let adapter: Avr8Adapter;

  beforeEach(async () => {
    adapter = new Avr8Adapter();
    await adapter.init(undefined);
  });

  // Drives the exact register sequence avr-libc's eeprom_write_byte()/
  // eeprom_read_byte() compile down to (EEAR then EEDR then EECR) -
  // confirmed against avr8js's own eeprom.ts write hook, which performs
  // the erase+write (or the read) synchronously within that one EECR
  // write, not behind the write-complete timer it also schedules (that
  // timer only gates a *second* write attempt / the ready interrupt, not
  // the actual memory mutation - see eeprom.ts's own writeCompleteCycles
  // handling), so no cycle-stepping is needed to observe the result.
  function writeByte(addr: number, value: number): void {
    const cpu = cpuOf(adapter);
    cpu.writeData(EEARL_ADDRESS, addr & 0xff);
    cpu.writeData(EEARH_ADDRESS, (addr >> 8) & 0xff);
    cpu.writeData(EEDR_ADDRESS, value);
    cpu.writeData(EECR_ADDRESS, EECR_EEMPE_EEPE);
  }

  function readByte(addr: number): number {
    const cpu = cpuOf(adapter);
    cpu.writeData(EEARL_ADDRESS, addr & 0xff);
    cpu.writeData(EEARH_ADDRESS, (addr >> 8) & 0xff);
    cpu.writeData(EECR_ADDRESS, EECR_EERE);
    return cpu.data[EEDR_ADDRESS];
  }

  it("starts erased (0xff), matching a fresh chip's real reset state", () => {
    expect(readByte(0)).toBe(0xff);
    expect(readByte(1023)).toBe(0xff); // last byte of the atmega328p's 1KB EEPROM
  });

  it("round-trips a written byte", () => {
    writeByte(5, 0x42);
    expect(readByte(5)).toBe(0x42);
    expect(readByte(4)).toBe(0xff); // neighboring byte untouched
  });

  it("survives reset() - EEPROM is battery-backed, not wiped by a power cycle", () => {
    writeByte(10, 0x99);
    adapter.reset();
    expect(readByte(10)).toBe(0x99);
  });

  it("survives loadFirmware() - the same physical chip, new sketch", () => {
    writeByte(20, 0x7a);
    adapter.loadFirmware(new Uint8Array([0xff, 0xff]));
    expect(readByte(20)).toBe(0x7a);
  });
});

describe("Avr8Adapter chip variants", () => {
  it("defaults to the atmega328p's 3-port, 32KB-flash shape", async () => {
    const adapter = new Avr8Adapter();
    await adapter.init(undefined);
    const ports = (adapter as unknown as { ports: Map<string, unknown> }).ports;
    expect([...ports.keys()].sort()).toEqual(["B", "C", "D"]);
    expect((adapter as unknown as { program: Uint16Array }).program.length).toBe(0x8000);
  });

  it("ATMEGA2560 gives the adapter all 11 Mega ports and 256KB of flash", async () => {
    const adapter = new Avr8Adapter(ATMEGA2560);
    await adapter.init(undefined);
    const ports = (adapter as unknown as { ports: Map<string, unknown> }).ports;
    expect([...ports.keys()].sort()).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "J", "K", "L"]);
    expect((adapter as unknown as { program: Uint16Array }).program.length).toBe(0x20000);

    // A digital pin genuinely off the atmega328p's port set (e.g. "A0" -
    // PORTA doesn't exist on an Uno at all) now resolves and round-trips.
    expect(adapter.readPin("A0")).toBe(0);
    adapter.writePin("A0", 1);
    expect(adapter.readPin("A0")).toBe(1);

    // A0 (the Arduino silkscreen analog pin, PORTF bit 0 on a Mega - see
    // boards/arduino-mega.ts) is ADC-capable; PORTA isn't part of the
    // ADC at all on this chip.
    adapter.writeAnalogPin("F0", 3);
    expect(() => adapter.writeAnalogPin("A0", 3)).toThrow(/ADC-capable/);
  });

  // Regression test for a real bug this config would otherwise hit
  // silently: ATmega's timer1Config/timer2Config TIFR registers sit at
  // 0x36/0x37 - the exact same addresses as ATtiny85's real PINB/DDRB
  // (attinyPortBConfig, avr8js's gpio.ts) - so constructing those
  // phantom timers (as chip.ts's hasAtmegaSharedPeripherals guards
  // against) would silently corrupt digital I/O on this chip. This test
  // doesn't need a compiled sketch to catch a regression here: plain
  // writePin()/readPin() through the CPU's real memory hooks is enough
  // to prove PB0's actual register addresses work.
  it("ATTINY85 gives the adapter its one port (B) and 8KB of flash, with no address collision from phantom ATmega timers", async () => {
    const adapter = new Avr8Adapter(ATTINY85);
    await adapter.init(undefined);
    const ports = (adapter as unknown as { ports: Map<string, unknown> }).ports;
    expect([...ports.keys()]).toEqual(["B"]);
    expect((adapter as unknown as { program: Uint16Array }).program.length).toBe(0x1000);

    expect(adapter.readPin("B0")).toBe(0);
    adapter.writePin("B0", 1);
    expect(adapter.readPin("B0")).toBe(1);
    adapter.writePin("B0", 0);
    expect(adapter.readPin("B0")).toBe(0);

    // ATtiny85 has no ADC wired up yet (chip.ts's ATTINY85.adcChannels
    // is 0) - a documented gap, not a silent one.
    expect(() => adapter.writeAnalogPin("B2", 3)).toThrow(/ADC-capable/);
  });

  // Regression test for a real, would-otherwise-hang-forever bug:
  // ArduinoCore-avr's own USBCore.cpp busy-waits on PLLCSR's PLOCK bit
  // during boot (USBDevice.attach(), called unconditionally by main.cpp
  // for any USBCON board) - avr8js has no USB/PLL peripheral, so without
  // chip.ts's hasUsbPll fix that bit would never set and every Leonardo
  // sketch would hang before setup() ever ran. This test reproduces the
  // exact busy-wait condition directly against CPU memory (no compiled
  // sketch needed): write PLLCSR with PLOCK clear, confirm a plain read
  // still reports it set.
  it("ATMEGA32U4 gives the adapter ports B/C/D/E/F and patches PLLCSR's PLOCK bit so USBDevice.attach()'s boot-time busy-wait doesn't hang forever", async () => {
    const adapter = new Avr8Adapter(ATMEGA32U4);
    await adapter.init(undefined);
    const ports = (adapter as unknown as { ports: Map<string, unknown> }).ports;
    expect([...ports.keys()].sort()).toEqual(["B", "C", "D", "E", "F"]);
    expect((adapter as unknown as { program: Uint16Array }).program.length).toBe(0x8000);

    expect(adapter.readPin("B4")).toBe(0);
    adapter.writePin("B4", 1);
    expect(adapter.readPin("B4")).toBe(1);

    const PLLCSR_ADDR = 0x49;
    const PLOCK_BIT = 1 << 0;
    const cpu = (adapter as unknown as { cpu: { writeData(addr: number, value: number): void; readHooks: ((addr: number) => number)[] } }).cpu;
    cpu.writeData(PLLCSR_ADDR, 0); // PLOCK explicitly clear - what real boot code writes before waiting on it
    expect(cpu.readHooks[PLLCSR_ADDR](PLLCSR_ADDR) & PLOCK_BIT).toBe(PLOCK_BIT);
  });

  // Regression test for a second, much harder-to-spot boot-hang bug:
  // ATmega32u4's real compiled interrupt vector table has a completely
  // different layout than ATmega328p/2560's (two USB vectors inserted
  // at positions 10-11 shift every later peripheral's vector number) -
  // timer0Config/timer1Config/spiConfig/twiConfig/adcConfig's own
  // `*Interrupt` fields are hardcoded for the 328p/2560 layout, so
  // without chip.ts's vectorOverride fields, ATmega32u4's Timer0
  // overflow interrupt (needed for millis()/delay()) fires at the WRONG
  // address - landing wherever THIS chip's real vector table happens to
  // put a different, unrelated vector (confirmed by hand: it landed
  // inside the compiled program's own USB_COM_vect handler, which then
  // hung forever polling a USB status register no real host would ever
  // set - a boot-time hang with no compiler error, and a completely
  // unrelated-looking symptom). ATmega32u4 also has no Timer2 or USART0
  // at all (hasTimer2/hasUsart0: false) - constructing them would be a
  // second, independent way to misdirect interrupts the same way.
  it("ATMEGA32U4 has no Timer2/USART0, and Timer0/1/SPI/TWI/ADC use this chip's own (not atmega328p's) interrupt vector addresses", async () => {
    const adapter = new Avr8Adapter(ATMEGA32U4);
    await adapter.init(undefined);
    const internals = adapter as unknown as {
      timer0?: { config: { ovfInterrupt: number; compAInterrupt: number; compBInterrupt: number } };
      timer1?: { config: { captureInterrupt: number; compAInterrupt: number; compBInterrupt: number; ovfInterrupt: number } };
      timer2?: unknown;
      usart?: unknown;
      spi?: { config: { spiInterrupt: number } };
      twi?: { config: { twiInterrupt: number } };
      adc?: { config: { adcInterrupt: number } };
    };

    expect(internals.timer2).toBeUndefined();
    expect(internals.usart).toBeUndefined();

    // Word addresses = real vector number * 2 (avr/iom32u4.h's own
    // *_vect_num defines: TIMER0_COMPA=21, TIMER0_COMPB=22,
    // TIMER0_OVF=23, TIMER1_CAPT=16, TIMER1_COMPA=17, TIMER1_COMPB=18,
    // TIMER1_OVF=20, SPI_STC=24, TWI=36, ADC=29) - genuinely different
    // from atmega328p/2560's own shared timer0Config/timer1Config/
    // spiConfig/twiConfig/adcConfig values, not a coincidental match.
    expect(internals.timer0?.config.compAInterrupt).toBe(0x2a);
    expect(internals.timer0?.config.compBInterrupt).toBe(0x2c);
    expect(internals.timer0?.config.ovfInterrupt).toBe(0x2e);
    expect(internals.timer1?.config.captureInterrupt).toBe(0x20);
    expect(internals.timer1?.config.compAInterrupt).toBe(0x22);
    expect(internals.timer1?.config.compBInterrupt).toBe(0x24);
    expect(internals.timer1?.config.ovfInterrupt).toBe(0x28);
    expect(internals.spi?.config.spiInterrupt).toBe(0x30);
    expect(internals.twi?.config.twiInterrupt).toBe(0x48);
    expect(internals.adc?.config.adcInterrupt).toBe(0x3a);
  });
});

describe("Avr8Adapter firmware loading", () => {
  let adapter: Avr8Adapter;

  beforeEach(async () => {
    adapter = new Avr8Adapter();
    await adapter.init(undefined);
  });

  // LDI r16, 0x42 - opcode "1110 KKKK dddd KKKK" (confirmed directly
  // against avr8js's own instruction.ts): K=0x42 splits into KKKK=0100 and
  // KKKK=0010, d=0 (register 16 + 0), giving 0xE402 - stored little-endian
  // (low byte first) since AVR flash words are little-endian.
  const LDI_R16_0x42 = new Uint8Array([0x02, 0xe4]);

  it("writes bytes into flash such that the CPU actually executes them", () => {
    adapter.loadFirmware(LDI_R16_0x42);
    adapter.step(1);
    expect(cpuOf(adapter).data[16]).toBe(0x42);
  });

  it("resets cycles/pc back to power-on defaults when loading", () => {
    adapter.loadFirmware(LDI_R16_0x42);
    adapter.step(1);
    expect(cpuOf(adapter).data[16]).toBe(0x42); // confirms the first load actually ran

    adapter.loadFirmware(LDI_R16_0x42);
    const cpu = cpuOf(adapter) as unknown as { pc: number; cycles: number };
    expect(cpu.pc).toBe(0);
    expect(cpu.cycles).toBe(0);
  });

  it("clears any previous firmware's leftover instructions past the new program's end", () => {
    // First load: two instructions worth of flash - the second one
    // matters only in that it must NOT still be there after the load
    // below overwrites it with something shorter.
    adapter.loadFirmware(new Uint8Array([0x02, 0xe4, 0x02, 0xe4]));
    // Second load: just one instruction, one word shorter than the first.
    adapter.loadFirmware(LDI_R16_0x42);

    const program = (adapter as unknown as { program: Uint16Array }).program;
    expect(program[0]).toBe(0xe402);
    expect(program[1]).toBe(0xffff); // erased, not the first load's stale second instruction
  });

  it("rejects firmware larger than the flash", () => {
    const tooBig = new Uint8Array((adapter as unknown as { program: Uint16Array }).program.length * 2 + 2);
    expect(() => adapter.loadFirmware(tooBig)).toThrow(/too large/);
  });
});
