// Minimal Intel HEX (.hex) parser, used by both adapters to load firmware
// into their emulated flash/program memory. Independent of either simulator
// library's internal (unexported, demo-only) hex loaders.

export interface HexRecord {
  address: number;
  data: Uint8Array;
}

const RECORD_DATA = 0x00;
const RECORD_EOF = 0x01;
const RECORD_EXT_SEGMENT_ADDR = 0x02;
const RECORD_EXT_LINEAR_ADDR = 0x04;

export function parseIntelHex(hexText: string): HexRecord[] {
  const records: HexRecord[] = [];
  let upperAddress = 0;

  for (const rawLine of hexText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !line.startsWith(":")) continue;

    const bytes: number[] = [];
    for (let i = 1; i + 1 < line.length; i += 2) {
      bytes.push(parseInt(line.slice(i, i + 2), 16));
    }

    const byteCount = bytes[0];
    const addressLow = (bytes[1] << 8) | bytes[2];
    const recordType = bytes[3];
    const payload = bytes.slice(4, 4 + byteCount);

    if (recordType === RECORD_EOF) {
      break;
    } else if (recordType === RECORD_EXT_LINEAR_ADDR) {
      upperAddress = ((payload[0] << 8) | payload[1]) << 16;
    } else if (recordType === RECORD_EXT_SEGMENT_ADDR) {
      upperAddress = ((payload[0] << 8) | payload[1]) << 4;
    } else if (recordType === RECORD_DATA) {
      records.push({
        address: upperAddress + addressLow,
        data: new Uint8Array(payload),
      });
    }
  }

  return records;
}

// Writes parsed records into `target`, treating `targetBase` as the flash
// address that maps to target[0]. Records outside [targetBase, targetBase +
// target.length) are ignored.
export function loadIntelHex(hexText: string, target: Uint8Array, targetBase = 0): void {
  for (const record of parseIntelHex(hexText)) {
    const offset = record.address - targetBase;
    if (offset < 0 || offset >= target.length) continue;
    const end = Math.min(record.data.length, target.length - offset);
    target.set(record.data.subarray(0, end), offset);
  }
}
