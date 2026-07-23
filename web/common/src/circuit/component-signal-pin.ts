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
};
