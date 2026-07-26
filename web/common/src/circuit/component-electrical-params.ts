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
  // The component's own two electrical terminal pin names, exactly as
  // wiring.connect() refs it - "1"/"2" for a plain two-lead part
  // (ResistorElement/CapacitorElement, both generic @wokwi/elements
  // terminals), but "A"/"C" for an LED (wokwi-led's real anode/cathode
  // silkscreen names - see every wiring.connect(..., { pin: "A" | "C" })
  // call already in main.ts's EXAMPLES table). netlist.ts reads this
  // instead of assuming every electrical component shares the same "1"/"2"
  // naming.
  terminals: readonly [string, string];
}

export const componentElectricalParams: Record<string, ComponentElectricalParam> = {
  resistor: { attrKey: "value", displayName: "Resistance", unit: "ohm", defaultValue: 1000, terminals: ["1", "2"] },
  capacitor: { attrKey: "value", displayName: "Capacitance", unit: "F", defaultValue: 1e-7, terminals: ["1", "2"] },
  // "value" here is a forward-voltage threshold in volts, not a
  // resistance/capacitance - NetlistElement.value's own doc comment
  // (netlist.ts) documents this third meaning. 2V is a typical red/green
  // LED Vf (a real blue/white LED's is closer to 3V, but this is a
  // starting default the same way resistor's 1000ohm/capacitor's 100nF
  // are - not a claim about any specific placed LED's real color).
  led: { attrKey: "forwardVoltage", displayName: "Forward voltage", unit: "V", defaultValue: 2, terminals: ["A", "C"] },
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

// The counterpart lookup for a component type's own two terminal pin
// names (see ComponentElectricalParam.terminals' own doc comment).
// Returns undefined for the same "not an electrical component" case
// getElectricalValue() does - callers already gate on that together.
export function getElectricalTerminals(componentType: string): readonly [string, string] | undefined {
  return componentElectricalParams[componentType]?.terminals;
}
