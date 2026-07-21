// Pin-to-pin connections between placed boards/components - click one
// pin, then click another, and a wire is drawn between them. A second,
// separate model from the scene (circuit.ts's CircuitBoard/
// PlacedComponent), bridged only by entity id - the same pattern
// energy.ts already established for this project (see its own doc
// comment): two things that don't need to share a struct stay two
// things, connected through a narrow interface instead.
//
// Rendering: one <svg> layer appended as a child of the pannable/
// zoomable content element (not a sibling positioned separately), so it
// inherits the exact same CSS transform every placed board/component
// does - a wire's endpoints are plain world coordinates, and pan/zoom
// move and scale it correctly with zero extra math, the same free ride
// the board/component wrappers already get. Only entity drags need this
// file to do anything (render() recomputes both endpoints from current
// entity position + pin offset), not pan/zoom.
export interface PinRef {
  entityId: string;
  pin: string;
}

export interface Wire {
  id: string;
  a: PinRef;
  b: PinRef;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export class WiringLayer {
  private readonly svg: SVGSVGElement;
  private wires: Wire[] = [];
  private nextId = 1;

  // Pin-local offsets (the same pin.x/pin.y used to position the marker
  // itself, relative to its entity's wrapper) - registered by the scene
  // when it creates each pin marker, so a wire endpoint can be recomputed
  // as "entity position + pin offset" without reaching back into
  // @wokwi/elements' pinInfo itself.
  private readonly pinOffsets = new Map<string, { x: number; y: number }>();

  // The pin a click is waiting on a second click to connect to - null
  // when no connection is in progress.
  private pending: { entityId: string; pin: string; marker: HTMLElement } | null = null;

  constructor(
    content: HTMLElement,
    private readonly getEntityPosition: (entityId: string) => { x: number; y: number } | undefined,
  ) {
    this.svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
    this.svg.classList.add("wire-layer");
    // Appended first (not last) so every placed board/component wrapper
    // renders on top of the wire layer, not under it - a wire should
    // visually run behind the parts it connects, not over them.
    content.insertBefore(this.svg, content.firstChild);
  }

  registerPin(entityId: string, pin: string, x: number, y: number): void {
    this.pinOffsets.set(pinKey(entityId, pin), { x, y });
  }

  // Called when an entity is deleted - drops both its pin offsets and any
  // wire touching it, so a dangling wire never renders pointing at
  // nothing.
  removeEntity(entityId: string): void {
    for (const key of [...this.pinOffsets.keys()]) {
      if (key.startsWith(`${entityId}:`)) this.pinOffsets.delete(key);
    }
    if (this.pending?.entityId === entityId) this.cancelPending();
    const before = this.wires.length;
    this.wires = this.wires.filter((w) => w.a.entityId !== entityId && w.b.entityId !== entityId);
    if (this.wires.length !== before) this.render();
  }

  cancelPending(): void {
    this.pending?.marker.classList.remove("connecting");
    this.pending = null;
  }

  // The scene calls this from a pin marker's click handler. First click
  // on any pin starts a pending connection (visually marked
  // ".connecting"); a second click on a *different* pin completes it.
  // Clicking the same pin again cancels instead of connecting a pin to
  // itself.
  handlePinClick(entityId: string, pin: string, marker: HTMLElement): void {
    if (!this.pending) {
      this.pending = { entityId, pin, marker };
      marker.classList.add("connecting");
      return;
    }
    if (this.pending.entityId === entityId && this.pending.pin === pin) {
      this.cancelPending();
      return;
    }
    const wire: Wire = {
      id: `wire-${this.nextId++}`,
      a: { entityId: this.pending.entityId, pin: this.pending.pin },
      b: { entityId, pin },
    };
    this.cancelPending();
    this.wires.push(wire);
    this.render();
  }

  // Clears every wire and pending state - called when the scene is reset
  // (Apply replacing everything).
  reset(): void {
    this.wires = [];
    this.pinOffsets.clear();
    this.cancelPending();
    this.render();
  }

  // Recomputes both endpoints of every wire from current entity
  // positions - call after any entity moves (drag), not just when wires
  // themselves change.
  render(): void {
    this.svg.replaceChildren();
    for (const wire of this.wires) {
      const a = this.endpoint(wire.a);
      const b = this.endpoint(wire.b);
      if (!a || !b) continue;
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", String(a.x));
      line.setAttribute("y1", String(a.y));
      line.setAttribute("x2", String(b.x));
      line.setAttribute("y2", String(b.y));
      line.setAttribute("class", "wire-line");
      // Keeps the drawn stroke a constant *screen* width regardless of
      // the content layer's own CSS scale - without this, a wire looks
      // thicker at 250% zoom and hairline-thin at 25%.
      line.setAttribute("vector-effect", "non-scaling-stroke");
      this.svg.appendChild(line);
    }
  }

  private endpoint(ref: PinRef): { x: number; y: number } | null {
    const pos = this.getEntityPosition(ref.entityId);
    const offset = this.pinOffsets.get(pinKey(ref.entityId, ref.pin));
    if (!pos || !offset) return null;
    return { x: pos.x + offset.x, y: pos.y + offset.y };
  }
}

function pinKey(entityId: string, pin: string): string {
  return `${entityId}:${pin}`;
}
