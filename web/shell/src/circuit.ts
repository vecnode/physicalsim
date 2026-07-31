import type { AdapterId } from "./adapter-registry.js";
import type {
  ArduinoUnoElement,
  ArduinoNanoElement,
  ArduinoMegaElement,
  FranzininhoElement,
  NanoRP2040ConnectElement,
  ESP32DevkitV1Element,
} from "@wokwi/elements";
// ArduinoLeonardoElement has no ledPower (or any other) @property - the
// vendored Fritzing artwork has no obvious dedicated power-status LED
// wired up yet, same posture as pi-pico's own missing boardPowerSetter
// entry below (real hardware has one; not modeled here yet).
import { componentRegistry } from "./component-registry.js";

// Not the same thing as @physicalsim/common's Circuit class
// (web/common/src/circuit/circuit.ts, a thin CircuitComponent container -
// currently unused anywhere, unrelated to this file). This one is the
// shell's board-placement scene: what's on tab 1's canvas, at what
// position, powered or not. Different layer, different job, same English
// word - worth knowing before assuming they're connected.

// A single placed board, deliberately plain/serializable data - no DOM
// references live here (those stay in a separate id-keyed map in
// main.ts), so JSON.stringify(circuit) always reflects exactly what's on
// the canvas without needing to strip anything out first.
export interface CircuitBoard {
  id: string;
  type: string; // e.g. "arduino-uno" - key into the registries below
  adapterId: AdapterId; // which SimulatorAdapter this board type is backed by
  x: number;
  y: number;
  powered: boolean;
  rotation: number; // degrees clockwise, any angle - see canvas/scene.ts's startRotateDrag()
}

// A placed sensor/connection part (component-registry.ts) - deliberately
// lighter than CircuitBoard: no adapterId/powered, since these aren't
// backed by any SimulatorAdapter and have no power state of their own
// yet. Wiring a component's pins to a board's is the natural next step
// once there's an actual netlist to solve (see ARCHITECTURE.md's
// "Explicitly out of scope" section) - this is just "it's placed on the
// canvas, at this position", same starting point CircuitBoard had before
// adapterId/powered existed.
export interface PlacedComponent {
  id: string;
  type: string; // key into component-registry.ts's componentRegistry
  x: number;
  y: number;
  rotation: number; // degrees clockwise, any angle - see canvas/scene.ts's startRotateDrag()
  // Extra DOM attributes applied at placement (e.g. an LED's `color` -
  // see EXAMPLES' colored-LED entries in main.ts). Not modeled as its own
  // per-type field since most components need none; kept on the model
  // itself (not just applied to the DOM, which addComponentAt() already
  // did before this field existed) so a saved circuit (psim-file.ts) can
  // restore a component exactly as configured, not just "one of this
  // type, somewhere."
  attrs?: Record<string, string>;
}

export interface Circuit {
  boards: CircuitBoard[];
  components: PlacedComponent[];
}

// Board id -> custom element tag name (@wokwi/elements). Arduino Nano is
// the same ATmega328p MCU as the Uno (see boards/arduino-nano.ts's own
// comment on why its BoardPinMap is identical) - a second placeable board
// type, reachable from the canvas's own right-click "Boards" menu the
// exact same way Arduino Uno already is, since context-menu.ts builds
// that menu generically from this table.
export const boardTagName: Record<string, string> = {
  "arduino-uno": "wokwi-arduino-uno",
  "arduino-nano": "wokwi-arduino-nano",
  "arduino-mega": "wokwi-arduino-mega",
  "arduino-leonardo": "wokwi-arduino-leonardo",
  franzininho: "wokwi-franzininho",
  // The one RP2040-family element @wokwi/elements actually vendors - see
  // boards/nano-rp2040-connect.ts's own comment on why this, not a plain
  // "Pico" element, is what makes rp2040 placeable at all.
  "nano-rp2040-connect": "wokwi-nano-rp2040-connect",
  "pi-pico": "wokwi-pi-pico",
  "pi-pico-w": "wokwi-pi-pico-w",
  // Vendored in wokwi-elements (upstream wokwi/wokwi-elements, not custom-
  // authored like the Pico boards) - see esp32-devkit-v1-element.ts.
  "esp32-devkit-v1": "wokwi-esp32-devkit-v1",
  // Same ESP32-WROOM-32 chip as esp32-devkit-v1, real artwork vendored
  // from wokwi/wokwi-boards the same way pi-pico-w's is (unlike
  // esp32-devkit-v1's own hand-drawn element).
  "esp32-devkit-c-v4": "wokwi-esp32-devkit-c-v4",
  // OV2640 camera + microSD slot are physically present but not emulated
  // (esp32js has no camera/SD peripheral) - GPIO/LED pins work normally,
  // same "present, not modeled" posture as pi-pico-w's WiFi chip.
  "esp32-cam": "wokwi-esp32-cam",
};

// Board id -> human-readable label, for menus that list board types (the
// canvas's right-click "add component" menu) rather than the select's own
// hardcoded <option> text (index.html) - a second surface listing the same
// board types needs its own label lookup, not to reach into the DOM.
export const boardDisplayName: Record<string, string> = {
  "arduino-uno": "Arduino Uno",
  "arduino-nano": "Arduino Nano",
  "arduino-mega": "Arduino Mega",
  "arduino-leonardo": "Arduino Leonardo",
  franzininho: "Franzininho",
  "nano-rp2040-connect": "Arduino Nano RP2040 Connect",
  "pi-pico": "Raspberry Pi Pico",
  "pi-pico-w": "Raspberry Pi Pico W",
  "esp32-devkit-v1": "ESP32 DevKit V1",
  "esp32-devkit-c-v4": "ESP32 DevKit C V4",
  "esp32-cam": "ESP32-CAM",
};

// Board id -> the SimulatorAdapter that powers it. This is what "plugging
// a board into an adapter" resolves to - see main.ts's showBoard(),
// which calls apply(boardAdapterId[type]) right after placing a board.
export const boardAdapterId: Record<string, AdapterId> = {
  "arduino-uno": "avr8",
  "arduino-nano": "avr8",
  // Its own adapter id, not "avr8" - the atmega2560 needs a different
  // chip config (chip.ts's ATMEGA2560), and clients are cached one per
  // AdapterId (see adapter-registry.ts's getAdapterClient()), so sharing
  // "avr8" here would mean an Uno and a Mega fight over one CPU instance
  // shaped for neither of them correctly.
  "arduino-mega": "avr8-mega",
  // Its own adapter id too - genuinely a different chip (ATmega32u4),
  // see chip.ts's ATMEGA32U4 config.
  "arduino-leonardo": "avr8-leonardo",
  // Its own adapter id too - genuinely a different chip (ATtiny85, not
  // an ATmega at all), see chip.ts's ATTINY85 config.
  franzininho: "avr8-attiny85",
  "nano-rp2040-connect": "rp2040",
  "pi-pico": "rp2040",
  "pi-pico-w": "rp2040",
  // Backed by @physicalsim/adapter-esp32 (web/adapters/esp32), a JS/TS
  // Worker adapter over the esp32js emulator core - same shape as
  // avr8/rp2040's own Worker adapters, no native process involved.
  "esp32-devkit-v1": "esp32",
  // Same chip, same adapter - no new adapter needed for either.
  "esp32-devkit-c-v4": "esp32",
  "esp32-cam": "esp32",
};

// Board id -> how to reflect powered on/off on its placed element. Board-
// specific because not every board type will expose the same property
// (or any property at all) for this - Arduino Uno's power-supply LED
// ("ON" on the silkscreen) is independent of any GPIO pin, unlike
// led13/ledTX/ledRX which track real pin state (not wired up yet).
// wokwi-arduino-nano happens to expose the identical property name.
export const boardPowerSetter: Record<string, (el: HTMLElement, on: boolean) => void> = {
  "arduino-uno": (el, on) => {
    (el as ArduinoUnoElement).ledPower = on;
  },
  "arduino-nano": (el, on) => {
    (el as ArduinoNanoElement).ledPower = on;
  },
  "arduino-mega": (el, on) => {
    (el as ArduinoMegaElement).ledPower = on;
  },
  franzininho: (el, on) => {
    (el as FranzininhoElement).ledPower = on;
  },
  "nano-rp2040-connect": (el, on) => {
    (el as NanoRP2040ConnectElement).ledPower = on;
  },
  "esp32-devkit-v1": (el, on) => {
    (el as ESP32DevkitV1Element).ledPower = on;
  },
};

let nextBoardId = 1;

// Returns null for an unknown board type rather than throwing - callers
// (showBoard()) already no-op on an unrecognized type via boardTagName.
export function createBoard(type: string): CircuitBoard | null {
  const adapterId = boardAdapterId[type];
  if (!adapterId) return null;
  return {
    id: `board-${nextBoardId++}`,
    type,
    adapterId,
    x: 0,
    y: 0,
    powered: false,
    rotation: 0,
  };
}

let nextComponentId = 1;

// Returns null for an unknown component type - mirrors createBoard()'s
// contract so callers (addComponentAt() in main.ts) handle both the same
// way.
export function createComponent(type: string, attrs?: Record<string, string>): PlacedComponent | null {
  if (!componentRegistry[type]) return null;
  return { id: `component-${nextComponentId++}`, type, x: 0, y: 0, rotation: 0, ...(attrs ? { attrs } : {}) };
}
