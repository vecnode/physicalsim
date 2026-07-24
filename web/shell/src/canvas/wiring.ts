import type { Viewport } from "./viewport.js";

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
// the board/component wrappers already get. Only entity drags (and the
// elbow style's own corner drag) need this file to do anything (render()
// recomputes everything from current entity position + pin offset), not
// pan/zoom.
export interface PinRef {
  entityId: string;
  pin: string;
}

// What a wire endpoint needs to know about the entity it's attached to -
// its own (unrotated) top-left position, current rotation, and its
// wrapper's un-transformed layout size, so a pin's registered local
// offset can be rotated around the wrapper's own center the same way
// the CSS transform that actually rotates it on screen does (see
// endpoint() below). Supplied by the scene (canvas/scene.ts's
// entityFrame()), not computed here - this file has no DOM access to an
// entity's wrapper element at all.
export interface EntityFrame {
  x: number;
  y: number;
  rotation: number;
  width: number;
  height: number;
}

// How every wire is drawn - a global setting (LinkStyleToggle cycles it),
// not a per-wire choice: "how are links drawn" reads as one property of
// the canvas, not something you'd want a mix of at once.
export type LinkStyle = "straight" | "elbow" | "bezier";

// The elbow style's route is A -> (A.x, legAY) -> (midX, legAY) ->
// (midX, legBY) -> (B.x, legBY) -> B: five segments, but only the
// middle three (the two horizontal "legs" and the vertical "channel"
// between them) are ever independently dragged - the two short vertical
// stubs at each end exist purely so a leg's height can move without
// dragging the (fixed) pin itself, and collapse to zero length at their
// defaults (legAY === a.y, legBY === b.y), which is exactly what makes
// an un-dragged elbow wire look like a plain 3-segment "Z", not five.
// Each of the three free values is undefined until its own handle is
// dragged at least once, and then stays exactly where dropped - the same
// "stays where you drag it" rule as before, now per-segment instead of
// one shared corner.
export interface ElbowRoute {
  midX?: number;
  legAY?: number;
  legBY?: number;
}

export interface Wire {
  id: string;
  a: PinRef;
  b: PinRef;
  // Unused by "straight"/"bezier" styles.
  elbow: ElbowRoute;
}

const SVG_NS = "http://www.w3.org/2000/svg";

// The stroke/fill every wire renders in unless selected (selected always
// reads as white - see render()) - a global setting, same posture as
// LinkStyle above: "what color are cables drawn in" is one property of
// the canvas, not something you'd want a per-wire mix of by default.
// Exported so the palette panel (main.ts/index.html's #wire-color-panel)
// can offer it as one of its swatches, alongside eight others.
export const DEFAULT_WIRE_COLOR = "#ffd54a";

export class WiringLayer {
  private readonly svg: SVGSVGElement;
  private wires: Wire[] = [];
  private nextId = 1;
  private selectedWireId: string | null = null;
  private style: LinkStyle = "straight";
  private color = DEFAULT_WIRE_COLOR;

  // Set while one of the elbow style's three segment handles is being
  // dragged - a persistent window-level mousemove/mouseup (registered
  // once, in the constructor) reads/clears this, rather than attaching a
  // fresh listener pair per render() call the way a one-off drag handler
  // normally would; render() rebuilds every wire's DOM from scratch on
  // every call (including every mousemove while dragging), so listeners
  // attached *inside* render() would never get cleaned up and pile up
  // indefinitely.
  private dragging: { wireId: string; segment: keyof ElbowRoute } | null = null;

  // Pin-local offsets (the same pin.x/pin.y used to position the marker
  // itself, relative to its entity's wrapper) - registered by the scene
  // when it creates each pin marker, so a wire endpoint can be recomputed
  // as "entity position + pin offset" without reaching back into
  // @wokwi/elements' pinInfo itself.
  private readonly pinOffsets = new Map<string, { x: number; y: number }>();

  // The pin a click is waiting on a second click to connect to - null
  // when no connection is in progress.
  private pending: { entityId: string; pin: string; marker: HTMLElement } | null = null;

  // Fired whenever the wire *set* changes (added/removed/reset) - not on
  // every render() (dragging fires that constantly). This is the hook a
  // signal-chain layer (canvas/signal-net.ts) uses to know when to
  // re-resolve which pins are electrically linked, without needing to
  // poll getWires() itself.
  private wireChangeListeners: Array<() => void> = [];

  constructor(
    private readonly content: HTMLElement,
    private readonly getEntityFrame: (entityId: string) => EntityFrame | undefined,
    private readonly viewport: Viewport,
    // Fired when a wire is clicked/selected - the scene uses this to
    // clear its own board/pin selection, so only one kind of thing (a
    // board, a pin, or a wire) is ever selected at a time. Deliberately
    // a plain callback, not this file reaching into Scene directly.
    private readonly onWireSelected?: () => void,
  ) {
    this.svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
    this.svg.classList.add("wire-layer");
    // Appended last (not first) so the wire layer paints on top of every
    // placed board/component wrapper - raiseToTop() re-asserts this every
    // time a new item is placed (appendChild on an existing child moves
    // it), since a later-placed wrapper would otherwise end up above it.
    content.appendChild(this.svg);

    window.addEventListener("mousemove", (ev) => {
      if (!this.dragging) return;
      const wire = this.wires.find((w) => w.id === this.dragging?.wireId);
      if (!wire) return;
      const world = this.viewport.screenToWorld(ev.clientX, ev.clientY);
      // The middle (vertical) segment moves horizontally; both leg
      // (horizontal) segments move vertically - each handle only reads
      // the world coordinate matching its own segment's drag axis.
      wire.elbow[this.dragging.segment] = this.dragging.segment === "midX" ? world.x : world.y;
      this.render();
    });
    window.addEventListener("mouseup", () => {
      this.dragging = null;
    });
  }

  // Keeps the wire layer the last child of `content` - call after
  // appending a new board/component wrapper, so wires stay drawn on top
  // of everything rather than sliding back underneath the newest item.
  raiseToTop(): void {
    this.content.appendChild(this.svg);
  }

  getStyle(): LinkStyle {
    return this.style;
  }

  // Cycles straight -> elbow -> bezier -> straight - the link-style
  // toggle button's whole job. Applies to every existing wire immediately
  // (this.style is read fresh by render(), not baked into each Wire), not
  // just ones drawn after the click.
  cycleStyle(): LinkStyle {
    const order: LinkStyle[] = ["straight", "elbow", "bezier"];
    this.style = order[(order.indexOf(this.style) + 1) % order.length];
    this.render();
    return this.style;
  }

  getColor(): string {
    return this.color;
  }

  // Sets every wire's color - the palette panel's whole job. Applies to
  // every existing wire immediately (this.color is read fresh by
  // render(), not baked into each Wire), not just ones drawn after the
  // click - the same "one global setting" posture as cycleStyle() above.
  setColor(color: string): void {
    this.color = color;
    this.render();
  }

  registerPin(entityId: string, pin: string, x: number, y: number): void {
    this.pinOffsets.set(pinKey(entityId, pin), { x, y });
  }

  // Read-only snapshot of every wire currently drawn - what a signal-chain
  // layer resolves into electrical links. Returns the live array (not a
  // copy): callers must not mutate it.
  getWires(): readonly Wire[] {
    return this.wires;
  }

  onWiresChanged(cb: () => void): void {
    this.wireChangeListeners.push(cb);
  }

  private notifyWiresChanged(): void {
    for (const cb of this.wireChangeListeners) cb();
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
    if (this.wires.length !== before) {
      if (this.selectedWireId && !this.wires.some((w) => w.id === this.selectedWireId)) {
        this.selectedWireId = null;
      }
      this.render();
      this.notifyWiresChanged();
    }
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
      elbow: {},
    };
    this.cancelPending();
    this.wires.push(wire);
    this.render();
    this.notifyWiresChanged();
  }

  // Connects two pins directly, bypassing the click-click pending flow
  // above - for callers that already know both endpoints (e.g. main.ts's
  // example loader, wiring up a freshly-placed board/component pair
  // without simulating two pin clicks). Requires both pins' offsets to
  // already be registered (i.e. both entities' placeElement() has
  // resolved) - same requirement handlePinClick's second click has,
  // just not enforced here since there's no marker to fail gracefully
  // against; callers are expected to await placement first.
  connect(a: PinRef, b: PinRef): Wire {
    const wire: Wire = { id: `wire-${this.nextId++}`, a, b, elbow: {} };
    this.wires.push(wire);
    this.render();
    this.notifyWiresChanged();
    return wire;
  }

  // Selects a wire (clicked - see render()'s hit-path handler), clearing
  // any in-progress pending connection and notifying the scene to drop
  // its own board/pin selection.
  private selectWire(id: string): void {
    this.cancelPending();
    this.selectedWireId = id;
    this.onWireSelected?.();
    this.render();
  }

  // Called by the scene whenever a board or pin gets selected, so
  // selecting one of those clears a previously-selected wire - only one
  // kind of thing is ever selected at once.
  clearSelection(): void {
    if (this.selectedWireId === null) return;
    this.selectedWireId = null;
    this.render();
  }

  // Removes whichever wire is currently selected - the Backspace/Delete
  // handler's wire counterpart to Scene.deleteSelected(). Returns false
  // (a no-op) if no wire is selected, so the caller can fall through to
  // trying a board/component delete instead.
  deleteSelectedWire(): boolean {
    if (this.selectedWireId === null) return false;
    this.wires = this.wires.filter((w) => w.id !== this.selectedWireId);
    this.selectedWireId = null;
    this.render();
    this.notifyWiresChanged();
    return true;
  }

  // Clears every wire and pending state - called when the scene is reset
  // (Apply replacing everything).
  reset(): void {
    const hadWires = this.wires.length > 0;
    this.wires = [];
    this.pinOffsets.clear();
    this.selectedWireId = null;
    this.dragging = null;
    this.cancelPending();
    this.render();
    if (hadWires) this.notifyWiresChanged();
  }

  // Resolves an elbow wire's three free values against their defaults -
  // the single place that defines "undragged looks like a plain Z"
  // (legAY === a.y, legBY === b.y collapse their stub segments to zero
  // length; midX defaults to the horizontal midpoint).
  private elbowRoute(
    a: { x: number; y: number },
    b: { x: number; y: number },
    wire: Wire,
  ): { midX: number; legAY: number; legBY: number } {
    return {
      midX: wire.elbow.midX ?? (a.x + b.x) / 2,
      legAY: wire.elbow.legAY ?? a.y,
      legBY: wire.elbow.legBY ?? b.y,
    };
  }

  // The SVG path data for one wire, in the current global style. Shared
  // by the hit-path and the visible path (both trace the same shape).
  private pathFor(a: { x: number; y: number }, b: { x: number; y: number }, wire: Wire): string {
    if (this.style === "elbow") {
      const { midX, legAY, legBY } = this.elbowRoute(a, b, wire);
      return (
        `M ${a.x} ${a.y} L ${a.x} ${legAY} L ${midX} ${legAY} ` +
        `L ${midX} ${legBY} L ${b.x} ${legBY} L ${b.x} ${b.y}`
      );
    }
    if (this.style === "bezier") {
      // A horizontal S-curve regardless of the endpoints' actual
      // orientation - simple, and reads as a smooth patch-cord curve
      // (MaxMSP/Pd's own style) in the common case without needing
      // user-placed control points.
      const dx = Math.max(30, Math.abs(b.x - a.x) * 0.5);
      return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
    }
    return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
  }

  // Recomputes every wire from current entity positions and the current
  // link style - call after any entity moves (drag), the style changes,
  // or a corner handle is dragged.
  render(): void {
    this.svg.replaceChildren();
    for (const wire of this.wires) {
      const a = this.endpoint(wire.a);
      const b = this.endpoint(wire.b);
      if (!a || !b) continue;
      const selected = wire.id === this.selectedWireId;
      const d = this.pathFor(a, b, wire);

      // A wide, invisible path for hit-testing (a 2px visible stroke is
      // hard to click precisely), tracing the exact same shape as the
      // visible one but layered under it. pointer-events: stroke (set in
      // CSS) means only this path's own stroke area is hit-testable, not
      // the whole (otherwise pointer-events: none) svg - clicks on empty
      // canvas still reach the board/background underneath.
      const hit = document.createElementNS(SVG_NS, "path");
      hit.setAttribute("d", d);
      hit.setAttribute("class", "wire-hit");
      hit.setAttribute("vector-effect", "non-scaling-stroke");
      // Stop both events from reaching the container background (which
      // would deselect) or starting a canvas pan drag.
      hit.addEventListener("mousedown", (ev) => ev.stopPropagation());
      hit.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.selectWire(wire.id);
      });

      const visible = document.createElementNS(SVG_NS, "path");
      visible.setAttribute("d", d);
      visible.setAttribute("class", selected ? "wire-line selected" : "wire-line");
      // Keeps the drawn stroke a constant *screen* width regardless of
      // the content layer's own CSS scale - without this, a wire looks
      // thicker at 250% zoom and hairline-thin at 25%.
      visible.setAttribute("vector-effect", "non-scaling-stroke");
      // Set inline (not left to .wire-line's CSS default) so the palette
      // panel's chosen color always wins - an inline style always beats
      // an external stylesheet rule at equal or lower specificity, which
      // a plain CSS class override wouldn't reliably do here. Selected
      // stays white regardless of the chosen color - the same "brighter,
      // this is what Backspace/Delete acts on" language .wire-endpoint.
      // selected already uses below.
      visible.style.stroke = selected ? "#ffffff" : this.color;

      this.svg.append(hit, visible);

      // A small terminal circle at each end, in every style - purely
      // decorative (pointer-events: none - the hit-path above already
      // covers clicking the wire).
      for (const point of [a, b]) {
        const dot = document.createElementNS(SVG_NS, "circle");
        dot.setAttribute("cx", String(point.x));
        dot.setAttribute("cy", String(point.y));
        dot.setAttribute("r", "3");
        dot.setAttribute("class", selected ? "wire-endpoint selected" : "wire-endpoint");
        dot.setAttribute("vector-effect", "non-scaling-stroke");
        dot.style.fill = selected ? "#ffffff" : this.color;
        this.svg.appendChild(dot);
      }

      // The elbow style's three draggable segment handles - one per
      // "axis" (both horizontal legs, and the vertical channel between
      // them), each at the midpoint of the segment it drags. A leg
      // handle only moves vertically (it drags that leg's height);
      // the channel handle only moves horizontally (it drags the
      // channel's x) - see the mousemove handler in the constructor.
      // Only drawn for the *selected* wire - otherwise every elbow wire
      // on the canvas would be covered in handles at once, which reads
      // as noise rather than "this is what you can drag right now".
      if (this.style === "elbow" && selected) {
        const { midX, legAY, legBY } = this.elbowRoute(a, b, wire);
        this.addElbowHandle(wire, (a.x + midX) / 2, legAY, "legAY", "v");
        this.addElbowHandle(wire, midX, (legAY + legBY) / 2, "midX", "h");
        this.addElbowHandle(wire, (midX + b.x) / 2, legBY, "legBY", "v");
      }
    }
  }

  // Creates one draggable elbow-segment handle at (cx, cy). `axis`
  // is purely cosmetic (picks the ns-resize/ew-resize cursor matching
  // which direction dragging this handle actually moves the wire);
  // `segment` is which of the wire's three ElbowRoute values the drag
  // updates.
  private addElbowHandle(
    wire: Wire,
    cx: number,
    cy: number,
    segment: keyof ElbowRoute,
    axis: "h" | "v",
  ): void {
    const handle = document.createElementNS(SVG_NS, "circle");
    handle.setAttribute("cx", String(cx));
    handle.setAttribute("cy", String(cy));
    handle.setAttribute("r", "5");
    handle.setAttribute("class", `wire-handle wire-handle-${axis}`);
    handle.setAttribute("vector-effect", "non-scaling-stroke");
    handle.addEventListener("mousedown", (ev) => {
      ev.stopPropagation();
      this.selectWire(wire.id);
      this.dragging = { wireId: wire.id, segment };
    });
    this.svg.appendChild(handle);
  }

  // A pin's world position is its entity's top-left plus its registered
  // local offset, rotated around the wrapper's own center by the
  // entity's current rotation - matching the CSS transform: rotate()
  // that actually rotates the wrapper (and everything in it, including
  // the pin markers) on screen. Without this, a rotated board's wires
  // would still point at the pin's *unrotated* position, ignoring where
  // the pin marker visually ended up.
  private endpoint(ref: PinRef): { x: number; y: number } | null {
    const frame = this.getEntityFrame(ref.entityId);
    const offset = this.pinOffsets.get(pinKey(ref.entityId, ref.pin));
    if (!frame || !offset) return null;
    const rotated = rotateAround(offset, frame.width / 2, frame.height / 2, frame.rotation);
    return { x: frame.x + rotated.x, y: frame.y + rotated.y };
  }
}

// Rotates `point` clockwise by `degrees` around (cx, cy) - screen-space
// rotation (y grows downward), matching what CSS's rotate() does.
function rotateAround(
  point: { x: number; y: number },
  cx: number,
  cy: number,
  degrees: number,
): { x: number; y: number } {
  if (degrees === 0) return point;
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = point.x - cx;
  const dy = point.y - cy;
  return {
    x: cx + dx * cos - dy * sin,
    y: cy + dx * sin + dy * cos,
  };
}

function pinKey(entityId: string, pin: string): string {
  return `${entityId}:${pin}`;
}
