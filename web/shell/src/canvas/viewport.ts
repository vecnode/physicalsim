// Owns zoom + pan for the canvas: a CSS transform (translate(panX, panY)
// scale(zoom)) applied to one content element, never to its container.
// Panning is deliberately its own translate term, not the container's
// native scrollLeft/scrollTop - tried scroll-based panning first (see
// git history) and found, by testing it directly, that a transform:
// scale()'d child does not reliably expand its parent's scrollable
// overflow region in this engine: scrollLeft assignments silently
// clamped to a few dozen px once zoomed in, nowhere near enough to reach
// the rest of the scene. translate() sidesteps that: panX/panY are plain
// state this class owns and can move however far it wants, not something
// the browser's scroll machinery has to agree to first.
//
// transform-origin: 0 0 on the content element (set in CSS, not here)
// keeps the math below simple: world point (0, 0) always maps to screen
// position (panX, panY) relative to the container, regardless of zoom.
export interface WorldPoint {
  x: number;
  y: number;
}

export interface WorldRect extends WorldPoint {
  w: number;
  h: number;
}

export interface ViewportOptions {
  minZoom: number;
  maxZoom: number;
  step: number;
}

export class Viewport {
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly step: number;

  zoom = 1;
  panX = 0;
  panY = 0;

  private changeListeners: Array<() => void> = [];

  constructor(
    private readonly container: HTMLElement,
    private readonly content: HTMLElement,
    options: ViewportOptions,
  ) {
    this.minZoom = options.minZoom;
    this.maxZoom = options.maxZoom;
    this.step = options.step;
  }

  // Notified after every zoom/pan change - the minimap is the only
  // current subscriber (it needs to redraw its viewport indicator), but
  // this is deliberately generic rather than a minimap-specific callback.
  onChange(cb: () => void): void {
    this.changeListeners.push(cb);
  }

  private apply(): void {
    this.content.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
    for (const cb of this.changeListeners) cb();
  }

  // Changes zoom while keeping the world point currently under
  // (clientX, clientY) at that same screen position - "zoom towards the
  // cursor" rather than towards wherever the world origin happens to
  // currently be on screen. Solves apply()'s screen = pan + world*zoom
  // for the new pan, holding the world point (derived from the *old*
  // pan/zoom) fixed at the same screen position under the new zoom.
  setZoomAt(clientX: number, clientY: number, next: number): void {
    const rect = this.container.getBoundingClientRect();
    const screenX = clientX - rect.left;
    const screenY = clientY - rect.top;
    const worldX = (screenX - this.panX) / this.zoom;
    const worldY = (screenY - this.panY) / this.zoom;

    this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, next));
    this.panX = screenX - worldX * this.zoom;
    this.panY = screenY - worldY * this.zoom;
    this.apply();
  }

  // Zooms centered on the viewport's own center - for callers with no
  // particular cursor position to anchor on (the +/- buttons, reset).
  setZoom(next: number): void {
    const rect = this.container.getBoundingClientRect();
    this.setZoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, next);
  }

  zoomBy(delta: number): void {
    this.setZoom(this.zoom + delta);
  }

  zoomAtBy(clientX: number, clientY: number, delta: number): void {
    this.setZoomAt(clientX, clientY, this.zoom + delta);
  }

  panBy(dx: number, dy: number): void {
    this.panX += dx;
    this.panY += dy;
    this.apply();
  }

  panTo(panX: number, panY: number): void {
    this.panX = panX;
    this.panY = panY;
    this.apply();
  }

  // Sets pan and zoom together in one apply() - unlike setZoomAt(), which
  // solves for pan while deliberately holding one specific world point
  // fixed under the cursor, a caller here has already computed both
  // values jointly (CanvasController.zoomToFit() below fits a whole
  // bounding box, not a single point) and just needs them applied
  // atomically rather than as two separate state changes.
  setPanZoom(panX: number, panY: number, zoom: number): void {
    this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, zoom));
    this.panX = panX;
    this.panY = panY;
    this.apply();
  }

  // Pans so (worldX, worldY) becomes the center of the visible viewport -
  // used by the minimap's click/drag-to-pan.
  centerOn(worldX: number, worldY: number): void {
    this.panX = this.container.clientWidth / 2 - worldX * this.zoom;
    this.panY = this.container.clientHeight / 2 - worldY * this.zoom;
    this.apply();
  }

  // Converts a point in screen space (event.clientX/Y) into the content
  // element's own unscaled "world" coordinates - the inverse of apply()'s
  // translate+scale, relative to the container's rect (which itself is
  // never transformed, so its rect is stable regardless of pan/zoom).
  screenToWorld(clientX: number, clientY: number): WorldPoint {
    const rect = this.container.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.panX) / this.zoom,
      y: (clientY - rect.top - this.panY) / this.zoom,
    };
  }

  // The world-space rectangle currently visible inside the container.
  visibleWorldRect(): WorldRect {
    return {
      x: -this.panX / this.zoom,
      y: -this.panY / this.zoom,
      w: this.container.clientWidth / this.zoom,
      h: this.container.clientHeight / this.zoom,
    };
  }

  // Plain wheel (no Ctrl/Cmd needed) zooms, one step per notch - the same
  // step +/- buttons use, centered on the cursor (zoomAtBy(), not
  // zoomBy()) so scrolling in on some part of the scene keeps that part
  // under the cursor instead of the zoom always anchoring on the same
  // spot regardless of where the mouse is. Panning has its own dedicated
  // gesture (background left-click-drag, wired by the caller), so wheel
  // is free to mean "zoom" exclusively on the container.
  bindWheelZoom(): void {
    this.container.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        this.zoomAtBy(ev.clientX, ev.clientY, ev.deltaY < 0 ? this.step : -this.step);
      },
      { passive: false },
    );
  }
}
