// Multi-pin "protocol" components - the counterpart to component-signal-
// pin.ts's single-pin read/write roles, for components whose behavior
// needs several of a board's pins correlated together rather than one
// pin's 0/1 value alone (an LCD's RS/E/D4-D7 bus, for instance). A
// component with an entry here needs every one of its listed roles
// wired before anything attaches (see canvas/protocol-net.ts's
// resolveProtocolLinks(), web/shell/src/protocol-chain.ts) - a
// partially-wired LCD (say, missing D7) has no protocol behavior yet,
// same as an entirely unwired one.
//
// Deliberately its own table, not folded into componentSignalPins: a
// signal role is "one pin, one 0/1 value, one direction"; a protocol
// role set is "several pins, correlated together, decoded by a specific
// stateful class" - different enough in shape that forcing them into one
// table would mean one of the two grew awkward optional fields the other
// never uses. Board-agnostic by construction, same as componentSignalPins
// - this table only ever names a component's own pin names, never a
// board type or adapter kind, so it needs no change for a future board
// (an ESP32-over-QEMU board included, once that adapter implements real
// pin I/O).
export interface ProtocolPinRole {
  // Any one of these @wokwi/elements pin names counts as satisfying this
  // role - mirrors ComponentSignalPin.pinNames' own "any one of these is
  // equivalent" contract, just scoped to a single named role instead of
  // the whole component.
  pinNames: string[];
}

export interface ComponentProtocol {
  // Every entry must resolve to a wired board pin before this
  // component's protocol is considered "complete".
  roles: Record<string, ProtocolPinRole>;
}

// wokwi-lcd2004 (simulators/wokwi-elements) is a plain subclass of
// wokwi-lcd1602 overriding only numCols/numRows - its pinInfo (and so its
// RS/E/D4-D7 pin names) is exactly the same, unchanged. Shared here for
// the same reason: both entries name the identical set of roles.
const HD44780_PARALLEL_ROLES: Record<string, ProtocolPinRole> = {
  rs: { pinNames: ["RS"] },
  e: { pinNames: ["E"] },
  d4: { pinNames: ["D4"] },
  d5: { pinNames: ["D5"] },
  d6: { pinNames: ["D6"] },
  d7: { pinNames: ["D7"] },
};

export const componentProtocols: Record<string, ComponentProtocol> = {
  lcd1602: { roles: HD44780_PARALLEL_ROLES },
  lcd2004: { roles: HD44780_PARALLEL_ROLES },
};
