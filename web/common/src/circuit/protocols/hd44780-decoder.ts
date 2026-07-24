import type { CircuitPin } from "../circuit-pin.js";

// Decodes the real HD44780-in-4-bit-mode wire protocol (RS/E/D4-D7) into
// character-buffer updates - the display-side half of what a real
// LiquidCrystal-driven sketch produces on its pins. Board-agnostic by
// construction: it only ever talks to CircuitPin (read()/write()/
// onChange()), the same adapter-agnostic surface Led/Button already use,
// so this works unmodified against any current or future board/adapter
// (arduino-uno/avr8 today, anything wired through a BoardPinMap/PinClient
// tomorrow - an ESP32-over-QEMU board included, once that adapter
// implements real pin I/O) with zero changes here.
//
// Derived directly from simulators/LiquidCrystal/src/LiquidCrystal.cpp
// (the exact vendored source this project compiles sketches against),
// not from general HD44780 folklore - every design choice below cites
// the specific real-source behavior it depends on.
export interface Hd44780Pins {
  rs: CircuitPin;
  e: CircuitPin;
  d4: CircuitPin;
  d5: CircuitPin;
  d6: CircuitPin;
  d7: CircuitPin;
}

type PinKey = keyof Hd44780Pins;

// One instance per wired LCD - constructed by protocol-chain.ts once all
// six roles resolve to real board pins (see canvas/protocol-net.ts),
// disposed the moment any one of them stops being wired.
export class Hd44780Decoder {
  private readonly unsubscribes: Array<() => void> = [];
  // Live shadow of each pin's last known value, kept in sync purely by
  // onChange() (never a reactive read() at the moment E latches) -
  // pin I/O round-trips over an async Worker RPC (see
  // web/shell/src/canvas/signal-chain.ts's own reasoning for the same
  // choice), so a fresh read() triggered *by* E's edge could easily
  // resolve after the firmware has already moved on to the next nibble.
  // onChange events, by contrast, are guaranteed to arrive in the CPU's
  // own program order - the data pins' digitalWrite()s always happen
  // (and their change events are always sent) strictly before the E
  // pulse's own digitalWrite() calls (see write4bits() in the vendored
  // source: all four data lines are set, and only then is pulseEnable()
  // called) - so the shadow is always current by the time E's own
  // falling edge arrives.
  private readonly pinValues: Record<PinKey, number> = { rs: 0, e: 0, d4: 0, d5: 0, d6: 0, d7: 0 };

  // A 4-bit send() is always two nibble pulses (high nibble, then low -
  // see send()); this holds the first until the second arrives. null
  // between bytes.
  private pendingHighNibble: number | null = null;
  private pendingRs = 0;

  // HD44780 DDRAM address. Real row start addresses, computed exactly the
  // way LiquidCrystal::begin() computes them for *any* row count
  // (setRowOffsets(0x00, 0x40, 0x00 + cols, 0x40 + cols), called
  // unconditionally regardless of how many lines the display actually
  // has) - not a 2-row-specific hardcode, so this same formula is already
  // correct for wokwi-lcd2004's 20x4 layout too (rows 2/3 continuing from
  // rows 0/1's DDRAM at a `cols`-sized offset, the real, slightly odd
  // quirk of 4-line HD44780 displays, not a physicalsim simplification of
  // it).
  private readonly rowOffsets: number[];
  private ddramAddr = 0;
  // I/D bit (entry mode) - LCD_ENTRYLEFT (increment) is begin()'s own
  // default (_displaymode = LCD_ENTRYLEFT | LCD_ENTRYSHIFTDECREMENT).
  private entryIncrement = true;
  // D bit (display on/off, DISPLAYCONTROL) - begin()'s own default is
  // display() (DISPLAYON). When off, buffer contents are preserved but
  // rendered blank, matching a real LCD's backlit-but-blank behavior
  // rather than discarding what was written.
  private displayOn = true;

  private readonly buffer: Uint8Array;

  constructor(
    pins: Hd44780Pins,
    // Called after every command/character byte is applied - always the
    // full buffer (cloned, not the live one), so the caller (protocol-
    // chain.ts) can assign it wholesale to the placed element's own
    // `characters` property without the two ever aliasing the same array.
    private readonly onUpdate: (characters: Uint8Array) => void,
    // Matches whichever wokwi element this decoder is driving
    // (LCD1602Element.numCols/numRows or LCD2004Element's own override,
    // in simulators/wokwi-elements) - not a general HD44780 parameter on
    // its own, since the real chip's usable DDRAM/row layout depends on
    // which physical display is wired, and the caller (protocol-chain.ts)
    // already knows which one that is.
    private readonly cols = 16,
    private readonly rows = 2,
  ) {
    this.rowOffsets = [0x00, 0x40, cols, 0x40 + cols];
    this.buffer = new Uint8Array(cols * rows);
    (Object.entries(pins) as Array<[PinKey, CircuitPin]>).forEach(([key, pin]) => {
      // Seeds the shadow with whatever the pin already reads as, the same
      // "reflect reality immediately, not just after the next toggle"
      // reasoning Led's own constructor uses - harmless here even though
      // a mid-pulse read is meaningless, since real firmware always
      // starts every pin from a clean, low, not-yet-pulsing state.
      void pin.read().then((value) => {
        this.pinValues[key] = value;
      });
      this.unsubscribes.push(pin.onChange((value) => this.onPinValue(key, value)));
    });
  }

  private onPinValue(key: PinKey, value: number): void {
    const wasE = this.pinValues.e;
    this.pinValues[key] = value;
    // pulseEnable() always ends a pulse with E low (LOW -> HIGH -> LOW),
    // and never touches the data/RS lines while E is high - so latching
    // on this falling edge, using the shadow values above, always reads
    // the nibble/RS state the firmware actually intended.
    if (key === "e" && wasE === 1 && value === 0) {
      this.onNibbleLatched();
    }
  }

  private onNibbleLatched(): void {
    const nibble =
      (this.pinValues.d4 ? 0x1 : 0) |
      (this.pinValues.d5 ? 0x2 : 0) |
      (this.pinValues.d6 ? 0x4 : 0) |
      (this.pinValues.d7 ? 0x8 : 0);

    if (this.pendingHighNibble === null) {
      this.pendingHighNibble = nibble;
      this.pendingRs = this.pinValues.rs;
      return;
    }

    // send() sets RS once, before both nibbles of a byte - they always
    // share one RS value in real use. The one place unpaired nibbles
    // exist at all is begin()'s 4-bit-mode reset dance (four standalone
    // write4bits() calls: 0x3, 0x3, 0x3, 0x2, with RS already held low
    // throughout), which this pairing logic doesn't special-case: it
    // simply (mis)pairs them into two "bytes" (0x33, 0x32). Both, under
    // runCommand() below's real HD44780 priority decoding, resolve to
    // FUNCTION SET (bit 0x20 is the highest set bit in both) - a
    // deliberate no-op in this decoder (see runCommand()) - so the
    // mispairing is inert by construction, not a bug being tolerated.
    const byte = (this.pendingHighNibble << 4) | nibble;
    const rs = this.pendingRs;
    this.pendingHighNibble = null;

    if (rs) {
      this.writeChar(byte);
    } else {
      this.runCommand(byte);
    }
    this.onUpdate(this.displayOn ? this.buffer.slice() : new Uint8Array(this.cols * this.rows));
  }

  // Resolves a raw DDRAM address to (row, col) against this.rowOffsets -
  // the highest offset not exceeding addr wins (matching how the real
  // chip's row boundaries work: row 1 "starts" at 0x40 but everything
  // from 0x00 up to 0x3F belongs to row 0 first). Returns null for an
  // address off this display's visible columns/rows entirely.
  private addressToRowCol(addr: number): { row: number; col: number } | null {
    let bestRow = -1;
    let bestOffset = -1;
    for (let row = 0; row < this.rows; row++) {
      const offset = this.rowOffsets[row];
      if (addr >= offset && offset > bestOffset) {
        bestRow = row;
        bestOffset = offset;
      }
    }
    if (bestRow === -1) return null;
    const col = addr - bestOffset;
    if (col < 0 || col >= this.cols) return null;
    return { row: bestRow, col };
  }

  private writeChar(charCode: number): void {
    // Off the visible columns of its row (or past the last row entirely)
    // - silently dropped, matching what a real un-scrolled display shows
    // for text that overruns a line: it's still "written" to DDRAM, just
    // never visible.
    const resolved = this.addressToRowCol(this.ddramAddr);
    if (resolved) {
      this.buffer[resolved.row * this.cols + resolved.col] = charCode;
    }
    this.ddramAddr += this.entryIncrement ? 1 : -1;
  }

  // Real HD44780 instruction decoding: each command is one distinct flag
  // bit plus lower payload bits reserved to it, so checking from the
  // highest bit down and stopping at the first set one is exactly
  // correct - it's the same priority encoding the real chip's hardware
  // does, not a simplification of it.
  private runCommand(byte: number): void {
    if (byte & 0x80) {
      // SETDDRAMADDR (used by setCursor())
      this.ddramAddr = byte & 0x7f;
    } else if (byte & 0x40) {
      // SETCGRAMADDR (createChar() - custom glyphs). Not supported: the
      // 8 write()s that would follow (the glyph's bitmap rows) get
      // decoded as plain character writes at the *current* DDRAM address
      // instead, since this decoder has no separate "CGRAM write mode".
      // A known v1 limitation, not a silent miscompile - createChar()
      // itself still compiles and runs fine, it just won't draw a custom
      // glyph on this canvas.
    } else if (byte & 0x20) {
      // FUNCTION SET (interface width/line count/font). A deliberate
      // no-op: whichever fixed-size element this decoder drives
      // (wokwi-lcd1602's 16x2, wokwi-lcd2004's 20x4 - see this.cols/rows)
      // has a size fixed by its own class, not by what a sketch requests
      // here, so there's no display-side state for this to change. Also
      // what begin()'s 4-bit-mode reset dance harmlessly resolves to twice
      // (see onNibbleLatched()'s own comment).
    } else if (byte & 0x10) {
      // CURSOR OR DISPLAY SHIFT. Only the cursor-move case (bit 0x08
      // clear) is handled - scrollDisplayLeft()/Right() (bit 0x08 set)
      // would need a horizontal viewport offset this decoder doesn't
      // model, so those are a no-op here rather than a wrong one.
      if (!(byte & 0x08)) {
        this.ddramAddr += byte & 0x04 ? 1 : -1;
      }
    } else if (byte & 0x08) {
      // DISPLAY CONTROL - only D (display on/off) is reflected; C/B
      // (cursor/blink) have no rendering here yet.
      this.displayOn = !!(byte & 0x04);
    } else if (byte & 0x04) {
      // ENTRY MODE SET - only I/D (increment/decrement) is tracked; S
      // (whole-display shift on every write, autoscroll()/
      // noAutoscroll()) isn't modeled.
      this.entryIncrement = !!(byte & 0x02);
    } else if (byte & 0x02) {
      // RETURN HOME
      this.ddramAddr = 0;
    } else if (byte & 0x01) {
      // CLEAR DISPLAY - also resets entry mode to increment, per the
      // real HD44780 datasheet (not just LiquidCrystal's own default),
      // since clear() is the one command real firmware can call at any
      // time to get back to a fully known state.
      this.buffer.fill(0);
      this.ddramAddr = 0;
      this.entryIncrement = true;
    }
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
  }
}
