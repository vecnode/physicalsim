// Serial Monitor - Stage 1 of the terminal feature (see ARCHITECTURE.md's
// "Serial Monitor" section): displays whatever the active adapter's UART
// transmits (Serial.write()/Serial.print() on real firmware), byte by
// byte, as it arrives. Read-only - no input box, no Serial.read()
// support yet, since there's no firmware-loading pipeline for anything
// typed here to reach a running sketch anyway (that's Stage 2).
//
// Deliberately a small, self-contained UI class (mirrors canvas/
// minimap.ts, canvas/context-menu.ts) rather than DOM manipulation
// spread across main.ts - main.ts only ever calls writeByte()/clear()/
// setVisible() on it, and has no idea how the output is buffered into
// lines or how collapse/expand works.
export interface TerminalElements {
  panel: HTMLElement;
  output: HTMLElement;
  collapseBtn: HTMLButtonElement;
  clearBtn: HTMLButtonElement;
}

// Caps how many completed lines stay in the DOM - a long-running sketch
// printing continuously would otherwise grow the output element (and the
// page's memory) without bound. Matches the log's own spirit (a rolling
// window, not a full transcript) rather than introducing a new policy.
const MAX_LINES = 500;

export class Terminal {
  private collapsed = false;
  // The line currently being written to - null right after a newline (or
  // at startup/clear()), created lazily on the next non-newline byte so
  // an empty terminal doesn't start with one blank line already in it.
  private currentLineEl: HTMLElement | null = null;

  constructor(private readonly el: TerminalElements) {
    el.collapseBtn.addEventListener("click", () => this.setCollapsed(!this.collapsed));
    el.clearBtn.addEventListener("click", () => this.clear());
  }

  setVisible(visible: boolean): void {
    this.el.panel.hidden = !visible;
  }

  setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    this.el.panel.classList.toggle("collapsed", collapsed);
    this.el.collapseBtn.title = collapsed ? "Expand Serial Monitor" : "Collapse Serial Monitor";
  }

  clear(): void {
    this.el.output.replaceChildren();
    this.currentLineEl = null;
  }

  // Appends one complete, non-UART line (e.g. "firmware loaded") - styled
  // distinctly (.terminal-system-line) so it doesn't read as something
  // the board itself printed via Serial. Always starts its own line and
  // ends the current one, so any UART byte arriving right after doesn't
  // get appended onto it.
  writeLine(text: string): void {
    const line = document.createElement("div");
    line.className = "terminal-system-line";
    line.textContent = text;
    this.el.output.appendChild(line);
    this.trimToMaxLines();
    this.currentLineEl = null;
    this.scrollToBottom();
  }

  // Feeds one byte of UART TX data. CR is dropped (Arduino's Serial
  // library, like most serial links, sends CRLF line endings - keeping
  // only LF as the line break avoids a stray blank-looking line for
  // every println()). Anything else appends to the line currently being
  // built, creating a fresh line element the moment there's a character
  // to put in it.
  writeByte(byte: number): void {
    const ch = String.fromCharCode(byte);
    if (ch === "\r") return;
    if (ch === "\n") {
      this.currentLineEl = null;
      return;
    }
    if (!this.currentLineEl) {
      this.currentLineEl = document.createElement("div");
      this.el.output.appendChild(this.currentLineEl);
      this.trimToMaxLines();
    }
    this.currentLineEl.textContent += ch;
    this.scrollToBottom();
  }

  private trimToMaxLines(): void {
    while (this.el.output.childElementCount > MAX_LINES) {
      this.el.output.firstElementChild?.remove();
    }
  }

  private scrollToBottom(): void {
    this.el.output.scrollTop = this.el.output.scrollHeight;
  }
}
