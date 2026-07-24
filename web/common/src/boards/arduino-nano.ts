import type { BoardPinMap } from "./board.js";

// Arduino Nano silkscreen pin names -> avr8 adapter pin ids. The Nano is
// the exact same ATmega328p MCU as the Uno (confirmed against
// simulators/wokwi-elements' arduino-nano-element.ts - same bare-digit
// pin markers "12", "11", ... "0"/"1", the same D2-D7=PORTD/D8-D13=PORTB
// split), so this is byte-for-byte identical to arduino-uno.ts's own map
// for D0-D13/A0-A5. A6/A7 (which the Nano breaks out but the Uno doesn't)
// are intentionally omitted - on real hardware those two are ADC-only
// pins with no GPIO port register at all, and there's no ADC modeled by
// any adapter today anyway (same reason potentiometer/photoresistor-
// sensor/etc. have no componentSignalPins entry - see that file's own
// comment).
export const arduinoNano: BoardPinMap = {
  D0: "D0",
  D1: "D1",
  D2: "D2",
  D3: "D3",
  D4: "D4",
  D5: "D5",
  D6: "D6",
  D7: "D7",
  D8: "B0",
  D9: "B1",
  D10: "B2",
  D11: "B3",
  D12: "B4",
  D13: "B5", // onboard LED
  A0: "C0",
  A1: "C1",
  A2: "C2",
  A3: "C3",
  A4: "C4",
  A5: "C5",
};
