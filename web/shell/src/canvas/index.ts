import { Viewport } from "./viewport.js";
import { Scene } from "./scene.js";
import { Minimap } from "./minimap.js";
import { ContextMenu } from "./context-menu.js";

export interface CanvasElements {
  container: HTMLElement; // #canvas-tab1 - the fixed, never-transformed viewport
  content: HTMLElement; // #tab1-content - pans/scales, holds every placed item
  zoomOutBtn: HTMLButtonElement;
  zoomInBtn: HTMLButtonElement;
  zoomResetBtn: HTMLButtonElement;
  zoomLevelEl: HTMLElement;
  minimapPanel: HTMLElement;
  minimapItems: HTMLElement;
  minimapViewport: HTMLElement;
  // Whatever element the minimap should mirror the width of - the zoom
  // controls row, kept as a separate ref rather than assumed from
  // zoomOutBtn's parent so the caller stays in control of the DOM shape.
  minimapWidthReference: HTMLElement;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 0.1;

// Matches .board-canvas-interactive's CSS grid background-size in
// style.css - kept in sync with zoom (see bindZoomControls()) so the
// grid visually scales in step with the content sitting on top of it,
// rather than staying a fixed size while boards/components shrink/grow.
const GRID_SIZE_CSS_PX = 20;

// Composes Viewport (pan/zoom) + Scene (placed boards/components + pin
// wiring) + Minimap + ContextMenu into the one interactive canvas tab -
// this is the single entry point the rest of the app (main.ts) talks to;
// nothing outside this module reaches into any of the pieces above
// directly. Also owns the interactions that don't belong to any one
// piece: background-drag panning (a Viewport concern, but the click
// needs to originate from the container, coordinated with Scene's own
// background-click deselect on the same element) and the Backspace/
// Delete-to-remove-selection keyboard shortcut (a Scene concern, but
// global keyboard handling doesn't belong inside Scene itself).
export class CanvasController {
  readonly viewport: Viewport;
  readonly scene: Scene;
  readonly minimap: Minimap;
  readonly contextMenu: ContextMenu;

  private readonly container: HTMLElement;

  constructor(el: CanvasElements) {
    this.container = el.container;
    this.viewport = new Viewport(el.container, el.content, {
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      step: ZOOM_STEP,
    });
    this.scene = new Scene(el.container, el.content, this.viewport);
    this.minimap = new Minimap(
      el.minimapPanel,
      el.minimapItems,
      el.minimapViewport,
      el.minimapWidthReference,
      el.container,
      this.viewport,
      () => this.scene.minimapItems(),
    );
    this.contextMenu = new ContextMenu(
      (type, x, y) => void this.scene.addBoardAt(type, x, y),
      (type, x, y) => void this.scene.addComponentAt(type, x, y),
    );

    this.scene.onChange(() => this.minimap.render());

    this.bindZoomControls(el);
    this.bindBackgroundPan();
    this.bindContextMenu();
    this.bindDeleteKey();
  }

  // Re-measures the minimap against the zoom controls row and redraws it
  // - call when tab1 becomes visible again after being display:none
  // (its ResizeObserver has nothing to observe while hidden).
  refresh(): void {
    this.minimap.syncSize();
    this.minimap.render();
  }

  // Pans/zooms so every currently-placed board/component fits inside the
  // container, with some breathing room around the edges - called once
  // after an Example finishes building (main.ts's loadExample()) so a
  // freshly-loaded circuit is immediately fully visible instead of
  // needing a manual zoom-out to see, say, a board placed off to one side
  // of a component wired to it. Reuses Scene.minimapItems() (already a
  // world-space {x, y, w, h} per placed entity, built for the minimap) as
  // the bounding-box source rather than a second measurement pass. A
  // no-op on an empty scene - there's no meaningful box to fit nothing
  // into, and the viewport should just stay wherever it already was.
  zoomToFit(padding = 60): void {
    const items = this.scene.minimapItems();
    if (items.length === 0) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const item of items) {
      minX = Math.min(minX, item.x);
      minY = Math.min(minY, item.y);
      maxX = Math.max(maxX, item.x + item.w);
      maxY = Math.max(maxY, item.y + item.h);
    }

    const boxW = maxX - minX + padding * 2;
    const boxH = maxY - minY + padding * 2;
    const rect = this.container.getBoundingClientRect();
    // Never zooms *in* past 100% for a single small board - min(..., 1) -
    // "fit everything" shouldn't also mean "blow up one lone LED to fill
    // the whole canvas"; it only ever zooms out to make room, same as a
    // real "zoom to fit" control in an image viewer or IDE minimap.
    const zoom = Math.min(
      this.viewport.maxZoom,
      Math.max(this.viewport.minZoom, Math.min(rect.width / boxW, rect.height / boxH, 1)),
    );
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    this.viewport.setPanZoom(rect.width / 2 - centerX * zoom, rect.height / 2 - centerY * zoom, zoom);
  }

  private bindZoomControls(el: CanvasElements): void {
    el.zoomOutBtn.addEventListener("click", () => this.viewport.zoomBy(-ZOOM_STEP));
    el.zoomInBtn.addEventListener("click", () => this.viewport.zoomBy(ZOOM_STEP));
    el.zoomResetBtn.addEventListener("click", () => this.viewport.setZoom(1));
    this.viewport.onChange(() => {
      const zoom = this.viewport.zoom;
      el.zoomLevelEl.textContent = `${Math.round(zoom * 100)}%`;
      el.container.style.backgroundSize = `${GRID_SIZE_CSS_PX * zoom}px ${GRID_SIZE_CSS_PX * zoom}px`;
      // The grid's own background-position, in lockstep with panX/panY -
      // without this, the grid only ever rescaled with zoom and stayed
      // visually fixed while dragging, since the container itself (which
      // owns the CSS background) is deliberately never transformed (see
      // viewport.ts's own doc comment - only #tab1-content pans/scales).
      // World (0, 0) maps to screen (panX, panY) the same way it does for
      // every placed item, so anchoring the pattern's origin there keeps
      // grid lines aligned with a dragged board's position, not just
      // moving at the same visual rate as it.
      el.container.style.backgroundPosition = `${this.viewport.panX}px ${this.viewport.panY}px`;
    });
    this.viewport.bindWheelZoom();
  }

  // Left-click-drag on the canvas background pans the view - a placed
  // item's own mousedown handler (Scene's makeDraggable()) already calls
  // stopPropagation(), so a mousedown that reaches the container is
  // always the background, never a drag on a board or component.
  private bindBackgroundPan(): void {
    let dragState: { startX: number; startY: number; startPanX: number; startPanY: number } | null = null;

    this.container.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      dragState = {
        startX: ev.clientX,
        startY: ev.clientY,
        startPanX: this.viewport.panX,
        startPanY: this.viewport.panY,
      };
      this.container.classList.add("panning");
    });

    window.addEventListener("mousemove", (ev) => {
      if (!dragState) return;
      this.viewport.panTo(
        dragState.startPanX + (ev.clientX - dragState.startX),
        dragState.startPanY + (ev.clientY - dragState.startY),
      );
    });

    window.addEventListener("mouseup", () => {
      if (!dragState) return;
      dragState = null;
      this.container.classList.remove("panning");
    });
  }

  private bindContextMenu(): void {
    this.container.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      // A new board/component's (x, y) is stored in world coordinates,
      // not raw screen pixels - the same conversion dragging uses.
      const { x, y } = this.viewport.screenToWorld(ev.clientX, ev.clientY);
      this.contextMenu.open(ev.clientX, ev.clientY, x, y);
    });
  }

  // Backspace/Delete removes whichever board/component or wire is
  // currently selected - a board/component is tried first since deleting
  // one already takes its wires with it (Scene.deleteSelected() ->
  // WiringLayer.removeEntity()); the wire case only applies when a wire
  // itself, not an endpoint's board, is what's selected. Skipped while
  // focus is inside a real form control (the adapter <select>, or any
  // future text input) so deleting text in a field doesn't also delete a
  // selected canvas item.
  private bindDeleteKey(): void {
    window.addEventListener("keydown", (ev) => {
      if (ev.key !== "Backspace" && ev.key !== "Delete") return;
      const active = document.activeElement;
      const tag = active?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (this.scene.deleteSelected() || this.scene.wiring.deleteSelectedWire()) {
        ev.preventDefault();
      }
    });
  }
}

export { Viewport } from "./viewport.js";
export { Scene } from "./scene.js";
export type { Wire } from "./wiring.js";
export { DEFAULT_WIRE_COLOR } from "./wiring.js";
