import type { CircuitPin } from "../circuit-pin.js";

// Read-only component: reflects whatever the wired pin's current value is.
// Doesn't drive the pin itself - an LED lights up because something else
// (firmware, or another component) drives its pin high.
export class Led {
  private on = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly pin: CircuitPin) {
    this.unsubscribe = this.pin.onChange((value) => {
      this.on = !!value;
    });
    // onChange() only fires on the *next* change - read the pin's current
    // value once up front so isOn reflects reality immediately, not just
    // after the first toggle.
    void this.pin.read().then((value) => {
      this.on = !!value;
    });
  }

  get isOn(): boolean {
    return this.on;
  }

  dispose(): void {
    this.unsubscribe();
  }
}
