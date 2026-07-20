// Marker interface: any circuit component (Led, Button, ...) can be added
// to a Circuit. Deliberately empty for now - Circuit is just a container
// until there's a real need (e.g. serialization, bulk teardown) for it to
// know more about what it holds.
export type CircuitComponent = object;

// Minimal container for a set of wired-up components. Intentionally thin -
// grows as real usage (the UI's breadboard view) demands more from it.
export class Circuit {
  private readonly components: CircuitComponent[] = [];

  addComponent(component: CircuitComponent): void {
    this.components.push(component);
  }

  get componentCount(): number {
    return this.components.length;
  }
}
