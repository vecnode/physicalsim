import type { ElementPin } from "iot-elements";
import type { Wire } from "./wiring.js";

// Wire-level electrical validation - digital-only, name/metadata-based,
// deliberately *not* a topology solver (see ARCHITECTURE.md's "Explicitly
// out of scope" section: no Ohm's law, no SPICE/MNA). What this actually
// checks is narrower and fully grounded in data that already exists: every
// vendored @wokwi/elements board/component's own pinInfo carries a real
// `signals: PinSignalInfo[]` array (simulators/iot-elements/src/pin.ts),
// and a `{ type: "power", signal: "GND" | "VCC", voltage? }` entry there is
// the element's own manufacturer-shaped electrical metadata, not a guess
// this project is making from a pin's name string. A plain GPIO pin has no
// such entry and is intentionally never judged here - whether firmware
// will configure it as an input or output isn't known statically (that's
// exactly why "Still open" in ARCHITECTURE.md scoped a GPIO-direction-
// based short detector out: pinMode() only exists at runtime), so this
// validator only ever flags the one class of mistake that's true
// regardless of what any sketch does: physically wiring GND directly to a
// power rail, or two different fixed-voltage rails directly together.
export interface PinPowerInfo {
  kind: "gnd" | "vcc";
  // Absent for a VCC-classed pin with no declared nominal voltage (e.g.
  // some boards' bare "VIN") - such a pin is a real power rail, just not
  // one this data asserts a specific voltage for, so it's never compared
  // against a rail that *does* declare one (better to miss a real mismatch
  // than to invent a voltage that isn't actually in the source data).
  voltage?: number;
}

export type WireIssueSeverity = "short" | "voltage-mismatch";

export interface WireIssue {
  wireId: string;
  severity: WireIssueSeverity;
  message: string;
}

// Classifies one named pin on a placed element's own pinInfo as ground, a
// fixed-voltage rail, or "not a power pin at all" (undefined) - the sole
// point of contact with @wokwi/elements' data; everything else in this
// file is pure logic over that classification.
export function pinPowerInfo(pinInfoList: ElementPin[] | undefined, pinName: string): PinPowerInfo | undefined {
  const pin = pinInfoList?.find((p) => p.name === pinName);
  const signal = pin?.signals.find((s) => s.type === "power");
  if (!signal) return undefined;
  return signal.signal === "GND" ? { kind: "gnd" } : { kind: "vcc", voltage: signal.voltage };
}

// Checks every wire against the pin-power classification above -
// `getPinPower` is injected (not read from the DOM here) so this stays a
// pure function, testable without any real @wokwi/elements instance (see
// wire-validator.test.ts).
export function validateWires(
  wires: readonly Wire[],
  getPinPower: (entityId: string, pin: string) => PinPowerInfo | undefined,
): WireIssue[] {
  const issues: WireIssue[] = [];
  for (const wire of wires) {
    const a = getPinPower(wire.a.entityId, wire.a.pin);
    const b = getPinPower(wire.b.entityId, wire.b.pin);
    // At least one endpoint isn't a classified power pin (almost every
    // wire - GPIO/signal wiring, which is exactly what SignalChain/
    // AnalogChain/ProtocolChain already handle) - nothing for this
    // validator to say about it.
    if (!a || !b) continue;

    // Two grounds tied together is completely normal (boards commonly
    // share a common ground) - not flagged.
    if (a.kind === "gnd" && b.kind === "gnd") continue;

    if (a.kind !== b.kind) {
      issues.push({
        wireId: wire.id,
        severity: "short",
        message: "GND wired directly to a power rail - this is a short circuit.",
      });
      continue;
    }

    // Both VCC: only flagged when both sides declare a specific, differing
    // nominal voltage - an undeclared rail (voltage undefined) isn't
    // asserted to be anything in particular, so it's never compared.
    if (a.voltage !== undefined && b.voltage !== undefined && a.voltage !== b.voltage) {
      issues.push({
        wireId: wire.id,
        severity: "voltage-mismatch",
        message: `${a.voltage}V rail wired directly to a ${b.voltage}V rail - this can damage the lower-voltage side.`,
      });
    }
  }
  return issues;
}
