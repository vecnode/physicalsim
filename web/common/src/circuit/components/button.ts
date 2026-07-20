import type { CircuitPin } from "../circuit-pin.js";

// Drives its wired pin - the mirror image of Led. press()/release() model
// an external actor (the UI) forcing the pin's value, the same way a
// physical button shorts a pin to a rail while held.
export class Button {
  constructor(private readonly pin: CircuitPin) {}

  press(): Promise<void> {
    return this.pin.write(1);
  }

  release(): Promise<void> {
    return this.pin.write(0);
  }
}
