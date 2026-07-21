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
import type { Viewport } from "./viewport.js";
import { WiringLayer, type Wire } from "./wiring.js";

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

  constructor(
    container: HTMLElement,
    private readonly content: HTMLElement,
    private readonly viewport: Viewport,
  ) {
    this.wiring = new WiringLayer(content, (id) => this.entityPosition(id));
    // Click on the container background (not a placed item - its own
    // onMouseDown in makeDraggable() stops propagation) deselects both
    // the board/component and whatever pin marker might be selected.
    container.addEventListener("mousedown", () => {
      this.selectItem(null);
      this.selectPin(null);
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

  private entityPosition(id: string): { x: number; y: number } | undefined {
    const entity = this.allEntities().find((e) => e.id === id);
    return entity ? { x: entity.x, y: entity.y } : undefined;
  }

  getDom(id: string): DomEntry | undefined {
    return this.dom.get(id);
  }

  findBoardByAdapter(adapterId: string): CircuitBoard | undefined {
    return this.circuit.boards.find((b) => b.adapterId === adapterId);
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

    if (this.selectedWrapper === dom.wrapper) this.selectedWrapper = null;
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
      this.wiring.registerPin(entityId, pin.name, pin.x, pin.y);

      // Stop both events from reaching the board wrapper/container - a
      // pin click should select/connect the pin, not start a board drag
      // or deselect the board underneath it.
      marker.addEventListener("mousedown", (ev) => ev.stopPropagation());
      marker.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.selectPin(marker);
        this.wiring.handlePinClick(entityId, pin.name, marker);
      });
      wrapper.appendChild(marker);
    }
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
      // not just once the drag ends.
      this.wiring.render();
      this.notifyChange();
    };

    const onMouseUp = (): void => {
      dragOffset = null;
      wrapper.classList.remove("dragging");
    };

    wrapper.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      wrapper.removeEventListener("mousedown", onMouseDown);
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
  ): Promise<void> {
    const wrapper = document.createElement("div");
    wrapper.className = "board-item";
    const boardEl = document.createElement(tagName);
    wrapper.appendChild(boardEl);
    this.content.appendChild(wrapper);

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
  async addComponentAt(type: string, x: number, y: number): Promise<PlacedComponent | null> {
    const tagName = componentRegistry[type]?.tagName;
    const component = createComponent(type);
    if (!tagName || !component) return null;

    this.circuit.components.push(component);
    await this.placeElement(component, tagName, { x, y });
    return component;
  }
}

export type { Wire };
