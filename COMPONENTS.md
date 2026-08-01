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


## Components

Placed via the canvas's right-click. No power/adapter
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
| HX711 (Load Cell Amp) | `wokwi-hx711` |
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
