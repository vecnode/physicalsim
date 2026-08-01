# Components

Everything placeable on the canvas (tab 1's right-click menu) comes from
the vendored `@wokwi/elements` fork (`simulators/wokwi-elements`, MIT) -
see [ARCHITECTURE.md](ARCHITECTURE.md)'s "Vendoring @wokwi/elements"
section for how it's built into the app. This file is the registry: what's
wired up today, and how to add more. Preview images are the element's own
real rendered SVG (extracted live from the running app, not hand-drawn),
each shown at its own smaller side's size so proportions stay honest.

## Boards

Backed by a `SimulatorAdapter` (CPU emulation - see
[ARCHITECTURE.md](ARCHITECTURE.md)) and powered by Start/Pause/Stop.
Registered in `web/shell/src/circuit.ts`. Every AVR/RP2040 board runs a
JS-native sketch runtime now (no C/C++ toolchain) - only ESP32 still
compiles for real, via the vendored `esp-idf`.

| Board | Custom element | Adapter | Fork | Preview |
|---|---|---|---|---|
| Arduino Uno | `wokwi-arduino-uno` | `avr8-js` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-arduino-uno.svg" height="53"> |
| Arduino Nano | `wokwi-arduino-nano` | `avr8-js` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-arduino-nano.svg" height="17"> |
| Arduino Mega | `wokwi-arduino-mega` | `avr8-js-mega` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-arduino-mega.svg" height="50"> |
| Franzininho | `wokwi-franzininho` | `avr8-js-attiny85` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-franzininho.svg" height="30"> |
| Arduino Leonardo | `wokwi-arduino-leonardo` | `avr8-js` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-arduino-leonardo.svg" height="51"> |
| Arduino Nano RP2040 Connect | `wokwi-nano-rp2040-connect` | `rp2040-js` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-nano-rp2040-connect.svg" height="17"> |
| Raspberry Pi Pico | `wokwi-pi-pico` | `rp2040-js` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-pi-pico.svg" height="20"> |
| Raspberry Pi Pico W | `wokwi-pi-pico-w` | `rp2040-js` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-pi-pico-w.svg" height="20"> |
| ESP32 DevKit V1 | `wokwi-esp32-devkit-v1` | `esp32` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-esp32-devkit-v1.svg" height="28"> |
| ESP32 DevKit C V4 | `wokwi-esp32-devkit-c-v4` | `esp32` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-esp32-devkit-c-v4.svg" height="27"> |
| ESP32-CAM | `wokwi-esp32-cam` | `esp32` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-esp32-cam.svg" height="27"> |


## Components

Placed via the canvas's right-click. No power/adapter
state - purely placed and wireable (see [ARCHITECTURE.md](ARCHITECTURE.md)'s
"pin-to-pin connections" section). Registered in
`web/shell/src/component-registry.ts`.

| Component | Custom element | Fork | Preview |
|---|---|---|---|
| DHT22 (Temp/Humidity) | `wokwi-dht22` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-dht22.svg" height="16"> |
| HC-SR04 (Ultrasonic) | `wokwi-hc-sr04` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-hc-sr04.svg" height="25"> |
| Flame Sensor | `wokwi-flame-sensor` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-flame-sensor.svg" height="16"> |
| Gas Sensor | `wokwi-gas-sensor` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-gas-sensor.svg" height="16"> |
| Heart Beat Sensor | `wokwi-heart-beat-sensor` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-heart-beat-sensor.svg" height="20"> |
| IR Receiver | `wokwi-ir-receiver` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-ir-receiver.svg" height="16"> |
| MPU6050 (Accel/Gyro) | `wokwi-mpu6050` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-mpu6050.svg" height="16"> |
| NTC Temperature Sensor | `wokwi-ntc-temperature-sensor` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-ntc-temperature-sensor.svg" height="19"> |
| Photoresistor | `wokwi-photoresistor-sensor` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-photoresistor-sensor.svg" height="16"> |
| PIR Motion Sensor | `wokwi-pir-motion-sensor` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-pir-motion-sensor.svg" height="24"> |
| Small Sound Sensor | `wokwi-small-sound-sensor` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-small-sound-sensor.svg" height="16"> |
| Big Sound Sensor | `wokwi-big-sound-sensor` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-big-sound-sensor.svg" height="16"> |
| Tilt Switch | `wokwi-tilt-switch` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-tilt-switch.svg" height="16"> |
| HX711 (Load Cell Amp) | `wokwi-hx711` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-hx711.svg" height="43"> |
| LED | `wokwi-led` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-led.svg" height="40"> |
| RGB LED | `wokwi-rgb-led` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-rgb-led.svg" height="42"> |
| LED Ring | `wokwi-led-ring` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-led-ring.svg" height="37"> |
| LED Bar Graph | `wokwi-led-bar-graph` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-led-bar-graph.svg" height="16"> |
| NeoPixel | `wokwi-neopixel` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-neopixel.svg" height="16"> |
| NeoPixel Matrix | `wokwi-neopixel-matrix` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-neopixel-matrix.svg" height="47"> |
| 7-Segment Display | `wokwi-7segment` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-7segment.svg" height="16"> |
| LCD1602 | `wokwi-lcd1602` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-lcd1602.svg" height="36"> |
| LCD2004 | `wokwi-lcd2004` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-lcd2004.svg" height="47"> |
| SSD1306 (OLED) | `wokwi-ssd1306` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-ssd1306.svg" height="96"> |
| ILI9341 (TFT) | `wokwi-ili9341` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-ili9341.svg" height="46"> |
| Buzzer | `wokwi-buzzer` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-buzzer.svg" height="16"> |
| Servo Motor | `wokwi-servo` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-servo.svg" height="31"> |
| Stepper Motor | `wokwi-stepper-motor` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-stepper-motor.svg" height="58"> |
| Biaxial Stepper | `wokwi-biaxial-stepper` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-biaxial-stepper.svg" height="56"> |
| Resistor | `wokwi-resistor` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-resistor.svg" height="16"> |
| Capacitor | `wokwi-capacitor` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-capacitor.svg" height="16"> |
| Potentiometer | `wokwi-potentiometer` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-potentiometer.svg" height="20"> |
| Slide Potentiometer | `wokwi-slide-potentiometer` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-slide-potentiometer.svg" height="29"> |
| Pushbutton | `wokwi-pushbutton` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-pushbutton.svg" height="16"> |
| Pushbutton (6mm) | `wokwi-pushbutton-6mm` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-pushbutton-6mm.svg" height="16"> |
| Slide Switch | `wokwi-slide-switch` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-slide-switch.svg" height="16"> |
| DIP Switch (8-way) | `wokwi-dip-switch-8` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-dip-switch-8.svg" height="55"> |
| Membrane Keypad | `wokwi-membrane-keypad` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-membrane-keypad.svg" height="70"> |
| Rotary Dialer | `wokwi-rotary-dialer` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-rotary-dialer.svg" height="96"> |
| Relay (KS2E-M-DC5) | `wokwi-ks2e-m-dc5` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-ks2e-m-dc5.svg" height="16"> |
| DS1307 (RTC) | `wokwi-ds1307` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-ds1307.svg" height="22"> |
| MicroSD Card | `wokwi-microsd-card` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-microsd-card.svg" height="20"> |
| Analog Joystick | `wokwi-analog-joystick` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-analog-joystick.svg" height="27"> |
| Rotary Encoder (KY-040) | `wokwi-ky-040` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-ky-040.svg" height="18"> |
| IR Remote | `wokwi-ir-remote` | `vecnode/wokwi-elements` | <img src="assets/component-previews/wokwi-ir-remote.svg" height="40"> |



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
