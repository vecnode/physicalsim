# Components

Everything placeable on the canvas (tab 1's right-click menu) comes from
the vendored `@wokwi/elements` fork (`simulators/iot-elements`, MIT) -
see [ARCHITECTURE.md](ARCHITECTURE.md)'s "Vendoring @wokwi/elements"
section for how it's built into the app. This file is the registry: what's
wired up today, and how to add more. Preview images are the element's own
real rendered SVG (extracted live from the running app, not hand-drawn),
each shown at its own smaller side's size so proportions stay honest.

## Boards

Backed by a `SimulatorAdapter` (CPU emulation - see
[ARCHITECTURE.md](ARCHITECTURE.md)) and powered by Start/Pause/Stop.
Registered in `web/shell/src/circuit.ts`. Every board runs a JS-native
sketch runtime now (no C/C++ toolchain, no vendored Arduino/pico-sdk/
ESP-IDF core).

| Board | Custom element | Adapter | Fork | Preview |
|---|---|---|---|---|
| Arduino Uno | `iot-arduino-uno` | `avr8-js` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-arduino-uno.svg" height="53"> |
| Arduino Nano | `iot-arduino-nano` | `avr8-js` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-arduino-nano.svg" height="17"> |
| Arduino Mega | `iot-arduino-mega` | `avr8-js-mega` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-arduino-mega.svg" height="50"> |
| Franzininho | `iot-franzininho` | `avr8-js-attiny85` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-franzininho.svg" height="30"> |
| Arduino Leonardo | `iot-arduino-leonardo` | `avr8-js` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-arduino-leonardo.svg" height="51"> |
| Arduino Nano RP2040 Connect | `iot-nano-rp2040-connect` | `rp2040-js` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-nano-rp2040-connect.svg" height="17"> |
| Raspberry Pi Pico | `iot-pi-pico` | `rp2040-js` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-pi-pico.svg" height="20"> |
| Raspberry Pi Pico W | `iot-pi-pico-w` | `rp2040-js` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-pi-pico-w.svg" height="20"> |
| ESP32 DevKit V1 | `iot-esp32-devkit-v1` | `esp32-js` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-esp32-devkit-v1.svg" height="28"> |
| ESP32 DevKit C V4 | `iot-esp32-devkit-c-v4` | `esp32-js` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-esp32-devkit-c-v4.svg" height="27"> |
| ESP32-CAM | `iot-esp32-cam` | `esp32-js` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-esp32-cam.svg" height="27"> |


## Components

Placed via the canvas's right-click. No power/adapter
state - purely placed and wireable (see [ARCHITECTURE.md](ARCHITECTURE.md)'s
"pin-to-pin connections" section). Registered in
`web/shell/src/component-registry.ts`.

| Component | Custom element | Fork | Preview |
|---|---|---|---|
| DHT22 (Temp/Humidity) | `iot-dht22` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-dht22.svg" height="16"> |
| HC-SR04 (Ultrasonic) | `iot-hc-sr04` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-hc-sr04.svg" height="25"> |
| Flame Sensor | `iot-flame-sensor` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-flame-sensor.svg" height="16"> |
| Gas Sensor | `iot-gas-sensor` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-gas-sensor.svg" height="16"> |
| Heart Beat Sensor | `iot-heart-beat-sensor` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-heart-beat-sensor.svg" height="20"> |
| IR Receiver | `iot-ir-receiver` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-ir-receiver.svg" height="16"> |
| MPU6050 (Accel/Gyro) | `iot-mpu6050` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-mpu6050.svg" height="16"> |
| NTC Temperature Sensor | `iot-ntc-temperature-sensor` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-ntc-temperature-sensor.svg" height="19"> |
| Photoresistor | `iot-photoresistor-sensor` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-photoresistor-sensor.svg" height="16"> |
| PIR Motion Sensor | `iot-pir-motion-sensor` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-pir-motion-sensor.svg" height="24"> |
| Small Sound Sensor | `iot-small-sound-sensor` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-small-sound-sensor.svg" height="16"> |
| Big Sound Sensor | `iot-big-sound-sensor` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-big-sound-sensor.svg" height="16"> |
| Tilt Switch | `iot-tilt-switch` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-tilt-switch.svg" height="16"> |
| HX711 (Load Cell Amp) | `iot-hx711` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-hx711.svg" height="43"> |
| LED | `iot-led` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-led.svg" height="40"> |
| RGB LED | `iot-rgb-led` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-rgb-led.svg" height="42"> |
| LED Ring | `iot-led-ring` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-led-ring.svg" height="37"> |
| LED Bar Graph | `iot-led-bar-graph` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-led-bar-graph.svg" height="16"> |
| NeoPixel | `iot-neopixel` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-neopixel.svg" height="16"> |
| NeoPixel Matrix | `iot-neopixel-matrix` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-neopixel-matrix.svg" height="47"> |
| 7-Segment Display | `iot-7segment` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-7segment.svg" height="16"> |
| LCD1602 | `iot-lcd1602` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-lcd1602.svg" height="36"> |
| LCD2004 | `iot-lcd2004` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-lcd2004.svg" height="47"> |
| SSD1306 (OLED) | `iot-ssd1306` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-ssd1306.svg" height="96"> |
| ILI9341 (TFT) | `iot-ili9341` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-ili9341.svg" height="46"> |
| Buzzer | `iot-buzzer` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-buzzer.svg" height="16"> |
| Servo Motor | `iot-servo` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-servo.svg" height="31"> |
| Stepper Motor | `iot-stepper-motor` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-stepper-motor.svg" height="58"> |
| Biaxial Stepper | `iot-biaxial-stepper` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-biaxial-stepper.svg" height="56"> |
| Resistor | `iot-resistor` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-resistor.svg" height="16"> |
| Capacitor | `iot-capacitor` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-capacitor.svg" height="16"> |
| Potentiometer | `iot-potentiometer` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-potentiometer.svg" height="20"> |
| Slide Potentiometer | `iot-slide-potentiometer` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-slide-potentiometer.svg" height="29"> |
| Pushbutton | `iot-pushbutton` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-pushbutton.svg" height="16"> |
| Pushbutton (6mm) | `iot-pushbutton-6mm` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-pushbutton-6mm.svg" height="16"> |
| Slide Switch | `iot-slide-switch` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-slide-switch.svg" height="16"> |
| DIP Switch (8-way) | `iot-dip-switch-8` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-dip-switch-8.svg" height="55"> |
| Membrane Keypad | `iot-membrane-keypad` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-membrane-keypad.svg" height="70"> |
| Rotary Dialer | `iot-rotary-dialer` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-rotary-dialer.svg" height="96"> |
| Relay (KS2E-M-DC5) | `iot-ks2e-m-dc5` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-ks2e-m-dc5.svg" height="16"> |
| DS1307 (RTC) | `iot-ds1307` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-ds1307.svg" height="22"> |
| MicroSD Card | `iot-microsd-card` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-microsd-card.svg" height="20"> |
| Analog Joystick | `iot-analog-joystick` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-analog-joystick.svg" height="27"> |
| Rotary Encoder (KY-040) | `iot-ky-040` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-ky-040.svg" height="18"> |
| IR Remote | `iot-ir-remote` | `vecnode/iot-elements` | <img src="assets/component-previews/iot-ir-remote.svg" height="40"> |

## Originally-drawn parts

docs.wokwi.com lists more parts than Wokwi ever open-sourced - these 24
exist only in Wokwi's closed-source simulator, so there was no MIT source
to vendor. Each is an original element added directly to
`vecnode/iot-elements` (same "small, original, not copied from Wokwi"
precedent the fork's own `iot-capacitor` already set - see that
submodule's README for the full list and reasoning). Visual/wireable
only, same tier as most parts in the tables above - no board here has a
`SimulatorAdapter`, even the four that look like MCU dev boards.

| Component | Custom element | Preview |
|---|---|---|
| BMP180 (Pressure) | `iot-bmp180` | <img src="assets/component-previews/iot-bmp180.svg" height="28"> |
| DS18B20 (1-Wire Temp) | `iot-ds18b20` | <img src="assets/component-previews/iot-ds18b20.svg" height="20"> |
| MFRC522 (RFID) | `iot-mfrc522` | <img src="assets/component-previews/iot-mfrc522.svg" height="48"> |
| Logic Analyzer | `iot-logic-analyzer` | <img src="assets/component-previews/iot-logic-analyzer.svg" height="32"> |
| 74HC165 (Shift-In) | `iot-74hc165` | <img src="assets/component-previews/iot-74hc165.svg" height="27"> |
| 74HC595 (Shift-Out) | `iot-74hc595` | <img src="assets/component-previews/iot-74hc595.svg" height="27"> |
| NLSF595 (Shift-Out) | `iot-nlsf595` | <img src="assets/component-previews/iot-nlsf595.svg" height="27"> |
| ATtiny85 (bare chip) | `iot-attiny85` | <img src="assets/component-previews/iot-attiny85.svg" height="27"> |
| A4988 (Stepper Driver) | `iot-a4988` | <img src="assets/component-previews/iot-a4988.svg" height="50"> |
| Clock Generator | `iot-clock-generator` | <img src="assets/component-previews/iot-clock-generator.svg" height="28"> |
| Grove OLED (SH1107) | `iot-grove-oled-sh1107` | <img src="assets/component-previews/iot-grove-oled-sh1107.svg" height="32"> |
| LED Matrix (8x8) | `iot-led-matrix` | <img src="assets/component-previews/iot-led-matrix.svg" height="42"> |
| LED Strip | `iot-led-strip` | <img src="assets/component-previews/iot-led-strip.svg" height="32"> |
| MAX7219 Matrix | `iot-max7219-matrix` | <img src="assets/component-previews/iot-max7219-matrix.svg" height="48"> |
| Nokia 5110 Screen | `iot-nokia-5110-screen` | <img src="assets/component-previews/iot-nokia-5110-screen.svg" height="60"> |
| Relay Module | `iot-relay-module` | <img src="assets/component-previews/iot-relay-module.svg" height="40"> |
| Text Label | `iot-text` | <img src="assets/component-previews/iot-text.svg" height="16"> |
| TM1637 7-Segment | `iot-tm1637-7segment` | <img src="assets/component-previews/iot-tm1637-7segment.svg" height="32"> |
| TV (Composite) | `iot-tv` | <img src="assets/component-previews/iot-tv.svg" height="52"> |
| WiFi Access Point | `iot-wifi-ap` | <img src="assets/component-previews/iot-wifi-ap.svg" height="40"> |
| Franzininho WiFi (visual only) | `iot-franzininho-wifi` | <img src="assets/component-previews/iot-franzininho-wifi.svg" height="52"> |
| Nucleo C031C6 (visual only) | `iot-nucleo-c031c6` | <img src="assets/component-previews/iot-nucleo-c031c6.svg" height="60"> |
| Nucleo L031K6 (visual only) | `iot-nucleo-l031k6` | <img src="assets/component-previews/iot-nucleo-l031k6.svg" height="60"> |
| STM32 Blue Pill (visual only) | `iot-stm32-bluepill` | <img src="assets/component-previews/iot-stm32-bluepill.svg" height="70"> |

## Adding a new sensor or connection

The custom element itself is already available - `main.ts`'s
`import "@wokwi/elements"` registers every element the vendored fork
exports (`simulators/iot-elements/src/index.ts`), not just the ones
listed above. Adding one to the menu is a single entry in
`web/shell/src/component-registry.ts`'s `componentRegistry`:

```ts
"my-new-part": {
  tagName: "iot-my-new-part",
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
`simulators/iot-elements/src/` first (see that submodule's own
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
  adapter-types.ts`) backs it. `avr8-js` and `rp2040-js` already exist
  (`web/adapters/{avr8-js,rp2040-js}`) as JS-native, no-compiler runtimes;
  a genuinely new architecture needs a new adapter package first (see
  [ARCHITECTURE.md](ARCHITECTURE.md)'s "Two adapter kinds" section for
  what that involves).
- `boardPowerSetter` - how Start/Stop reflects onto the element (Arduino
  Uno's power LED, for instance) - board-specific since not every board
  exposes the same property.

Also worth adding, if the board should support pin read/write (not just
placement): a pin-name map in `web/common/src/boards/` (see
`arduino-uno.ts`), mapping the board's silkscreen names to the backing
adapter's raw pin ids - and a `PowerProfile` entry in
`web/shell/src/energy.ts`'s `boardPowerProfile` so the voltage/current
readout means something for the new board type instead of reading zero.
