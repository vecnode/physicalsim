// Turns a raw avr-gcc compiler log (src/avr_toolchain.cpp's CompileResponse.log)
// into structured, explained diagnostics - so a first-time user sees "you're
// missing a semicolon on the line above" instead of just the compiler's own
// terse "expected ';' before '}' token". Deliberately not a language server:
// no clangd/LSP round-trip, just pattern-matching against avr-gcc's own
// stable diagnostic format (well-documented, unchanged across GCC versions:
// "<file>:<line>:<col>: error|warning|note: <message>").
//
// Board-aware notes (e.g. "the Franzininho has no I2C hardware") reuse the
// same knowledge this project already has elsewhere (COMPONENTS.md/
// ARCHITECTURE.md's own notes on which chip has which peripherals) rather
// than re-deriving it - see BOARD_MISSING_PERIPHERALS below.
import { ARDUINO_KNOWN_SYMBOLS } from "./sketch-editor.js";

export type DiagnosticSeverity = "error" | "warning" | "note";

export interface Diagnostic {
  file: string;
  // 1-based, already adjusted to match what's in the sketch editor (see
  // SKETCH_FILE_NAME/SKETCH_LINE_OFFSET below) - only meaningful when
  // isSketchLine is true.
  line: number;
  column: number;
  severity: DiagnosticSeverity;
  // The compiler's own text, verbatim - always shown, never replaced.
  rawMessage: string;
  // A plain-English translation, when this parser recognizes the pattern.
  // Left undefined for anything it doesn't recognize, rather than guessing.
  explanation?: string;
  // Whether `line`/`column` point into the user's own sketch (as opposed to
  // a vendored core/library file) - only sketch lines are worth offering a
  // "jump to line" action for, since the editor only has the sketch open.
  isSketchLine: boolean;
}

// avr_toolchain.cpp writes the sketch to exactly this filename, prefixed
// with exactly one line ("#include <Arduino.h>\n") the user never sees in
// the editor - see its own compile_sketch()/ofstream write. Every line
// number gcc reports against sketch.cpp is one greater than the matching
// line in the editor because of that prefix.
const SKETCH_FILE_NAME = "sketch.cpp";
const SKETCH_LINE_OFFSET = 1;

// gcc's own diagnostic line shape, stable across versions:
// "<file>:<line>:<col>: error: <message>" (col is one-based; the trailing
// caret/source-excerpt lines gcc also prints aren't matched by this and are
// left as part of the raw log rather than parsed as their own entries).
const DIAG_LINE_RE = /^(.+?):(\d+):(\d+):\s*(error|warning|note):\s*(.*)$/;

function levenshtein(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length];
}

// Closest known Arduino core symbol to `name`, only if it's plausibly a
// typo (within 2 edits and at least half the name matches) - anything
// further away is more likely a genuinely different, unrelated identifier,
// and a wrong suggestion is worse than no suggestion.
function closestKnownSymbol(name: string): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const symbol of ARDUINO_KNOWN_SYMBOLS) {
    const dist = levenshtein(name, symbol);
    if (dist < bestDist) {
      bestDist = dist;
      best = symbol;
    }
  }
  if (best && bestDist <= 2 && bestDist < name.length) return best;
  return undefined;
}

// Board id -> which vendored-Arduino-library headers its chip genuinely
// doesn't support, and why - see ARCHITECTURE.md's "Vendored Arduino
// libraries" / COMPONENTS.md board table for the underlying chip facts this
// draws from (Franzininho's ATtiny85 has one port and no USART/SPI/TWI
// hardware at all; this project's other boards all have real peripherals
// for these).
const BOARD_MISSING_PERIPHERALS: Record<string, Record<string, string>> = {
  franzininho: {
    "Wire.h": "the Franzininho's ATtiny85 has no I2C/TWI hardware - Wire.h will not work on this board.",
    "SPI.h": "the Franzininho's ATtiny85 has no hardware SPI peripheral - SPI.h will not work on this board.",
  },
};

// Recognizes a handful of the most common beginner mistakes and returns a
// plain-English explanation - returns undefined for anything not
// recognized, so the raw compiler message is always what's actually shown
// in that case (see terminal.ts's writeDiagnostics()).
function explain(message: string, board: string | undefined): string | undefined {
  let m: RegExpMatchArray | null;

  if ((m = message.match(/'(.+)' was not declared in this scope/))) {
    const name = m[1];
    const suggestion = closestKnownSymbol(name);
    return suggestion
      ? `"${name}" isn't a known name here - did you mean "${suggestion}"?`
      : `"${name}" isn't declared - check the spelling, or add the #include that defines it.`;
  }

  if ((m = message.match(/expected ';' before/))) {
    return "missing semicolon - probably at the end of the line above this one.";
  }

  if ((m = message.match(/redefinition of '(void setup\(\)|void loop\(\))'/))) {
    return `you have two ${m[1]} functions - an Arduino sketch needs exactly one of each.`;
  }

  if ((m = message.match(/expected primary-expression before/))) {
    return "the compiler got lost partway through this line - check for a missing operator, parenthesis, or quote.";
  }

  if ((m = message.match(/expected '\}' at end of input|expected declaration before '\}' token/))) {
    return "a closing brace '}' is missing somewhere above - check that every '{' has a matching '}'.";
  }

  if ((m = message.match(/(\S+\.h): No such file or directory/))) {
    const header = m[1];
    const boardNote = board && BOARD_MISSING_PERIPHERALS[board]?.[header];
    return boardNote ?? `"${header}" isn't a library this project has vendored yet - see COMPONENTS.md/ARCHITECTURE.md's "Vendored Arduino libraries" section for what's available.`;
  }

  if ((m = message.match(/no matching function for call to '(.+?)\(/))) {
    return `no version of "${m[1]}" takes those arguments - check the number/types of values you're passing.`;
  }

  return undefined;
}

// Parses a raw compiler log into structured diagnostics, in the order gcc
// printed them. Lines that don't match the diagnostic shape (caret/source
// excerpt lines gcc also prints, ninja/linker banner text, etc.) are simply
// not turned into a Diagnostic - they stay visible in the raw log terminal
// already prints underneath, never dropped from the log itself.
export function parseCompilerLog(log: string, board: string | undefined): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const rawLine of log.split("\n")) {
    const m = rawLine.match(DIAG_LINE_RE);
    if (!m) continue;
    const [, filePath, lineStr, colStr, severity, message] = m;
    // gcc reports whichever path it was invoked with - avr_toolchain.cpp
    // always compiles sketch.cpp from its own per-compile temp working
    // directory, so matching on the basename (not a full/relative path
    // comparison) is what actually works regardless of that directory.
    const isSketchLine = filePath.replace(/\\/g, "/").split("/").pop() === SKETCH_FILE_NAME;
    const line = isSketchLine ? Math.max(1, Number(lineStr) - SKETCH_LINE_OFFSET) : Number(lineStr);
    diagnostics.push({
      file: filePath,
      line,
      column: Number(colStr),
      severity: severity as DiagnosticSeverity,
      rawMessage: message,
      explanation: explain(message, board),
      isSketchLine,
    });
  }
  return diagnostics;
}
