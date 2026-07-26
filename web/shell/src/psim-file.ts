// Save/load a whole session - the placed circuit, its wiring, and the
// sketch that goes with it - as one ".psim" file. Deliberately a thin
// serializer around data structures that already exist (Scene.circuit,
// WiringLayer.getWires(), the sketch editor's own text), not a second
// representation of the circuit: saving is "read what's already there and
// write it out," loading is "replace what's there with what's in the
// file," reusing the exact same addBoardAt()/addComponentAt()/connect()
// calls a right-click placement or an Example's build() already uses.
//
// A built-in Example (main.ts's EXAMPLES table) and a user's own saved
// circuit are the same shape on disk - Examples aren't a separate format,
// they're just circuits that happen to ship with the app; exporting one
// via "Save .psim…" round-trips cleanly through the same loader below.
import type { AdapterId } from "./adapter-registry.js";
import type { Circuit, CircuitBoard, PlacedComponent } from "./circuit.js";
import type { CanvasController } from "./canvas/index.js";
import type { PinRef, ElbowRoute } from "./canvas/wiring.js";
import type { SketchEditor } from "./sketch-editor.js";

// Bumped only if a future, incompatible change to this shape is needed -
// parsePsimFile() rejects anything else outright rather than guessing how
// to interpret an unknown shape.
const PSIM_VERSION = 1;

interface SerializedWire {
  a: PinRef;
  b: PinRef;
  // Only present if the user actually dragged one of the elbow style's
  // three handles away from its default (see wiring.ts's ElbowRoute) -
  // omitted entirely otherwise, so a straight/bezier-only circuit's file
  // doesn't carry meaningless empty {} noise per wire.
  elbow?: ElbowRoute;
}

export interface PsimFile {
  psimVersion: typeof PSIM_VERSION;
  savedAt: string;
  name: string;
  circuit: Circuit;
  wires: SerializedWire[];
  sketch: string;
}

export class PsimParseError extends Error {}

// What applying a loaded file actually did, beyond "it worked" - main.ts
// reports this to the terminal so a file referencing a board/component
// type this build doesn't know about (e.g. saved by a newer version of the
// app) fails partially and visibly, not silently.
export interface ApplyPsimResult {
  boardsPlaced: number;
  componentsPlaced: number;
  wiresConnected: number;
  skippedBoardTypes: string[];
  skippedComponentTypes: string[];
  skippedWires: number;
}

function isElbowRoute(v: unknown): v is ElbowRoute {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    (r.midX === undefined || typeof r.midX === "number") &&
    (r.legAY === undefined || typeof r.legAY === "number") &&
    (r.legBY === undefined || typeof r.legBY === "number")
  );
}

function isPinRef(v: unknown): v is PinRef {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.entityId === "string" && typeof r.pin === "string";
}

// Builds a PsimFile from whatever's currently placed/wired/typed - the
// live Scene.circuit array and WiringLayer.getWires() are read once here,
// not held onto, so mutating the canvas afterward can't retroactively
// change an already-built file.
export function buildPsimFile(canvas: CanvasController, sketch: string, name: string): PsimFile {
  const wires: SerializedWire[] = canvas.scene.wiring.getWires().map((w) => {
    const hasCustomElbow = w.elbow.midX !== undefined || w.elbow.legAY !== undefined || w.elbow.legBY !== undefined;
    return { a: w.a, b: w.b, ...(hasCustomElbow ? { elbow: w.elbow } : {}) };
  });
  return {
    psimVersion: PSIM_VERSION,
    savedAt: new Date().toISOString(),
    name,
    // Structured-clone-shaped plain data (CircuitBoard[]/PlacedComponent[]
    // are already JSON-serializable by design - see circuit.ts's own doc
    // comment on why) - spread into fresh arrays/objects so the file is a
    // true snapshot, not a live reference into Scene.circuit.
    circuit: {
      boards: canvas.scene.circuit.boards.map((b) => ({ ...b })),
      components: canvas.scene.circuit.components.map((c) => ({ ...c, attrs: c.attrs ? { ...c.attrs } : undefined })),
    },
    wires,
    sketch,
  };
}

// A conservative filename sanitizer - strips anything that isn't
// alphanumeric/dash/underscore/space, so a name typed into a "Save As"
// prompt can't produce a path-breaking or OS-reserved filename.
export function sanitizeFileName(name: string): string {
  const cleaned = name.trim().replace(/[^a-zA-Z0-9 _-]/g, "").trim();
  return cleaned || "circuit";
}

// Triggers a browser download of `psim` as "<name>.psim" - plain JSON
// under a distinct extension, the same "it's just JSON, given a name and a
// version tag" posture the format was designed around. No native/C++
// involvement: this is a client-side Blob + <a download>, the same
// mechanism a File System Access API save would use if this project ever
// needed a native save dialog instead.
export function downloadPsimFile(psim: PsimFile): void {
  const blob = new Blob([JSON.stringify(psim, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${sanitizeFileName(psim.name)}.psim`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Parses and validates a .psim file's JSON text - deliberately strict
// (rejects anything not shaped like a PsimFile, rather than coercing best-
// effort) since this feeds directly into replacing the whole canvas;
// a malformed file should fail loudly here, not partway through
// applyPsimFile() with half a circuit already placed.
export function parsePsimFile(jsonText: string): PsimFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new PsimParseError("not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new PsimParseError("not a .psim file (expected a JSON object)");
  }
  const p = parsed as Record<string, unknown>;
  if (p.psimVersion !== PSIM_VERSION) {
    throw new PsimParseError(
      `unsupported .psim version (${String(p.psimVersion)}) - this build understands version ${PSIM_VERSION}`,
    );
  }
  const circuit = p.circuit as Record<string, unknown> | undefined;
  if (typeof circuit !== "object" || circuit === null || !Array.isArray(circuit.boards) || !Array.isArray(circuit.components)) {
    throw new PsimParseError("malformed .psim file (missing circuit.boards/components)");
  }
  if (!Array.isArray(p.wires) || typeof p.sketch !== "string") {
    throw new PsimParseError("malformed .psim file (missing wires/sketch)");
  }
  for (const w of p.wires) {
    const wire = w as Record<string, unknown>;
    if (!isPinRef(wire.a) || !isPinRef(wire.b) || (wire.elbow !== undefined && !isElbowRoute(wire.elbow))) {
      throw new PsimParseError("malformed .psim file (a wire entry is missing pin references)");
    }
  }
  return parsed as PsimFile;
}

// Replaces the whole scene with `psim`'s contents and returns what
// happened - the counterpart to loadExample() in main.ts, reusing the
// exact same placement primitives (addBoardAt/addComponentAt/wiring.connect)
// an Example's build() or the right-click menu already use, so a loaded
// circuit is indistinguishable on the canvas from one built by hand.
//
// Board/component ids are reassigned by addBoardAt()/addComponentAt() (the
// same "createBoard()/createComponent() mint a fresh id every time"
// convention this project already has) - `idMap` translates the file's own
// saved ids to the freshly-placed ones so wires (which reference entities
// by id) reconnect to the right, newly-placed elements rather than the
// stale ids the file was saved with.
export async function applyPsimFile(
  psim: PsimFile,
  canvas: CanvasController,
  sketchEditor: SketchEditor,
  stop: () => void,
): Promise<ApplyPsimResult> {
  // Mirrors loadExample()'s own reasoning: clearScene() (called by
  // canvas.scene below, indirectly, via each board's own replace-vs-add
  // path) tears down DOM/wiring directly without ever notifying whichever
  // adapter was running - stopping first (the exact same stopBtn.click()
  // loadExample() uses) guarantees a genuinely halted simulation, not a
  // background one still ticking against a board that's about to vanish.
  stop();
  canvas.scene.clearScene();

  const idMap = new Map<string, string>();
  const result: ApplyPsimResult = {
    boardsPlaced: 0,
    componentsPlaced: 0,
    wiresConnected: 0,
    skippedBoardTypes: [],
    skippedComponentTypes: [],
    skippedWires: 0,
  };

  for (const board of psim.circuit.boards) {
    const placed = await canvas.scene.addBoardAt(board.type, board.x, board.y);
    if (!placed) {
      result.skippedBoardTypes.push(board.type);
      continue;
    }
    idMap.set(board.id, placed.id);
    if (board.rotation) canvas.scene.setEntityRotation(placed.id, board.rotation);
    result.boardsPlaced++;
  }

  for (const component of psim.circuit.components) {
    const placed = await canvas.scene.addComponentAt(component.type, component.x, component.y, component.attrs);
    if (!placed) {
      result.skippedComponentTypes.push(component.type);
      continue;
    }
    idMap.set(component.id, placed.id);
    if (component.rotation) canvas.scene.setEntityRotation(placed.id, component.rotation);
    result.componentsPlaced++;
  }

  for (const wire of psim.wires) {
    const a = idMap.get(wire.a.entityId);
    const b = idMap.get(wire.b.entityId);
    // Either endpoint's entity failed to place (an unknown type, above) -
    // a wire pointing at nothing shouldn't be created, same as
    // WiringLayer.removeEntity()'s own "no dangling wire" invariant.
    if (!a || !b) {
      result.skippedWires++;
      continue;
    }
    const connected = canvas.scene.wiring.connect({ entityId: a, pin: wire.a.pin }, { entityId: b, pin: wire.b.pin });
    if (wire.elbow) Object.assign(connected.elbow, wire.elbow);
    result.wiresConnected++;
  }
  // connect() already re-renders per call; one more pass picks up any
  // elbow overrides applied after the fact above (mutating .elbow directly
  // doesn't re-trigger connect()'s own render()).
  canvas.scene.wiring.render();

  canvas.zoomToFit();
  sketchEditor.setValue(psim.sketch);
  return result;
}
