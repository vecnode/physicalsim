// Everything @wokwi/elements exports that isn't a board (see circuit.ts's
// boardTagName/boardDisplayName for the boards - Arduino Mega/Nano,
// ESP32 DevKit, Franzininho, and Nano RP2040 Connect all exist in the
// vendored fork too, deliberately left out of here since this registry
// is scoped to "things you wire up to a board", not more boards).
//
// All of these tags are already registered as custom elements the
// moment main.ts does `import "@wokwi/elements"` - that side-effect
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
  dht22: { tagName: "wokwi-dht22", displayName: "DHT22 (Temp/Humidity)", category: "sensors" },
  "hc-sr04": { tagName: "wokwi-hc-sr04", displayName: "HC-SR04 (Ultrasonic)", category: "sensors" },
  "flame-sensor": { tagName: "wokwi-flame-sensor", displayName: "Flame Sensor", category: "sensors" },
  "gas-sensor": { tagName: "wokwi-gas-sensor", displayName: "Gas Sensor", category: "sensors" },
  "heart-beat-sensor": {
    tagName: "wokwi-heart-beat-sensor",
    displayName: "Heart Beat Sensor",
    category: "sensors",
  },
  "ir-receiver": { tagName: "wokwi-ir-receiver", displayName: "IR Receiver", category: "sensors" },
  mpu6050: { tagName: "wokwi-mpu6050", displayName: "MPU6050 (Accel/Gyro)", category: "sensors" },
  "ntc-temperature-sensor": {
    tagName: "wokwi-ntc-temperature-sensor",
    displayName: "NTC Temperature Sensor",
    category: "sensors",
  },
  "photoresistor-sensor": {
    tagName: "wokwi-photoresistor-sensor",
    displayName: "Photoresistor",
    category: "sensors",
  },
  "pir-motion-sensor": {
    tagName: "wokwi-pir-motion-sensor",
    displayName: "PIR Motion Sensor",
    category: "sensors",
  },
  "small-sound-sensor": {
    tagName: "wokwi-small-sound-sensor",
    displayName: "Small Sound Sensor",
    category: "sensors",
  },
  "big-sound-sensor": {
    tagName: "wokwi-big-sound-sensor",
    displayName: "Big Sound Sensor",
    category: "sensors",
  },
  "tilt-switch": { tagName: "wokwi-tilt-switch", displayName: "Tilt Switch", category: "sensors" },

  // --- Connections: displays, actuators, passives, inputs, modules ---
  led: { tagName: "wokwi-led", displayName: "LED", category: "connections" },
  "rgb-led": { tagName: "wokwi-rgb-led", displayName: "RGB LED", category: "connections" },
  "led-ring": { tagName: "wokwi-led-ring", displayName: "LED Ring", category: "connections" },
  "led-bar-graph": {
    tagName: "wokwi-led-bar-graph",
    displayName: "LED Bar Graph",
    category: "connections",
  },
  neopixel: { tagName: "wokwi-neopixel", displayName: "NeoPixel", category: "connections" },
  "neopixel-matrix": {
    tagName: "wokwi-neopixel-matrix",
    displayName: "NeoPixel Matrix",
    category: "connections",
  },
  "7segment": { tagName: "wokwi-7segment", displayName: "7-Segment Display", category: "connections" },
  lcd1602: { tagName: "wokwi-lcd1602", displayName: "LCD1602", category: "connections" },
  lcd2004: { tagName: "wokwi-lcd2004", displayName: "LCD2004", category: "connections" },
  ssd1306: { tagName: "wokwi-ssd1306", displayName: "SSD1306 (OLED)", category: "connections" },
  ili9341: { tagName: "wokwi-ili9341", displayName: "ILI9341 (TFT)", category: "connections" },
  buzzer: { tagName: "wokwi-buzzer", displayName: "Buzzer", category: "connections" },
  servo: { tagName: "wokwi-servo", displayName: "Servo Motor", category: "connections" },
  "stepper-motor": {
    tagName: "wokwi-stepper-motor",
    displayName: "Stepper Motor",
    category: "connections",
  },
  "biaxial-stepper": {
    tagName: "wokwi-biaxial-stepper",
    displayName: "Biaxial Stepper",
    category: "connections",
  },
  resistor: { tagName: "wokwi-resistor", displayName: "Resistor", category: "connections" },
  potentiometer: {
    tagName: "wokwi-potentiometer",
    displayName: "Potentiometer",
    category: "connections",
  },
  "slide-potentiometer": {
    tagName: "wokwi-slide-potentiometer",
    displayName: "Slide Potentiometer",
    category: "connections",
  },
  pushbutton: { tagName: "wokwi-pushbutton", displayName: "Pushbutton", category: "connections" },
  "pushbutton-6mm": {
    tagName: "wokwi-pushbutton-6mm",
    displayName: "Pushbutton (6mm)",
    category: "connections",
  },
  "slide-switch": { tagName: "wokwi-slide-switch", displayName: "Slide Switch", category: "connections" },
  "dip-switch-8": {
    tagName: "wokwi-dip-switch-8",
    displayName: "DIP Switch (8-way)",
    category: "connections",
  },
  "membrane-keypad": {
    tagName: "wokwi-membrane-keypad",
    displayName: "Membrane Keypad",
    category: "connections",
  },
  "rotary-dialer": {
    tagName: "wokwi-rotary-dialer",
    displayName: "Rotary Dialer",
    category: "connections",
  },
  "ks2e-m-dc5": {
    tagName: "wokwi-ks2e-m-dc5",
    displayName: "Relay (KS2E-M-DC5)",
    category: "connections",
  },
  ds1307: { tagName: "wokwi-ds1307", displayName: "DS1307 (RTC)", category: "connections" },
  "microsd-card": {
    tagName: "wokwi-microsd-card",
    displayName: "MicroSD Card",
    category: "connections",
  },
  "analog-joystick": {
    tagName: "wokwi-analog-joystick",
    displayName: "Analog Joystick",
    category: "connections",
  },
  "ky-040": {
    tagName: "wokwi-ky-040",
    displayName: "Rotary Encoder (KY-040)",
    category: "connections",
  },
  "ir-remote": { tagName: "wokwi-ir-remote", displayName: "IR Remote", category: "connections" },
};
