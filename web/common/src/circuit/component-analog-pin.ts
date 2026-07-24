// Analog counterpart to component-signal-pin.ts: which of a placed
// component's pins carry a continuous voltage (read by a board's ADC)
// rather than a digital 0/1. Kept as its own table for the same reason
// componentProtocols is kept separate from componentSignalPins - "one
// pin, one 0/1 value" and "one pin, one voltage derived from this
// component's own current state" are different enough shapes that
// forcing them into componentSignalPins would leave one shape's fields
// unused by the other. Unlike ComponentSignalPin (any one of several
// equivalent pin names, one shared role for the whole component), this
// is a list because a component can expose several *independent* analog
// pins (an analog joystick's VERT and HORZ each read a different axis).
//
// Deliberately restricted to components whose @wokwi/elements source
// exposes a live, user-adjustable property an 'input' event fires on
// (confirmed against potentiometer-element.ts, slide-potentiometer-
// element.ts, analog-joystick-element.ts) - not every "analog" sensor
// in the catalog qualifies yet (photoresistor-sensor-element.ts, for
// instance, has no adjustable light-level property to read from at
// all), so this table is intentionally shorter than the whole ADC-
// capable-looking part of the catalog.
export interface ComponentAnalogPin {
  // Exact @wokwi/elements pin name (not "any of these" - each entry here
  // is one specific, independent analog input).
  pinName: string;
  // Reads this pin's target voltage (0..5) off the placed element's
  // current DOM properties. Never throws - callers should treat a
  // missing/NaN property as 0V (see clampVoltage below), the same
  // "missing data reads as inert, not broken" posture componentSignalPins
  // establishes.
  toVoltage: (el: Record<string, unknown>) => number;
}

function clampVoltage(v: number): number {
  return Number.isFinite(v) ? Math.min(5, Math.max(0, v)) : 0;
}

// wokwi-potentiometer/wokwi-slide-potentiometer both expose `value`
// (default range 0..1023, `min`/`max` properties) - see potentiometer-
// element.ts. Mapped linearly onto 0..5V, the same 10-bit-ADC-over-5V-
// reference relationship the real AVRADC assumes (see avr8js's own
// referenceVoltage getter, AVCC default 5V).
function potentiometerVoltage(el: Record<string, unknown>): number {
  const value = Number(el.value ?? 0);
  const min = Number(el.min ?? 0);
  const max = Number(el.max ?? 1023);
  if (max === min) return 0;
  return clampVoltage(((value - min) / (max - min)) * 5);
}

export const componentAnalogPins: Record<string, ComponentAnalogPin[]> = {
  potentiometer: [{ pinName: "SIG", toVoltage: potentiometerVoltage }],
  "slide-potentiometer": [{ pinName: "SIG", toVoltage: potentiometerVoltage }],
  // wokwi-analog-joystick's xValue/yValue range -1..1, centered at 0 when
  // released (analog-joystick-element.ts) - a real joystick's wiper sits
  // at mid-rail (2.5V on a 5V ADC reference) when centered, so the
  // mapping is (value+1)/2 * 5, not value/1023 * 5 like the pots above.
  "analog-joystick": [
    { pinName: "VERT", toVoltage: (el) => clampVoltage(((Number(el.yValue ?? 0) + 1) / 2) * 5) },
    { pinName: "HORZ", toVoltage: (el) => clampVoltage(((Number(el.xValue ?? 0) + 1) / 2) * 5) },
  ],
};
