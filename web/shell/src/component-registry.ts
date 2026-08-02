// Everything @wokwi/elements exports that isn't a board (see circuit.ts's
// boardTagName/boardDisplayName for the boards - Arduino Mega/Nano,
// ESP32 DevKit, Franzininho, and Nano RP2040 Connect all exist in the
// vendored fork too, deliberately left out of here since this registry
// is scoped to "things you wire up to a board", not more boards).
//
// All of these tags are already registered as custom elements the
// moment main.ts does `import "iot-elements"` - that side-effect
// import pulls in the whole vendored library, not just Arduino Uno (see
// ARCHITECTURE.md's "Vendoring @wokwi/elements" section) - nothing
// further to wire up here beyond naming and grouping them for the
// canvas's right-click menu.
//
// "Connections" is this project's umbrella term for everything that
// isn't primarily a sensing element - displays, actuators, passives,
// inputs, and small peripheral modules - not literal wires, which
// @wokwi/elements has no discrete element for; wiring between placed
// parts is unbuilt (see ARCHITECTURE.md's "Explicitly out of scope"
// section).
export type ComponentCategory = "sensors" | "connections";

export interface ComponentDef {
  tagName: string;
  displayName: string;
  category: ComponentCategory;
}

export const componentRegistry: Record<string, ComponentDef> = {
  // --- Sensors: things that read something about the environment ---
  dht22: { tagName: "iot-dht22", displayName: "DHT22 (Temp/Humidity)", category: "sensors" },
  "hc-sr04": { tagName: "iot-hc-sr04", displayName: "HC-SR04 (Ultrasonic)", category: "sensors" },
  "flame-sensor": { tagName: "iot-flame-sensor", displayName: "Flame Sensor", category: "sensors" },
  "gas-sensor": { tagName: "iot-gas-sensor", displayName: "Gas Sensor", category: "sensors" },
  "heart-beat-sensor": {
    tagName: "iot-heart-beat-sensor",
    displayName: "Heart Beat Sensor",
    category: "sensors",
  },
  "ir-receiver": { tagName: "iot-ir-receiver", displayName: "IR Receiver", category: "sensors" },
  mpu6050: { tagName: "iot-mpu6050", displayName: "MPU6050 (Accel/Gyro)", category: "sensors" },
  "ntc-temperature-sensor": {
    tagName: "iot-ntc-temperature-sensor",
    displayName: "NTC Temperature Sensor",
    category: "sensors",
  },
  "photoresistor-sensor": {
    tagName: "iot-photoresistor-sensor",
    displayName: "Photoresistor",
    category: "sensors",
  },
  "pir-motion-sensor": {
    tagName: "iot-pir-motion-sensor",
    displayName: "PIR Motion Sensor",
    category: "sensors",
  },
  "small-sound-sensor": {
    tagName: "iot-small-sound-sensor",
    displayName: "Small Sound Sensor",
    category: "sensors",
  },
  "big-sound-sensor": {
    tagName: "iot-big-sound-sensor",
    displayName: "Big Sound Sensor",
    category: "sensors",
  },
  "tilt-switch": { tagName: "iot-tilt-switch", displayName: "Tilt Switch", category: "sensors" },
  hx711: { tagName: "iot-hx711", displayName: "HX711 (Load Cell Amp)", category: "sensors" },

  // --- Connections: displays, actuators, passives, inputs, modules ---
  led: { tagName: "iot-led", displayName: "LED", category: "connections" },
  "rgb-led": { tagName: "iot-rgb-led", displayName: "RGB LED", category: "connections" },
  "led-ring": { tagName: "iot-led-ring", displayName: "LED Ring", category: "connections" },
  "led-bar-graph": {
    tagName: "iot-led-bar-graph",
    displayName: "LED Bar Graph",
    category: "connections",
  },
  neopixel: { tagName: "iot-neopixel", displayName: "NeoPixel", category: "connections" },
  "neopixel-matrix": {
    tagName: "iot-neopixel-matrix",
    displayName: "NeoPixel Matrix",
    category: "connections",
  },
  "7segment": { tagName: "iot-7segment", displayName: "7-Segment Display", category: "connections" },
  lcd1602: { tagName: "iot-lcd1602", displayName: "LCD1602", category: "connections" },
  lcd2004: { tagName: "iot-lcd2004", displayName: "LCD2004", category: "connections" },
  ssd1306: { tagName: "iot-ssd1306", displayName: "SSD1306 (OLED)", category: "connections" },
  ili9341: { tagName: "iot-ili9341", displayName: "ILI9341 (TFT)", category: "connections" },
  buzzer: { tagName: "iot-buzzer", displayName: "Buzzer", category: "connections" },
  servo: { tagName: "iot-servo", displayName: "Servo Motor", category: "connections" },
  "stepper-motor": {
    tagName: "iot-stepper-motor",
    displayName: "Stepper Motor",
    category: "connections",
  },
  "biaxial-stepper": {
    tagName: "iot-biaxial-stepper",
    displayName: "Biaxial Stepper",
    category: "connections",
  },
  resistor: { tagName: "iot-resistor", displayName: "Resistor", category: "connections" },
  capacitor: { tagName: "iot-capacitor", displayName: "Capacitor", category: "connections" },
  potentiometer: {
    tagName: "iot-potentiometer",
    displayName: "Potentiometer",
    category: "connections",
  },
  "slide-potentiometer": {
    tagName: "iot-slide-potentiometer",
    displayName: "Slide Potentiometer",
    category: "connections",
  },
  pushbutton: { tagName: "iot-pushbutton", displayName: "Pushbutton", category: "connections" },
  "pushbutton-6mm": {
    tagName: "iot-pushbutton-6mm",
    displayName: "Pushbutton (6mm)",
    category: "connections",
  },
  "slide-switch": { tagName: "iot-slide-switch", displayName: "Slide Switch", category: "connections" },
  "dip-switch-8": {
    tagName: "iot-dip-switch-8",
    displayName: "DIP Switch (8-way)",
    category: "connections",
  },
  "membrane-keypad": {
    tagName: "iot-membrane-keypad",
    displayName: "Membrane Keypad",
    category: "connections",
  },
  "rotary-dialer": {
    tagName: "iot-rotary-dialer",
    displayName: "Rotary Dialer",
    category: "connections",
  },
  "ks2e-m-dc5": {
    tagName: "iot-ks2e-m-dc5",
    displayName: "Relay (KS2E-M-DC5)",
    category: "connections",
  },
  ds1307: { tagName: "iot-ds1307", displayName: "DS1307 (RTC)", category: "connections" },
  "microsd-card": {
    tagName: "iot-microsd-card",
    displayName: "MicroSD Card",
    category: "connections",
  },
  "analog-joystick": {
    tagName: "iot-analog-joystick",
    displayName: "Analog Joystick",
    category: "connections",
  },
  "ky-040": {
    tagName: "iot-ky-040",
    displayName: "Rotary Encoder (KY-040)",
    category: "connections",
  },
  "ir-remote": { tagName: "iot-ir-remote", displayName: "IR Remote", category: "connections" },

  // --- Added from iot-elements' own "parts Wokwi documents but never
  // open-sourced" batch (see COMPONENTS.md's "Originally-drawn parts"
  // section) - visual/wireable only, same tier as most entries above. ---
  bmp180: { tagName: "iot-bmp180", displayName: "BMP180 (Pressure)", category: "sensors" },
  ds18b20: { tagName: "iot-ds18b20", displayName: "DS18B20 (1-Wire Temp)", category: "sensors" },
  mfrc522: { tagName: "iot-mfrc522", displayName: "MFRC522 (RFID)", category: "sensors" },
  "logic-analyzer": {
    tagName: "iot-logic-analyzer",
    displayName: "Logic Analyzer",
    category: "sensors",
  },
  "74hc165": { tagName: "iot-74hc165", displayName: "74HC165 (Shift-In)", category: "connections" },
  "74hc595": { tagName: "iot-74hc595", displayName: "74HC595 (Shift-Out)", category: "connections" },
  nlsf595: { tagName: "iot-nlsf595", displayName: "NLSF595 (Shift-Out)", category: "connections" },
  attiny85: { tagName: "iot-attiny85", displayName: "ATtiny85 (bare chip)", category: "connections" },
  a4988: { tagName: "iot-a4988", displayName: "A4988 (Stepper Driver)", category: "connections" },
  "clock-generator": {
    tagName: "iot-clock-generator",
    displayName: "Clock Generator",
    category: "connections",
  },
  "grove-oled-sh1107": {
    tagName: "iot-grove-oled-sh1107",
    displayName: "Grove OLED (SH1107)",
    category: "connections",
  },
  "led-matrix": { tagName: "iot-led-matrix", displayName: "LED Matrix (8x8)", category: "connections" },
  "led-strip": { tagName: "iot-led-strip", displayName: "LED Strip", category: "connections" },
  "max7219-matrix": {
    tagName: "iot-max7219-matrix",
    displayName: "MAX7219 Matrix",
    category: "connections",
  },
  "nokia-5110-screen": {
    tagName: "iot-nokia-5110-screen",
    displayName: "Nokia 5110 Screen",
    category: "connections",
  },
  "relay-module": {
    tagName: "iot-relay-module",
    displayName: "Relay Module",
    category: "connections",
  },
  text: { tagName: "iot-text", displayName: "Text Label", category: "connections" },
  "tm1637-7segment": {
    tagName: "iot-tm1637-7segment",
    displayName: "TM1637 7-Segment",
    category: "connections",
  },
  tv: { tagName: "iot-tv", displayName: "TV (Composite)", category: "connections" },
  "wifi-ap": { tagName: "iot-wifi-ap", displayName: "WiFi Access Point", category: "connections" },
  "franzininho-wifi": {
    tagName: "iot-franzininho-wifi",
    displayName: "Franzininho WiFi (visual only)",
    category: "connections",
  },
  "nucleo-c031c6": {
    tagName: "iot-nucleo-c031c6",
    displayName: "Nucleo C031C6 (visual only)",
    category: "connections",
  },
  "nucleo-l031k6": {
    tagName: "iot-nucleo-l031k6",
    displayName: "Nucleo L031K6 (visual only)",
    category: "connections",
  },
  "stm32-bluepill": {
    tagName: "iot-stm32-bluepill",
    displayName: "STM32 Blue Pill (visual only)",
    category: "connections",
  },
  // A 30-column half breadboard (iot-elements' own breadboard-half-
  // element.ts) - power/ground rails and terminal strips are internally
  // bussed via pin.ts's "same name prefix = same net" convention (see
  // that element's doc comment), so wiring two components' pins into the
  // same rail or column here genuinely puts them on the same node for
  // the signal chain, the same as a real breadboard's internal clips -
  // no breadboard-specific code needed anywhere in this app.
  "breadboard-half": {
    tagName: "iot-breadboard-half",
    displayName: "Breadboard (Half, 30-Column)",
    category: "connections",
  },
};
