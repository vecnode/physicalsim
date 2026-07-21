// Parses Intel HEX (the format avr-gcc/avrdude produce and consume) into
// a flat byte image ready to write into flash - the format itself has
// nothing to do with any particular adapter, so this lives in
// web/common alongside the other adapter-agnostic pieces, not inside
// web/adapters/avr8. Deliberately produces plain bytes, not adapter-
// specific words: what a "byte at address N" means to the CPU it ends
// up in (little-endian word pairs, for AVR) is that adapter's own
// business (see Avr8Adapter.loadFirmware()), not this parser's.
//
// Reference: https://en.wikipedia.org/wiki/Intel_HEX - specifically the
// record types real toolchains actually emit for a single AVR/ARM
// image: 00 (data), 01 (end of file), 02/04 (extended segment/linear
// address, for images bigger than 64KB - typically absent for a 32KB
// ATmega328p image, but handled here rather than assumed away, since
// nothing about parsing a byte stream should silently assume its own
// size). 03/05 (start segment/linear address - where to jump to) are
// recognized and ignored: they say where execution *would* begin on
// real hardware, but avr8js's CPU always begins at word address 0
// regardless, the same way a fresh reset() already does.
export interface HexParseResult {
  // Sparse-filled flash image: 0xff (erased-flash state) everywhere
  // nothing in the file specified a byte, the file's own data
  // everywhere it did. Always exactly `maxBytes` long (the caller's
  // flash size), never larger.
  bytes: Uint8Array;
  // One past the highest byte address the file actually wrote to -
  // informational (surfaced in the UI as "loaded N bytes"), not used by
  // parsing itself.
  usedBytes: number;
}

const RECORD_DATA = 0x00;
const RECORD_EOF = 0x01;
const RECORD_EXTENDED_SEGMENT_ADDRESS = 0x02;
const RECORD_START_SEGMENT_ADDRESS = 0x03;
const RECORD_EXTENDED_LINEAR_ADDRESS = 0x04;
const RECORD_START_LINEAR_ADDRESS = 0x05;

export class IntelHexParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`Intel HEX line ${line}: ${message}`);
    this.name = "IntelHexParseError";
  }
}

// `maxBytes` is the target flash's actual size (not a made-up limit) -
// a file that writes past it is rejected outright rather than silently
// truncated, since a silently-truncated firmware image would boot into
// garbage with no indication why.
export function parseIntelHex(text: string, maxBytes: number): HexParseResult {
  const bytes = new Uint8Array(maxBytes).fill(0xff);
  let usedBytes = 0;
  let sawEof = false;
  // Only relevant for record types 02/04 - the high bits of the address
  // for any data record that follows, until the next one changes it.
  // Real toolchains emit at most one of these per address range switch,
  // not one per data record.
  let upperAddress = 0;

  const lines = text.split(/\r\n|\r|\n/);
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo].trim();
    if (line.length === 0) continue;
    if (sawEof) {
      throw new IntelHexParseError("data after an end-of-file record", lineNo + 1);
    }
    if (line[0] !== ":") {
      throw new IntelHexParseError(`expected a line starting with ':', got "${line[0]}"`, lineNo + 1);
    }

    const raw = line.slice(1);
    if (raw.length < 10 || raw.length % 2 !== 0) {
      throw new IntelHexParseError(`malformed record (wrong length: ${raw.length})`, lineNo + 1);
    }
    const byteAt = (i: number): number => {
      const hex = raw.slice(i * 2, i * 2 + 2);
      const value = Number.parseInt(hex, 16);
      if (Number.isNaN(value)) {
        throw new IntelHexParseError(`invalid hex digits "${hex}"`, lineNo + 1);
      }
      return value;
    };

    const byteCount = byteAt(0);
    const address = (byteAt(1) << 8) | byteAt(2);
    const recordType = byteAt(3);
    const expectedLength = 4 + byteCount + 1; // header + data + checksum, in bytes
    if (raw.length / 2 !== expectedLength) {
      throw new IntelHexParseError(
        `byte count ${byteCount} doesn't match record length`,
        lineNo + 1,
      );
    }

    let sum = 0;
    for (let i = 0; i < expectedLength; i++) sum += byteAt(i);
    if ((sum & 0xff) !== 0) {
      throw new IntelHexParseError("checksum mismatch", lineNo + 1);
    }

    switch (recordType) {
      case RECORD_DATA: {
        const base = (upperAddress << 16) + address;
        if (base + byteCount > maxBytes) {
          throw new IntelHexParseError(
            `data at 0x${base.toString(16)} exceeds the ${maxBytes}-byte flash`,
            lineNo + 1,
          );
        }
        for (let i = 0; i < byteCount; i++) bytes[base + i] = byteAt(4 + i);
        usedBytes = Math.max(usedBytes, base + byteCount);
        break;
      }
      case RECORD_EOF:
        sawEof = true;
        break;
      case RECORD_EXTENDED_SEGMENT_ADDRESS:
        // Segment address is in units of 16 bytes (a real-mode x86-style
        // segment), unlike RECORD_EXTENDED_LINEAR_ADDRESS's plain shift -
        // different encodings for the same idea, both handled since a
        // real toolchain could in principle emit either.
        upperAddress = (byteAt(4) << 8 | byteAt(5)) << 4;
        break;
      case RECORD_START_SEGMENT_ADDRESS:
      case RECORD_START_LINEAR_ADDRESS:
        // Where real hardware would start executing - avr8js always
        // starts at word address 0 regardless (see this file's own doc
        // comment), so there's nothing to do with this.
        break;
      case RECORD_EXTENDED_LINEAR_ADDRESS:
        upperAddress = (byteAt(4) << 8) | byteAt(5);
        break;
      default:
        throw new IntelHexParseError(`unsupported record type 0x${recordType.toString(16)}`, lineNo + 1);
    }
  }

  if (!sawEof) {
    throw new IntelHexParseError("missing end-of-file record", lines.length);
  }

  return { bytes, usedBytes };
}
