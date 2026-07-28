import type { LitElement } from "lit";
import type { ElementPin } from "@wokwi/elements";
import {
  boardTagName,
  createBoard,
  createComponent,
  type Circuit,
  type CircuitBoard,
  type PlacedComponent,
} from "../circuit.js";
import { componentRegistry } from "../component-registry.js";
import { componentElectricalParams, getElectricalValue } from "@physicalsim/common";
import type { Viewport } from "./viewport.js";
import { WiringLayer, voltageColor, type Wire } from "./wiring.js";

type PlacedEntity = CircuitBoard | PlacedComponent;

interface DomEntry {
  wrapper: HTMLElement;
  boardEl: HTMLElement;
  dispose: () => void;
}

export interface MinimapItem {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Owns everything about "what's placed on the canvas": the circuit model
// (circuit.ts's plain, JSON-serializable CircuitBoard/PlacedComponent
// data), the DOM it's rendered as, drag/select/delete interaction, pin
// markers, and the wiring layer between pins. Deliberately the one place
// that knows how a board/component goes from "a type string" to "a real
// element on screen" - CanvasController composes this with Viewport/
// Minimap/ContextMenu but doesn't reach into its internals.
export class Scene {
  circuit: Circuit = { boards: [], components: [] };
  readonly wiring: WiringLayer;

  private readonly dom = new Map<string, DomEntry>();
  private selectedWrapper: HTMLElement | null = null;
  private selectedPin: HTMLElement | null = null;
  private changeListeners: Array<() => void> = [];
  private pinSelectListeners: Array<(pin: string | null) => void> = [];
  private deleteListeners: Array<(entity: PlacedEntity) => void> = [];
  private boardPlacedListeners: Array<(board: CircuitBoard) => void> = [];

  // Whether the rotate handle (the rotate-btn's whole job now - see
  // toggleRotateHandleMode()) is currently armed. Persists across
  // selection changes: turning it on shows the handle on whatever's
  // selected right now (if anything), and it keeps following selection
  // changes until turned off again.
  private rotateHandleMode = false;
  private rotateHandleEl: HTMLElement | null = null;
  private rotateTrajectoryEl: HTMLElement | null = null;

  constructor(
    container: HTMLElement,
    private readonly content: HTMLElement,
    private readonly viewport: Viewport,
  ) {
    this.wiring = new WiringLayer(
      content,
      (id) => this.entityFrame(id),
      viewport,
      // A wire being selected clears whatever board/pin was selected -
      // only one kind of thing is ever selected at a time. Pure state
      // updates only (no wiring.clearSelection() call here), unlike
      // selectItem()/selectPin() below - this callback runs *from
      // inside* a wire selection, so clearing the wire's own selection
      // back out again would immediately undo it.
      () => {
        this.selectedWrapper?.classList.remove("selected");
        this.selectedWrapper = null;
        this.selectedPin?.classList.remove("selected");
        this.selectedPin = null;
      },
    );
    // Click on the container background (not a placed item - its own
    // onMouseDown in makeDraggable() stops propagation) deselects
    // everything: the board/component, whatever pin marker might be
    // selected, and any selected wire.
    container.addEventListener("mousedown", () => {
      this.selectItem(null);
      this.selectPin(null);
      this.wiring.clearSelection();
    });
  }

  // Fired after any mutation a minimap/overview needs to know about
  // (placement, deletion, drag, scene reset) - Viewport's own onChange
  // already covers pan/zoom, this is the scene-content equivalent.
  onChange(cb: () => void): void {
    this.changeListeners.push(cb);
  }

  onPinSelect(cb: (pin: string | null) => void): void {
    this.pinSelectListeners.push(cb);
  }

  // Fired right before an entity's model/DOM is torn down (delete or
  // scene reset) - lets the caller react if the deleted entity mattered
  // to it (e.g. main.ts clearing activeAdapterId if the powered board
  // was just deleted).
  onEntityDeleted(cb: (entity: PlacedEntity) => void): void {
    this.deleteListeners.push(cb);
  }

  // Fired whenever a board (not a component - components have no
  // adapter) is placed via showBoard()/addBoardAt() - the hook main.ts
  // uses to "plug the board into its adapter" without Scene needing to
  // know anything about SimulatorAdapter/apply() itself.
  onBoardPlaced(cb: (board: CircuitBoard) => void): void {
    this.boardPlacedListeners.push(cb);
  }

  private notifyChange(): void {
    for (const cb of this.changeListeners) cb();
  }

  private allEntities(): PlacedEntity[] {
    return [...this.circuit.boards, ...this.circuit.components];
  }

  // What WiringLayer needs to place a pin's rotated world position: the
  // entity's own (unrotated) top-left position and rotation, plus its
  // wrapper's un-transformed layout size (offsetWidth/Height - a plain
  // layout property, unaffected by the CSS rotate()/scale() applied to
  // the wrapper or its ancestors, unlike getBoundingClientRect()) so
  // WiringLayer can rotate a pin's local offset around the wrapper's own
  // center the same way the CSS transform visually does.
  private entityFrame(
    id: string,
  ): { x: number; y: number; rotation: number; width: number; height: number } | undefined {
    const entity = this.allEntities().find((e) => e.id === id);
    const dom = this.dom.get(id);
    if (!entity || !dom) return undefined;
    return {
      x: entity.x,
      y: entity.y,
      rotation: entity.rotation,
      width: dom.wrapper.offsetWidth,
      height: dom.wrapper.offsetHeight,
    };
  }

  getDom(id: string): DomEntry | undefined {
    return this.dom.get(id);
  }

  findBoardByAdapter(adapterId: string): CircuitBoard | undefined {
    return this.circuit.boards.find((b) => b.adapterId === adapterId);
  }

  // Sets an already-placed entity's rotation directly, bypassing the
  // rotate-handle drag - for psim-file.ts's loader, restoring a saved
  // layout's rotation on a board/component that was just placed via
  // addBoardAt()/addComponentAt() (which always start at rotation 0, the
  // same way createBoard()/createComponent() do). Mirrors exactly what
  // startRotateDrag()'s own mousemove handler does to entity.rotation/the
  // wrapper's transform, minus the handle-follows-cursor math that only
  // matters mid-drag.
  setEntityRotation(entityId: string, rotationDeg: number): void {
    const dom = this.dom.get(entityId);
    const entity = this.allEntities().find((e) => e.id === entityId);
    if (!dom || !entity) return;
    entity.rotation = rotationDeg;
    dom.wrapper.style.transform = `rotate(${rotationDeg}deg)`;
    this.wiring.render();
    this.notifyChange();
  }

  // Rectangles for the minimap - in the scene's own world coordinates,
  // sized from the actual rendered element (divided by zoom to undo the
  // CSS scale, matching every other world-coordinate computation here).
  minimapItems(): MinimapItem[] {
    const items: MinimapItem[] = [];
    for (const entity of this.allEntities()) {
      const dom = this.dom.get(entity.id);
      if (!dom) continue;
      const rect = dom.wrapper.getBoundingClientRect();
      items.push({ x: entity.x, y: entity.y, w: rect.width / this.viewport.zoom, h: rect.height / this.viewport.zoom });
    }
    return items;
  }

  selectItem(wrapper: HTMLElement | null): void {
    this.selectedWrapper?.classList.remove("selected");
    this.selectedWrapper = wrapper;
    this.selectedWrapper?.classList.add("selected");
    this.updateRotateHandle();
  }

  // A second, independent selection from selectItem() above - selecting
  // a pin marker doesn't select (or deselect) the board it belongs to,
  // same way clicking a real board's pin header doesn't lift the board.
  selectPin(marker: HTMLElement | null): void {
    this.selectedPin?.classList.remove("selected");
    this.selectedPin = marker;
    this.selectedPin?.classList.add("selected");
    for (const cb of this.pinSelectListeners) cb(marker?.dataset.pin ?? null);
  }

  // Deletes whichever board/component is currently selected (Backspace/
  // Delete key handler, wired by CanvasController) - a no-op if nothing
  // is selected. Selecting a pin alone does not make it deletable; only
  // a placed board/component can be removed this way.
  deleteSelected(): boolean {
    if (!this.selectedWrapper) return false;
    const entry = [...this.dom.entries()].find(([, dom]) => dom.wrapper === this.selectedWrapper);
    if (!entry) return false;
    this.deleteEntity(entry[0]);
    return true;
  }

  // The rotate button's whole job now: arm/disarm the rotate handle (a
  // small draggable circle parked just outside the selection outline's
  // top-right corner - see updateRotateHandle()/startRotateDrag()
  // below), rather than performing a fixed 90-degree turn itself.
  // Returns the new mode, so the caller (main.ts) can reflect it in the
  // button's own pressed state.
  toggleRotateHandleMode(): boolean {
    this.rotateHandleMode = !this.rotateHandleMode;
    this.updateRotateHandle();
    return this.rotateHandleMode;
  }

  // Creates/repositions/removes the rotate handle to match current
  // state (mode on/off, what's selected). Called after every selection
  // change and after every drag-move of the selected entity (its center
  // - and so the handle's own position - moves with it), not just once.
  private updateRotateHandle(): void {
    if (!this.rotateHandleMode || !this.selectedWrapper) {
      this.rotateHandleEl?.remove();
      this.rotateHandleEl = null;
      return;
    }
    const entry = [...this.dom.entries()].find(([, dom]) => dom.wrapper === this.selectedWrapper);
    if (!entry) return;
    const [id] = entry;
    const entity = this.allEntities().find((e) => e.id === id);
    const wrapper = this.selectedWrapper;
    if (!entity) return;

    if (!this.rotateHandleEl) {
      const handle = document.createElement("div");
      handle.className = "rotate-handle";
      handle.title = "Drag to rotate";
      handle.addEventListener("mousedown", (ev) => this.startRotateDrag(ev, id));
      this.content.appendChild(handle);
      this.rotateHandleEl = handle;
    }
    this.positionRotateHandle(wrapper, entity);
  }

  // Where the handle sits, in the same unscaled "world" unit space
  // entity.x/y and wrapper.style.left/top already live in (content's
  // own CSS zoom transform handles the rest, same as every other
  // canvas coordinate here). Fixed 14px outside the wrapper's own
  // bounding box, diagonally - baseAngle is that direction's angle
  // *before* any rotation is applied; radius is its distance from
  // center, which stays constant as the entity spins (only the angle
  // changes) - together they're what makes the handle orbit the
  // entity's center along one consistent circle instead of jumping
  // around as the bounding box's own corner would.
  private static readonly ROTATE_HANDLE_MARGIN = 14;

  private handleGeometry(wrapper: HTMLElement): {
    centerX: number;
    centerY: number;
    radius: number;
    baseAngle: number;
  } {
    const w = wrapper.offsetWidth;
    const h = wrapper.offsetHeight;
    const left = parseFloat(wrapper.style.left) || 0;
    const top = parseFloat(wrapper.style.top) || 0;
    const centerX = left + w / 2;
    const centerY = top + h / 2;
    const dx = w / 2 + Scene.ROTATE_HANDLE_MARGIN;
    const dy = -(h / 2 + Scene.ROTATE_HANDLE_MARGIN);
    return { centerX, centerY, radius: Math.hypot(dx, dy), baseAngle: Math.atan2(dy, dx) };
  }

  private positionRotateHandle(wrapper: HTMLElement, entity: PlacedEntity): void {
    if (!this.rotateHandleEl) return;
    const { centerX, centerY, radius, baseAngle } = this.handleGeometry(wrapper);
    const angle = baseAngle + (entity.rotation * Math.PI) / 180;
    this.rotateHandleEl.style.left = `${centerX + radius * Math.cos(angle)}px`;
    this.rotateHandleEl.style.top = `${centerY + radius * Math.sin(angle)}px`;
  }

  // Drag-to-rotate: the entity's rotation continuously tracks the
  // cursor's *angle* around the entity's center (screenToWorld() undoes
  // pan/zoom the same way makeDraggable() does for plain dragging) -
  // deliberately ignoring the cursor's *distance* from center, so the
  // handle always stays exactly under the pointer regardless of how far
  // out the mouse drifts, the same posture Figma's own rotate handles
  // take. `baseAngle` is subtracted back out so entity.rotation is 0
  // exactly when the handle sits at its rest position (top-right,
  // unrotated).
  private startRotateDrag(ev: MouseEvent, entityId: string): void {
    ev.stopPropagation();
    ev.preventDefault();
    const dom = this.dom.get(entityId);
    const entity = this.allEntities().find((e) => e.id === entityId);
    if (!dom || !entity) return;
    const wrapper = dom.wrapper;
    const { centerX, centerY, radius, baseAngle } = this.handleGeometry(wrapper);

    // Trajectory guide - a dashed circle at the handle's own fixed
    // radius, illustrating the path it (and so the rotation) is
    // following. Only exists for the duration of this drag.
    const trajectory = document.createElement("div");
    trajectory.className = "rotate-trajectory";
    trajectory.style.left = `${centerX}px`;
    trajectory.style.top = `${centerY}px`;
    trajectory.style.width = `${radius * 2}px`;
    trajectory.style.height = `${radius * 2}px`;
    this.content.appendChild(trajectory);
    this.rotateTrajectoryEl = trajectory;

    const onMouseMove = (moveEv: MouseEvent): void => {
      const { x, y } = this.viewport.screenToWorld(moveEv.clientX, moveEv.clientY);
      const mouseAngle = Math.atan2(y - centerY, x - centerX);
      const rotationDeg = (((mouseAngle - baseAngle) * 180) / Math.PI + 360) % 360;
      entity.rotation = rotationDeg;
      wrapper.style.transform = `rotate(${rotationDeg}deg)`;
      this.positionRotateHandle(wrapper, entity);
      this.wiring.render();
      this.notifyChange();
    };

    const onMouseUp = (): void => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      this.rotateTrajectoryEl?.remove();
      this.rotateTrajectoryEl = null;
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  private deleteEntity(id: string): void {
    const entity = this.allEntities().find((e) => e.id === id);
    const dom = this.dom.get(id);
    if (!entity || !dom) return;

    for (const cb of this.deleteListeners) cb(entity);

    dom.dispose();
    dom.wrapper.remove();
    this.dom.delete(id);
    this.wiring.removeEntity(id);

    this.circuit.boards = this.circuit.boards.filter((b) => b.id !== id);
    this.circuit.components = this.circuit.components.filter((c) => c.id !== id);

    if (this.selectedWrapper === dom.wrapper) {
      this.selectedWrapper = null;
      this.updateRotateHandle();
    }
    this.notifyChange();
  }

  // Overlays one small clickable marker per pin on top of a placed
  // board, positioned from the element's own pinInfo (@wokwi/elements'
  // per-pin {name, x, y} coordinates) rather than any hardcoded-per-board
  // numbers, so this works for whatever board type is placed.
  //
  // pin.x/pin.y are plain CSS pixels of the rendered element, *not* the
  // element's own SVG viewBox units (confirmed against wokwi-elements'
  // own reference overlay, utils/show-pins-element.ts: its <svg> has no
  // viewBox at all - width/height 100% of the slotted element's rendered
  // box - and uses pin.x/pin.y directly as that SVG's cx/cy, i.e. as CSS
  // px). Since the wrapper is position:absolute (its own containing
  // block) and the board element is rendered at true intrinsic size (no
  // scaling), plain `${pin.x}px`/`${pin.y}px` lines a marker up with the
  // real pin regardless of zoom or devicePixelRatio.
  private overlayPinMarkers(entityId: string, wrapper: HTMLElement, boardEl: HTMLElement): void {
    const pinInfo = (boardEl as unknown as { pinInfo?: ElementPin[] }).pinInfo;
    if (!pinInfo) return;

    for (const pin of pinInfo) {
      const marker = document.createElement("div");
      marker.className = "pin-marker";
      marker.style.left = `${pin.x}px`;
      marker.style.top = `${pin.y}px`;
      marker.title = pin.name;
      marker.dataset.pin = pin.name;
      marker.dataset.entityId = entityId;
      this.wiring.registerPin(entityId, pin.name, pin.x, pin.y);

      // Stop both events from reaching the board wrapper/container - a
      // pin click should select/connect the pin, not start a board drag
      // or deselect the board underneath it.
      marker.addEventListener("mousedown", (ev) => {
        ev.stopPropagation();
        this.startPinDrag(entityId, pin.name, marker);
      });
      marker.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.selectPin(marker);
        this.wiring.clearSelection();
        this.wiring.handlePinClick(entityId, pin.name, marker);
      });
      wrapper.appendChild(marker);
    }
  }

  // Colors every currently-rendered pin marker by its own solved node
  // voltage, using the exact same blue->red scale (voltageColor(),
  // wiring.ts) a wire is already colored by - so "what voltage is this
  // pin at" reads the same way whether you're looking at the wire or the
  // pin it terminates at, instead of the wire being the only place this
  // app expresses voltage visually. `voltages` is keyed "entityId::pin",
  // matching the marker's own dataset.entityId/dataset.pin (set in
  // overlayPinMarkers() above) - called by AnalogNetChain after every
  // solve, with an empty map on reset()/a fresh example.
  //
  // A box-shadow glow rather than touching border-color/background
  // directly: those two properties are exactly what .pin-marker:hover/
  // .selected/.connecting (style.css) already use for interaction state,
  // and inline styles would otherwise permanently win over those classes'
  // rules (same specificity family, later/inline wins) - a hovered or
  // selected pin would stop looking hovered/selected the moment it also
  // had a solved voltage. box-shadow is untouched by any of those three
  // states, so the voltage glow and the interaction-state look coexist
  // instead of one clobbering the other.
  setPinVoltages(voltages: ReadonlyMap<string, number>): void {
    for (const { wrapper } of this.dom.values()) {
      for (const marker of wrapper.querySelectorAll<HTMLElement>(".pin-marker")) {
        const entityId = marker.dataset.entityId;
        const pin = marker.dataset.pin;
        const voltage = entityId && pin ? voltages.get(`${entityId}::${pin}`) : undefined;
        marker.style.boxShadow = voltage !== undefined ? `0 0 0 3px ${voltageColor(voltage)}` : "";
        marker.title = voltage !== undefined ? `${pin} - ${voltage.toFixed(2)} V` : (pin ?? "");
      }
    }
  }

  // Lets a connection be made in one motion (mousedown on a pin, drag,
  // release over a different pin) as an alternative to the existing
  // click-then-click flow (handlePinClick(), wired into the marker's own
  // "click" listener above) - that flow still works unchanged for a
  // plain click (mousedown and mouseup on the same marker always fire a
  // real "click" event, handled exactly as before). This only adds
  // behavior for the cross-element case a "click" event never covers:
  // mousedown on one marker, mouseup on a *different* one, which browsers
  // don't synthesize a click for at all. Bigger than a naive
  // mousemove/mouseup pair would need since .pin-marker's own hit area
  // (style.css) is already the intended drag *target* size - this reuses
  // that same hit-testing via elementFromPoint() at drop time rather than
  // computing its own hover radius.
  private startPinDrag(entityId: string, pin: string, marker: HTMLElement): void {
    const onMouseUp = (ev: MouseEvent): void => {
      window.removeEventListener("mouseup", onMouseUp);
      const target = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest(
        ".pin-marker",
      ) as HTMLElement | null;
      if (!target || target === marker) return; // same pin (plain click) or empty space (abandoned drag)
      const targetEntityId = target.dataset.entityId;
      const targetPin = target.dataset.pin;
      if (!targetEntityId || !targetPin) return;
      // A drag-completed connection supersedes whatever click-flow might
      // still be pending (e.g. a pin clicked earlier, then abandoned in
      // favor of this drag) - left as-is it would sit there glowing
      // ".connecting" with no way to tell it's now stale.
      this.wiring.cancelPending();
      this.wiring.clearSelection();
      this.wiring.connect({ entityId, pin }, { entityId: targetEntityId, pin: targetPin });
    };
    window.addEventListener("mouseup", onMouseUp);
  }

  // Wires drag on one placed item's wrapper. Returns a dispose function
  // so clearScene()/deleteEntity() can clean up the window-level
  // listeners, rather than leaking a new pair every time. Also keeps
  // `entity`'s x/y in sync as the DOM moves - the model doesn't derive
  // position after the fact, it's updated right alongside the style that
  // actually renders it.
  private makeDraggable(wrapper: HTMLElement, entity: PlacedEntity): () => void {
    let dragOffset: { dx: number; dy: number } | null = null;

    const onMouseDown = (ev: MouseEvent): void => {
      // Stop the container's own mousedown from treating this as a
      // background click and deselecting what we're about to select.
      ev.stopPropagation();
      this.selectItem(wrapper);
      this.wiring.clearSelection();
      const { x, y } = this.viewport.screenToWorld(ev.clientX, ev.clientY);
      dragOffset = { dx: x - wrapper.offsetLeft, dy: y - wrapper.offsetTop };
      wrapper.classList.add("dragging");
    };

    const onMouseMove = (ev: MouseEvent): void => {
      if (!dragOffset) return;
      const { x, y } = this.viewport.screenToWorld(ev.clientX, ev.clientY);
      entity.x = x - dragOffset.dx;
      entity.y = y - dragOffset.dy;
      wrapper.style.left = `${entity.x}px`;
      wrapper.style.top = `${entity.y}px`;
      // Dragging can extend the world bounds the minimap draws, and any
      // wire attached to this entity needs its endpoint recomputed live,
      // not just once the drag ends. The rotate handle's own position is
      // center-relative too, so it needs the same live update - a no-op
      // if this isn't the entity the handle is currently attached to.
      this.wiring.render();
      this.updateRotateHandle();
      this.notifyChange();
    };

    const onMouseUp = (): void => {
      dragOffset = null;
      wrapper.classList.remove("dragging");
    };

    // Edits a component's real electrical value (a resistor's ohms, a
    // capacitor's farads - componentElectricalParams, @physicalsim/
    // common) via a plain prompt() - the same "no property panel exists
    // yet" posture psim-file.ts's Save-As name prompt already takes. A
    // no-op for anything else on the canvas (componentElectricalParams
    // has no entry for board types or non-electrical components, so
    // `spec` is undefined and this returns before touching anything).
    const onDoubleClick = (ev: MouseEvent): void => {
      const spec = componentElectricalParams[entity.type];
      if (!spec) return;
      ev.stopPropagation();
      const el = wrapper.firstElementChild as (HTMLElement & Record<string, unknown>) | null;
      if (!el) return;
      const component = entity as PlacedComponent;
      const current = getElectricalValue(entity.type, component.attrs);
      const input = window.prompt(`${spec.displayName} (${spec.unit}):`, String(current));
      if (input === null) return; // cancelled
      const parsed = Number(input);
      if (!Number.isFinite(parsed) || parsed <= 0) return; // silently ignored, same as an unparseable saved value
      component.attrs = { ...component.attrs, [spec.attrKey]: String(parsed) };
      el[spec.attrKey] = String(parsed);
    };

    wrapper.addEventListener("mousedown", onMouseDown);
    wrapper.addEventListener("dblclick", onDoubleClick);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      wrapper.removeEventListener("mousedown", onMouseDown);
      wrapper.removeEventListener("dblclick", onDoubleClick);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }

  // Creates an element at its true size (SVG intrinsic size, browser-
  // rendered - never scaled to fit), positions it, wires dragging and pin
  // markers, and records it. Shared by boards and components (typed
  // against the union both satisfy) - a board backed by a
  // SimulatorAdapter and a bare sensor placed next to it are the same
  // kind of "thing on the canvas" as far as placement/dragging goes.
  private async placeElement(
    entity: PlacedEntity,
    tagName: string,
    center: { x: number; y: number } | null,
    // Element-specific properties to set before the first render (e.g.
    // wokwi-led's "color") - a plain Lit @property, not something
    // component-registry.ts's tag lookup knows about, so it's set here
    // rather than baked into the registry. Optional and rare: only an
    // Example's build() (main.ts) uses this today, to tell otherwise-
    // identical LEDs apart (a traffic light's red/yellow/green).
    attrs?: Record<string, string>,
  ): Promise<void> {
    const wrapper = document.createElement("div");
    wrapper.className = "board-item";
    const boardEl = document.createElement(tagName);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) boardEl.setAttribute(key, value);
    }
    wrapper.appendChild(boardEl);
    this.content.appendChild(wrapper);
    // A newly-appended wrapper is now the content layer's last child,
    // which would otherwise paint over the wire layer - re-assert that
    // wires stay drawn on top of every board/component, not just the
    // ones placed before this one.
    this.wiring.raiseToTop();

    // LitElement's first render happens on a microtask after connect,
    // not synchronously on appendChild - measuring immediately would see
    // an empty (zero-size) shadow DOM and center against the wrong size.
    await (boardEl as unknown as LitElement).updateComplete;

    // getBoundingClientRect() reflects the content layer's current CSS
    // scale, so both rects are divided by zoom here to get back to the
    // same unscaled unit space entity.x/y and wrapper.style live in.
    const itemRect = wrapper.getBoundingClientRect();
    const zoom = this.viewport.zoom;
    const itemW = itemRect.width / zoom;
    const itemH = itemRect.height / zoom;
    if (center) {
      entity.x = Math.max(0, center.x - itemW / 2);
      entity.y = Math.max(0, center.y - itemH / 2);
    } else {
      const containerRect = this.content.getBoundingClientRect();
      entity.x = Math.max(0, (containerRect.width / zoom - itemW) / 2);
      entity.y = Math.max(0, (containerRect.height / zoom - itemH) / 2);
    }
    wrapper.style.left = `${entity.x}px`;
    wrapper.style.top = `${entity.y}px`;

    const dispose = this.makeDraggable(wrapper, entity);
    this.overlayPinMarkers(entity.id, wrapper, boardEl);
    this.dom.set(entity.id, { wrapper, boardEl, dispose });
    this.notifyChange();
  }

  // Tears down every currently-placed board/component (drag listeners +
  // DOM + wires) before starting a fresh scene. Removes each wrapper
  // individually rather than this.content.replaceChildren() - the wire
  // layer (canvas/wiring.ts's WiringLayer) is also a child of
  // this.content, inserted once at construction and never re-added, so
  // wiping every child here would silently delete it from the DOM for
  // the rest of the session (caught during verification: wiring stopped
  // working entirely after the first Apply, since showBoard() always
  // calls this first).
  clearScene(): void {
    for (const dom of this.dom.values()) {
      dom.dispose();
      dom.wrapper.remove();
    }
    this.dom.clear();
    this.selectItem(null);
    this.selectPin(null);
    this.wiring.reset();
    this.notifyChange();
  }

  // Replaces whatever was already placed - Apply always starts a fresh
  // scene rather than stacking duplicate boards on repeated clicks.
  async showBoard(type: string): Promise<CircuitBoard | null> {
    const tagName = boardTagName[type];
    const board = createBoard(type);
    if (!tagName || !board) return null;

    this.clearScene();
    this.circuit = { boards: [board], components: [] };
    await this.placeElement(board, tagName, null);
    for (const cb of this.boardPlacedListeners) cb(board);
    return board;
  }

  // Adds a board alongside whatever's already placed, centered on
  // (x, y) in world coordinates - the canvas's right-click "add
  // component" flow, unlike showBoard()/Apply which always replaces the
  // scene.
  async addBoardAt(type: string, x: number, y: number): Promise<CircuitBoard | null> {
    const tagName = boardTagName[type];
    const board = createBoard(type);
    if (!tagName || !board) return null;

    this.circuit.boards.push(board);
    await this.placeElement(board, tagName, { x, y });
    for (const cb of this.boardPlacedListeners) cb(board);
    return board;
  }

  // Adds a sensor/connection part (component-registry.ts) alongside
  // whatever's already placed. Components aren't backed by any
  // SimulatorAdapter and have no power state; they're purely placed on
  // the canvas for now (see PlacedComponent's doc comment in circuit.ts).
  async addComponentAt(
    type: string,
    x: number,
    y: number,
    attrs?: Record<string, string>,
  ): Promise<PlacedComponent | null> {
    const tagName = componentRegistry[type]?.tagName;
    const component = createComponent(type, attrs);
    if (!tagName || !component) return null;

    this.circuit.components.push(component);
    await this.placeElement(component, tagName, { x, y }, attrs);
    return component;
  }
}

export type { Wire };
