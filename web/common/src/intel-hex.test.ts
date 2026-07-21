import { describe, expect, it } from "vitest";
import { IntelHexParseError, parseIntelHex } from "./intel-hex.js";

// Every fixture below is a literal hex string, not generated via any
// shared encoding helper - a bug that canceled itself out between an
// encoder and this decoder would be worse than no test at all.
describe("parseIntelHex", () => {
  it("parses a single data record followed by EOF", () => {
    // :02 0000 00 02E4 18 - 2 bytes (0x02, 0xE4) at address 0
    // checksum: (0x100 - (0x02+0x00+0x00+0x00+0x02+0xE4 & 0xff)) & 0xff = 0x18
    const hex = [":0200000002E418", ":00000001FF"].join("\n");
    const { bytes, usedBytes } = parseIntelHex(hex, 16);
    expect(usedBytes).toBe(2);
    expect([...bytes.slice(0, 4)]).toEqual([0x02, 0xe4, 0xff, 0xff]);
  });

  it("fills everything the file doesn't specify with 0xff", () => {
    const hex = [":0200000002E418", ":00000001FF"].join("\n");
    const { bytes } = parseIntelHex(hex, 8);
    expect([...bytes]).toEqual([0x02, 0xe4, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  });

  it("applies an extended linear address record (type 04) to later data", () => {
    // :02 0000 04 0001 F9 - upper 16 bits of address become 0x0001
    // :02 0000 00 AABB 99 - 2 bytes at (0x0001 << 16) | 0x0000 = 0x10000
    const hex = [":020000040001F9", ":02000000AABB99", ":00000001FF"].join("\n");
    const { bytes, usedBytes } = parseIntelHex(hex, 0x10002);
    expect(usedBytes).toBe(0x10002);
    expect(bytes[0x10000]).toBe(0xaa);
    expect(bytes[0x10001]).toBe(0xbb);
  });

  it("rejects a record with a bad checksum", () => {
    const hex = [":0200000002E419", ":00000001FF"].join("\n"); // last byte should be 18, not 19
    expect(() => parseIntelHex(hex, 16)).toThrow(IntelHexParseError);
    expect(() => parseIntelHex(hex, 16)).toThrow(/checksum/);
  });

  it("rejects a line that doesn't start with ':'", () => {
    expect(() => parseIntelHex("0200000002E418", 16)).toThrow(/expected a line starting/);
  });

  it("rejects data that would exceed the given flash size", () => {
    const hex = [":0200000002E418", ":00000001FF"].join("\n");
    expect(() => parseIntelHex(hex, 1)).toThrow(/exceeds the 1-byte flash/);
  });

  it("rejects a file with no EOF record", () => {
    expect(() => parseIntelHex(":0200000002E418", 16)).toThrow(/missing end-of-file/);
  });

  it("rejects data appearing after an EOF record", () => {
    const hex = [":00000001FF", ":0200000002E418"].join("\n");
    expect(() => parseIntelHex(hex, 16)).toThrow(/after an end-of-file/);
  });

  it("ignores blank lines between records", () => {
    const hex = [":0200000002E418", "", ":00000001FF", ""].join("\n");
    expect(() => parseIntelHex(hex, 16)).not.toThrow();
  });
});
