import { describe, expect, it } from "vitest";
import { resolvePin } from "./board.js";
import { arduinoUno } from "./arduino-uno.js";
import { rp2040Board } from "./rp2040-board.js";

describe("resolvePin", () => {
  it("resolves known Arduino Uno pin names to avr8 pin ids", () => {
    expect(resolvePin(arduinoUno, "D13")).toBe("B5");
    expect(resolvePin(arduinoUno, "D0")).toBe("D0");
    expect(resolvePin(arduinoUno, "A0")).toBe("C0");
  });

  it("resolves known Pico pin names to rp2040 pin ids", () => {
    expect(resolvePin(rp2040Board, "GP2")).toBe("GP2");
    expect(resolvePin(rp2040Board, "LED")).toBe("GP25");
  });

  it("throws for unknown pin names", () => {
    expect(() => resolvePin(arduinoUno, "D99")).toThrow(/Unknown pin/);
    expect(() => resolvePin(rp2040Board, "GP99")).toThrow(/Unknown pin/);
  });
});
