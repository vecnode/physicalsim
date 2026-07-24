// Which pin(s) of a placed component (component-registry.ts's keys, shell-
// side) actually carry a signal, and which direction: "write" means the
// component drives whatever board pin it's wired to (a pushbutton
// shorting a pin high), "read" means the component reflects whatever the
// board pin already is (an LED lighting up because firmware drove its
// pin). A component with no entry here has no signal-chain behavior yet -
// it's still just a static illustration on the canvas.
//
// Deliberately its own table, not a repurposing of boards/board.ts's
// BoardPinMap: a board's map describes 20+ real pins, this describes "one
// pin (of a few equivalent names) that matters" for a small part - same
// "don't force two different concepts into one shared struct" rule as
// energy.ts/circuit.ts's own split.
export type SignalRole = "read" | "write";

export interface ComponentSignalPin {
  // Any one of these @wokwi/elements pin names counts as *the* signal pin
  // - a pushbutton's four legs are two mechanically-shorted pairs, so
  // wiring to any one of them is equivalent for this purpose.
  pinNames: string[];
  role: SignalRole;
}

// Potentiometer/slide-potentiometer intentionally have no entry yet -
// analogRead() isn't modeled by any adapter today (no AVRADC wired up in
// web/adapters/avr8/src/adapter.ts), so there's nothing correct to attach
// them to. Adding them here once that lands is the only change needed.
export const componentSignalPins: Record<string, ComponentSignalPin> = {
  pushbutton: { pinNames: ["1.l", "2.l", "1.r", "2.r"], role: "write" },
  "pushbutton-6mm": { pinNames: ["1.l", "2.l", "1.r", "2.r"], role: "write" },
  led: { pinNames: ["A"], role: "read" },
  // The joystick's SEL (button) pin dispatches the exact same
  // "button-press"/"button-release" DOM events wokwi-pushbutton does
  // (simulators/wokwi-elements' own analog-joystick-element.ts) - no new
  // signal-chain code needed, same as pushbutton above. VERT/HORZ
  // (analog X/Y) intentionally have no entry - blocked by the same
  // missing-ADC reason potentiometer is, below.
  "analog-joystick": { pinNames: ["SEL"], role: "write" },
  // "read" role here is the generic "reflect whatever the board pin is"
  // code every read-role component already shares (see SignalChain) - the
  // exact right direction for the relay (firmware genuinely drives its
  // coil pin), but a real pir-motion-sensor/tilt-switch is actually an
  // *input* to firmware, not something firmware drives. Neither
  // wokwi-elements component has any click/interaction hook to be a real
  // write-role input yet (see their own element source), so "read" is
  // the only wiring physicalsim can offer today - a deliberate demo-only
  // capability (wire it to an output pin and it flashes), not a claim
  // that this is how the real sensor's data direction works.
  "ks2e-m-dc5": { pinNames: ["COIL1"], role: "read" },
  "pir-motion-sensor": { pinNames: ["OUT"], role: "read" },
  "tilt-switch": { pinNames: ["OUT"], role: "read" },
};
