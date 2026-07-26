# Components

Everything placeable on the canvas (tab 1's right-click menu) comes from
the vendored `@wokwi/elements` fork (`simulators/wokwi-elements`, MIT) -
see [ARCHITECTURE.md](ARCHITECTURE.md)'s "Vendoring @wokwi/elements"
section for how it's built into the app. This file is the registry: what's
wired up today, and how to add more.

## Boards

Backed by a `SimulatorAdapter` (CPU emulation - see
[ARCHITECTURE.md](ARCHITECTURE.md)) and powered by Start/Pause/Stop.
Registered in `web/shell/src/circuit.ts`.

| Board | Custom element | Adapter |
|---|---|---|
| Arduino Uno | `wokwi-arduino-uno` | `avr8` |
| Arduino Nano | `wokwi-arduino-nano` | `avr8` |
| Arduino Mega | `wokwi-arduino-mega` | `avr8-mega` |
| Franzininho | `wokwi-franzininho` | `avr8-attiny85` |
| Arduino Leonardo | `wokwi-arduino-leonardo` | `avr8-leonardo` |
| Arduino Nano RP2040 Connect | `wokwi-nano-rp2040-connect` | `rp2040` |
| Raspberry Pi Pico | `wokwi-pi-pico` | `rp2040` |
| Raspberry Pi Pico W | `wokwi-pi-pico-w` | `rp2040` |
| ESP32 DevKit V1 | `wokwi-esp32-devkit-v1` | `esp32` |
| ESP32 DevKit C V4 | `wokwi-esp32-devkit-c-v4` | `esp32` |
| ESP32-CAM | `wokwi-esp32-cam` | `esp32` |

Nano and Uno share `avr8` (same ATmega328p chip, see `web/adapters/avr8/
src/chip.ts`); Mega gets its own `avr8-mega` adapter id since it's a
genuinely different chip (ATmega2560). Franzininho gets its own
`avr8-attiny85` adapter id for the same reason, a step further - a
genuinely different, much smaller chip (ATtiny85: one port, no USART/
SPI/TWI hardware at all) compiled against its own core tree
(`simulators/ATTinyCore`, not `ArduinoCore-avr` - see `src/
avr_toolchain.cpp`'s `resolve_board_target()`). Arduino Leonardo gets its
own `avr8-leonardo` adapter id too (ATmega32u4 - reuses ArduinoCore-avr's
own `leonardo` variant, unlike Franzininho). All three RP2040-family
boards share the single `rp2040` adapter the same way Uno/Nano do -
they're all the same chip. `wokwi-pi-pico`/`wokwi-pi-pico-w` are vendored
from `wokwi/wokwi-boards`' own official board art (Uri Shaked / Ariella
Eliassaf), not drawn from scratch - see [ARCHITECTURE.md](ARCHITECTURE.md)'s
"RP2040 firmware pipeline" section for the sketch-compiling story these
boards actually run. Pico W's WiFi/Bluetooth chip (CYW43439) isn't
emulated - it places and compiles identically to the plain Pico, per an
explicit user decision (2026-07-25).

ESP32 DevKit C V4 and ESP32-CAM are the same ESP32-WROOM-32 chip as DevKit
V1, just different board artwork/pinouts - vendored from `wokwi/wokwi-
boards` (Marc Endtricht / Ariella Eliassaf) the same way `wokwi-pi-pico-w`
is, not hand-drawn like `wokwi-esp32-devkit-v1`. Both share the `esp32`
adapter and toolchain unchanged. ESP32-CAM's OV2640 camera and onboard
microSD slot are physically present but not emulated - same "present, not
modeled" posture as Pico W's WiFi chip; GPIO/LED pins work normally.

ESP32 DevKit V1 is backed by its own `esp32` adapter id - not a JS/Worker
adapter like the others, but a real `qemu-system-xtensa` process
(`vecnode/qemu-esp32`, see `src/esp32_qemu_adapter.{hpp,cpp}` and the
`esp32-phase1-adapter`/`esp32-qemu-gpio-spike` notes for why this specific
QEMU fork, not the official `espressif/qemu`, was needed - it's the only
one with working GPIO matrix/IOMUX emulation). `readPin` is real, live
GPIO state read straight out of the emulator; `writePin` (e.g. a simulated
button) isn't supported yet (needs a small patch to the fork exposing its
internal `set_gpio()` externally). Compile & Run works too
(`src/esp32_toolchain.cpp`) - a real ESP-IDF build (its own multi-component
CMake project: bootloader, partition table, app, merged via esptool),
genuinely heavier than avr-gcc's flat per-file compile or pico-sdk's
cmake-driven one, invoked directly via cmake/ninja rather than the `idf.py`
wrapper. **Toolchain discovery is dev-machine-only today** - fixed paths
under `C:\esp-idf` and `%USERPROFILE%\.espressif` (see
`esp32_toolchain.hpp`), not bundled/portable like avr-gcc/arm-none-eabi-gcc
are - `toolchain_available()` is checked first so a machine without it
gets a clear error, not a confusing failure partway through.

## Sensors

Placed via the canvas's right-click "Sensors" submenu. No power/adapter
state - purely placed and wireable (see [ARCHITECTURE.md](ARCHITECTURE.md)'s
"pin-to-pin connections" section). Registered in
`web/shell/src/component-registry.ts`.

| Component | Custom element |
|---|---|
| DHT22 (Temp/Humidity) | `wokwi-dht22` |
| HC-SR04 (Ultrasonic) | `wokwi-hc-sr04` |
| Flame Sensor | `wokwi-flame-sensor` |
| Gas Sensor | `wokwi-gas-sensor` |
| Heart Beat Sensor | `wokwi-heart-beat-sensor` |
| IR Receiver | `wokwi-ir-receiver` |
| MPU6050 (Accel/Gyro) | `wokwi-mpu6050` |
| NTC Temperature Sensor | `wokwi-ntc-temperature-sensor` |
| Photoresistor | `wokwi-photoresistor-sensor` |
| PIR Motion Sensor | `wokwi-pir-motion-sensor` |
| Small Sound Sensor | `wokwi-small-sound-sensor` |
| Big Sound Sensor | `wokwi-big-sound-sensor` |
| Tilt Switch | `wokwi-tilt-switch` |

## Connections

Everything else: displays, actuators, passives, inputs, and small
peripheral modules - placed via the right-click "Connections" submenu.
Same registry file as Sensors above; "Connections" is this project's own
umbrella category, not a `@wokwi/elements` concept.

| Component | Custom element |
|---|---|
| LED | `wokwi-led` |
| RGB LED | `wokwi-rgb-led` |
| LED Ring | `wokwi-led-ring` |
| LED Bar Graph | `wokwi-led-bar-graph` |
| NeoPixel | `wokwi-neopixel` |
| NeoPixel Matrix | `wokwi-neopixel-matrix` |
| 7-Segment Display | `wokwi-7segment` |
| LCD1602 | `wokwi-lcd1602` |
| LCD2004 | `wokwi-lcd2004` |
| SSD1306 (OLED) | `wokwi-ssd1306` |
| ILI9341 (TFT) | `wokwi-ili9341` |
| Buzzer | `wokwi-buzzer` |
| Servo Motor | `wokwi-servo` |
| Stepper Motor | `wokwi-stepper-motor` |
| Biaxial Stepper | `wokwi-biaxial-stepper` |
| Resistor | `wokwi-resistor` |
| Capacitor | `wokwi-capacitor` |
| Potentiometer | `wokwi-potentiometer` |
| Slide Potentiometer | `wokwi-slide-potentiometer` |
| Pushbutton | `wokwi-pushbutton` |
| Pushbutton (6mm) | `wokwi-pushbutton-6mm` |
| Slide Switch | `wokwi-slide-switch` |
| DIP Switch (8-way) | `wokwi-dip-switch-8` |
| Membrane Keypad | `wokwi-membrane-keypad` |
| Rotary Dialer | `wokwi-rotary-dialer` |
| Relay (KS2E-M-DC5) | `wokwi-ks2e-m-dc5` |
| DS1307 (RTC) | `wokwi-ds1307` |
| MicroSD Card | `wokwi-microsd-card` |
| Analog Joystick | `wokwi-analog-joystick` |
| Rotary Encoder (KY-040) | `wokwi-ky-040` |
| IR Remote | `wokwi-ir-remote` |

Capacitor is the one entry above not vendored from upstream `wokwi/wokwi-
elements` at all - neither that project nor this fork ships one (confirmed
by checking the fork's own file list), so `simulators/wokwi-elements/src/
capacitor-element.ts` is a small, original element authored directly in
the fork, following the "Adding a new sensor or connection" workflow
below. Its `value` property (a plain number or SI-suffixed string like
"100n"/"10u") is read by `componentElectricalParams` (`web/common/src/
circuit/component-electrical-params.ts`) for the analog netlist/solver -
see ARCHITECTURE.md's "Signal chain" notes.

## Adding a new sensor or connection

The custom element itself is already available - `main.ts`'s
`import "@wokwi/elements"` registers every element the vendored fork
exports (`simulators/wokwi-elements/src/index.ts`), not just the ones
listed above. Adding one to the menu is a single entry in
`web/shell/src/component-registry.ts`'s `componentRegistry`:

```ts
"my-new-part": {
  tagName: "wokwi-my-new-part",
  displayName: "My New Part",
  category: "sensors", // or "connections"
},
```

That's it - no other file needs to change. The right-click menu
(`web/shell/src/canvas/context-menu.ts`), placement, dragging, and pin
markers (`web/shell/src/canvas/scene.ts`) all read from this one
registry, so a new entry here is automatically placeable, draggable,
wireable, and deletable like every other component. If the part isn't in
the vendored fork yet at all, add it under
`simulators/wokwi-elements/src/` first (see that submodule's own
`CONTRIBUTING.md`) - it needs a `pinInfo: ElementPin[]` property for its
pins to show up as clickable/wireable markers, but works without one too
(just with no pins to connect).

## Adding a new board

A board additionally needs a `SimulatorAdapter` to actually run - not
just an element to look at. Three registries in
`web/shell/src/circuit.ts`, keyed by the same board-type string:

- `boardTagName` - the custom element tag (as above).
- `boardDisplayName` - the label shown in the right-click "Boards" menu.
- `boardAdapterId` - which `SimulatorAdapter` (`web/common/src/
  adapter-types.ts`) backs it. `avr8` and `rp2040` already exist
  (`web/adapters/{avr8,rp2040}`); a genuinely new architecture needs a
  new adapter package first (see [ARCHITECTURE.md](ARCHITECTURE.md)'s
  "Two adapter kinds" section for what that involves).
- `boardPowerSetter` - how Start/Stop reflects onto the element (Arduino
  Uno's power LED, for instance) - board-specific since not every board
  exposes the same property.

Also worth adding, if the board should support pin read/write (not just
placement): a pin-name map in `web/common/src/boards/` (see
`arduino-uno.ts`), mapping the board's silkscreen names to the backing
adapter's raw pin ids - and a `PowerProfile` entry in
`web/shell/src/energy.ts`'s `boardPowerProfile` so the voltage/current
readout means something for the new board type instead of reading zero.
