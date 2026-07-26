// Which of a placed component's PlacedComponent.attrs holds a real
// electrical value (a resistor's resistance, a capacitor's capacitance),
// for the analog netlist (web/shell/src/canvas/netlist.ts) to read - the
// electrical-value counterpart to component-signal-pin.ts/component-
// analog-pin.ts: same "own table per concern" split this project already
// uses rather than forcing every table's fields onto one shared struct.
//
// Values are plain decimal numbers in base SI units (ohms, farads) -
// matching @wokwi/elements' own ResistorElement.value convention exactly
// (its color-band rendering does `parseFloat(value)` on a plain decimal
// string, e.g. "1000", never an SI-suffixed one like "1k"), so this
// doesn't invent a second parsing convention for CapacitorElement's own
// `value` (also plain decimal, e.g. "1e-7" for 100nF - JS's Number()
// already accepts exponential notation, so no custom parser is needed
// for that either).
export interface ComponentElectricalParam {
  // Which PlacedComponent.attrs key holds the value, and which DOM
  // property on the placed element mirrors it (always the same name
  // today - both ResistorElement and CapacitorElement call it `value` -
  // but kept as an explicit field rather than assumed, in case a future
  // component's own property is named differently).
  attrKey: string;
  displayName: string;
  unit: string;
  // Used when a placed component has no attrs entry yet (e.g. placed via
  // the right-click menu, which passes no attrs - see circuit.ts's
  // createComponent()) or an unparseable one.
  defaultValue: number;
}

export const componentElectricalParams: Record<string, ComponentElectricalParam> = {
  resistor: { attrKey: "value", displayName: "Resistance", unit: "ohm", defaultValue: 1000 },
  capacitor: { attrKey: "value", displayName: "Capacitance", unit: "F", defaultValue: 1e-7 },
};

// Resolves a placed component's real electrical value - `attrs` missing
// entirely, missing the key, or holding something unparseable/non-
// positive all fall back to the type's own defaultValue rather than
// producing NaN/0 (a 0-ohm resistor or 0-farad capacitor isn't a
// meaningful "not set yet" state to hand a solver). Returns undefined for
// a component type with no electrical param at all (most of the
// catalog) - the netlist builder skips those entirely.
export function getElectricalValue(componentType: string, attrs: Record<string, string> | undefined): number | undefined {
  const spec = componentElectricalParams[componentType];
  if (!spec) return undefined;
  const raw = attrs?.[spec.attrKey];
  const parsed = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : spec.defaultValue;
}
