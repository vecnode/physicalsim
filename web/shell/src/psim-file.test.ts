import { describe, expect, it } from "vitest";
import { parsePsimFile, sanitizeFileName, PsimParseError, type PsimFile } from "./psim-file.js";

// buildPsimFile()/applyPsimFile() take a real CanvasController (Scene +
// Viewport + real DOM elements) and aren't exercised here - this project's
// vitest environment is "node", not jsdom (see ../vitest.config.ts), and
// standing one up just for this would be a bigger, separate change. What's
// covered here is the part that's both pure and the riskiest to get
// wrong by hand: the file-shape validation parsePsimFile() gates every
// load on, and the filename sanitizer downloadPsimFile() relies on.
function validPsim(): PsimFile {
  return {
    psimVersion: 1,
    savedAt: new Date().toISOString(),
    name: "test circuit",
    circuit: {
      boards: [{ id: "board-1", type: "arduino-uno", adapterId: "avr8", x: 0, y: 0, powered: false, rotation: 0 }],
      components: [{ id: "component-1", type: "led", x: 100, y: 0, rotation: 0 }],
    },
    wires: [{ a: { entityId: "board-1", pin: "13" }, b: { entityId: "component-1", pin: "A" } }],
    sketch: "void setup() {}\nvoid loop() {}",
  };
}

describe("parsePsimFile", () => {
  it("parses a well-formed file", () => {
    const psim = validPsim();
    const parsed = parsePsimFile(JSON.stringify(psim));
    expect(parsed).toEqual(psim);
  });

  it("accepts a wire with a custom elbow route", () => {
    const psim = validPsim();
    psim.wires[0].elbow = { midX: 42 };
    const parsed = parsePsimFile(JSON.stringify(psim));
    expect(parsed.wires[0].elbow).toEqual({ midX: 42 });
  });

  it("rejects invalid JSON", () => {
    expect(() => parsePsimFile("{not json")).toThrow(PsimParseError);
  });

  it("rejects a non-object JSON value", () => {
    expect(() => parsePsimFile("42")).toThrow(PsimParseError);
  });

  it("rejects an unsupported psimVersion", () => {
    const psim = { ...validPsim(), psimVersion: 2 };
    expect(() => parsePsimFile(JSON.stringify(psim))).toThrow(/unsupported \.psim version/);
  });

  it("rejects a missing circuit.boards/components", () => {
    const psim = validPsim() as unknown as Record<string, unknown>;
    delete (psim.circuit as Record<string, unknown>).boards;
    expect(() => parsePsimFile(JSON.stringify(psim))).toThrow(/circuit\.boards/);
  });

  it("rejects a wire missing pin references", () => {
    const psim = validPsim() as unknown as { wires: unknown[] };
    psim.wires = [{ a: { entityId: "board-1" } }]; // missing `pin` and `b`
    expect(() => parsePsimFile(JSON.stringify(psim))).toThrow(/wire entry/);
  });

  it("rejects a missing sketch field", () => {
    const psim = validPsim() as unknown as Record<string, unknown>;
    delete psim.sketch;
    expect(() => parsePsimFile(JSON.stringify(psim))).toThrow(/wires\/sketch/);
  });
});

describe("sanitizeFileName", () => {
  it("keeps alphanumeric/dash/underscore/space names as-is", () => {
    expect(sanitizeFileName("my-circuit_v2 final")).toBe("my-circuit_v2 final");
  });

  it("strips path-breaking and special characters", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("etcpasswd");
    expect(sanitizeFileName('weird:"name"?.psim')).toBe("weirdnamepsim");
  });

  it("falls back to a default name when nothing valid remains", () => {
    expect(sanitizeFileName("***")).toBe("circuit");
    expect(sanitizeFileName("   ")).toBe("circuit");
  });
});
