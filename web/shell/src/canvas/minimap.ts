import type { Viewport } from "./viewport.js";

// A small top-down overview of the whole scene, stacked above the zoom
// controls (same rendered width - see syncSize()). Lets you see
// everything at once while zoomed in, and click/drag on it to jump the
// real canvas there instead of dragging the (possibly much larger, once
// zoomed in) main view directly.
export interface MinimapItem {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_HEIGHT = 40;
const MAX_HEIGHT = 160;

export class Minimap {
  private transform = { scale: 1, offsetX: 0, offsetY: 0, minX: 0, minY: 0 };
  private dragging = false;

  constructor(
    private readonly panelEl: HTMLElement,
    private readonly itemsEl: HTMLElement,
    private readonly viewportRectEl: HTMLElement,
    // Whatever element the minimap's own width should mirror - the zoom
    // controls row, not a hardcoded number kept in sync by hand.
    private readonly widthReferenceEl: HTMLElement,
    // The real canvas viewport - used for its own aspect ratio (minimap
    // height) and as the "base" world frame (see render()'s doc comment).
    private readonly canvasContainer: HTMLElement,
    private readonly viewport: Viewport,
    private readonly getItems: () => MinimapItem[],
  ) {
    this.panelEl.addEventListener("mousedown", (ev) => this.startDrag(ev));
    window.addEventListener("mousemove", (ev) => this.continueDrag(ev));
    window.addEventListener("mouseup", () => {
      this.dragging = false;
    });

    // widthReferenceEl's width is what syncSize() mirrors - watching it
    // directly (rather than e.g. the whole workspace) catches
    // sidebar/panel resizes that change how much room the controls row
    // needs.
    new ResizeObserver(() => {
      this.syncSize();
      this.render();
    }).observe(this.widthReferenceEl);

    // Re-render on every zoom/pan change (background-drag pan, minimap's
    // own pan, zoom buttons/wheel) - one subscription covers all of them,
    // since they all funnel through Viewport's apply().
    viewport.onChange(() => this.render());
  }

  // Matches the minimap's width to widthReferenceEl's own rendered width,
  // and derives its height from the canvas viewport's own aspect ratio so
  // the minimap isn't a stretched/squashed view of it.
  syncSize(): void {
    const width = this.widthReferenceEl.getBoundingClientRect().width;
    if (width === 0) return; // hidden (inactive tab, or chrome toggled off) - nothing to size against yet
    const canvasW = this.canvasContainer.clientWidth || 1;
    const canvasH = this.canvasContainer.clientHeight || 1;
    const height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round((width * canvasH) / canvasW)));
    this.panelEl.style.width = `${width}px`;
    this.panelEl.style.height = `${height}px`;
  }

  // Redraws the minimap from current state: one small rectangle per
  // placed item, plus a highlighted rectangle for whatever's currently
  // visible in the real canvas. "World" bounds are a *stable* frame - the
  // container's own base (100%-zoom) viewport unioned with every item's
  // extent (so dragging something outside the original view grows the
  // frame to include it) - deliberately NOT unioned with the
  // currently-visible viewport on every render. An earlier version did
  // include the live viewport in this union and, tested directly, that
  // made the whole frame constantly re-center on wherever you'd just
  // panned to (since the live viewport was always one of the extremes
  // defining it) - the opposite of what a minimap is for. Panning
  // somewhere with nothing placed correctly shows the viewport indicator
  // sliding toward (and clipping against, via the panel's own
  // overflow: hidden) the edge of a frame that stays put.
  render(): void {
    const baseW = this.canvasContainer.clientWidth || 1;
    const baseH = this.canvasContainer.clientHeight || 1;

    let minX = 0;
    let minY = 0;
    let maxX = baseW;
    let maxY = baseH;

    const items = this.getItems();
    for (const item of items) {
      minX = Math.min(minX, item.x);
      minY = Math.min(minY, item.y);
      maxX = Math.max(maxX, item.x + item.w);
      maxY = Math.max(maxY, item.y + item.h);
    }

    const worldW = Math.max(1, maxX - minX);
    const worldH = Math.max(1, maxY - minY);
    const mmW = this.panelEl.clientWidth || 1;
    const mmH = this.panelEl.clientHeight || 1;
    const scale = Math.min(mmW / worldW, mmH / worldH);
    // Centers the (possibly letterboxed, if the world's aspect ratio
    // doesn't match the panel's) content within the panel.
    const offsetX = (mmW - worldW * scale) / 2;
    const offsetY = (mmH - worldH * scale) / 2;

    this.transform = { scale, offsetX, offsetY, minX, minY };

    this.itemsEl.replaceChildren(
      ...items.map((item) => {
        const marker = document.createElement("div");
        marker.className = "minimap-item";
        marker.style.left = `${offsetX + (item.x - minX) * scale}px`;
        marker.style.top = `${offsetY + (item.y - minY) * scale}px`;
        marker.style.width = `${Math.max(2, item.w * scale)}px`;
        marker.style.height = `${Math.max(2, item.h * scale)}px`;
        return marker;
      }),
    );

    const visible = this.viewport.visibleWorldRect();
    this.viewportRectEl.style.left = `${offsetX + (visible.x - minX) * scale}px`;
    this.viewportRectEl.style.top = `${offsetY + (visible.y - minY) * scale}px`;
    this.viewportRectEl.style.width = `${visible.w * scale}px`;
    this.viewportRectEl.style.height = `${visible.h * scale}px`;
  }

  // Inverts render()'s last offset/scale to turn a mouse event's position
  // on the panel into a point in world coordinates.
  private eventToWorld(ev: MouseEvent): { x: number; y: number } {
    const rect = this.panelEl.getBoundingClientRect();
    const { scale, offsetX, offsetY, minX, minY } = this.transform;
    return {
      x: (ev.clientX - rect.left - offsetX) / scale + minX,
      y: (ev.clientY - rect.top - offsetY) / scale + minY,
    };
  }

  private startDrag(ev: MouseEvent): void {
    if (ev.button !== 0) return;
    this.dragging = true;
    const { x, y } = this.eventToWorld(ev);
    this.viewport.centerOn(x, y);
  }

  private continueDrag(ev: MouseEvent): void {
    if (!this.dragging) return;
    const { x, y } = this.eventToWorld(ev);
    this.viewport.centerOn(x, y);
  }
}
