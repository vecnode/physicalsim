// A real code editor (Monaco - VS Code's own editor engine) for the sketch
// panel, replacing the plain <textarea> M2 shipped with. Small, self-
// contained UI class (mirrors terminal.ts's own convention) - main.ts only
// ever calls getValue()/setTheme()/dispose() on it, and has no idea Monaco
// exists underneath.
//
// CSP note: index.html's style-src carries 'unsafe-inline' specifically
// for Monaco's runtime-injected theming <style> tag - see that file's own
// comment for why (a still-open upstream limitation, not a choice made
// lightly).
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
// "monaco-editor" (imported above, resolving to editor.main.js) already
// registers "cpp" as a language - but only *lazily*: the real Monarch
// tokenizer (this same module) loads via a dynamic import the first time a
// "cpp" model is actually tokenized, and Monaco's own re-render-once-loaded
// path depends on its internal animation-frame-driven scheduler. That
// scheduler doesn't reliably run in every host/embedding (confirmed live:
// syntax highlighting silently never appeared - every token stayed plain
// "mtk1" - even seconds after the lazy load must have finished, while a
// manual, forced re-tokenize afterward worked instantly). Importing the
// tokenizer eagerly here and registering it directly, before the editor
// exists at all, makes the very first tokenization pass already real -
// no lazy load, no timing race, nothing to wait on.
import { conf as cppConf, language as cppLanguage } from "monaco-editor/esm/vs/basic-languages/cpp/cpp.js";

monaco.languages.setLanguageConfiguration("cpp", cppConf);
monaco.languages.setMonarchTokensProvider("cpp", cppLanguage);

// Must run before the first monaco.editor.create() call - Monaco checks
// self.MonacoEnvironment lazily, the first time it actually needs a
// worker, but there's no later hook to set this after that point.
// "cpp" (the only language this editor uses) has no dedicated worker of
// its own (unlike json/html/css/typescript, which editor.main.js also
// pulls in) - only the base editor worker (tokenization fallback, diff,
// etc.) is ever actually requested, so one shared instance covers every
// label Monaco might ask for.
self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

// A short, hand-written list of Arduino core signatures - not a real
// language server (no clangd/LSP - avr8js itself only emulates GPIO/
// Timer/USART today, so semantic analysis against real headers wouldn't
// buy much yet anyway). Registered once, module-wide (Monaco's completion
// provider API is global per language id, not per editor instance).
const ARDUINO_CORE_COMPLETIONS: Array<{ label: string; detail: string; insertText: string }> = [
  { label: "pinMode", detail: "void pinMode(uint8_t pin, uint8_t mode)", insertText: "pinMode(${1:pin}, ${2:OUTPUT})" },
  { label: "digitalWrite", detail: "void digitalWrite(uint8_t pin, uint8_t value)", insertText: "digitalWrite(${1:pin}, ${2:HIGH})" },
  { label: "digitalRead", detail: "int digitalRead(uint8_t pin)", insertText: "digitalRead(${1:pin})" },
  { label: "analogRead", detail: "int analogRead(uint8_t pin)", insertText: "analogRead(${1:pin})" },
  { label: "analogWrite", detail: "void analogWrite(uint8_t pin, int value)", insertText: "analogWrite(${1:pin}, ${2:value})" },
  { label: "delay", detail: "void delay(unsigned long ms)", insertText: "delay(${1:ms})" },
  { label: "millis", detail: "unsigned long millis()", insertText: "millis()" },
  { label: "Serial.begin", detail: "void Serial.begin(unsigned long baud)", insertText: "Serial.begin(${1:9600})" },
  { label: "Serial.print", detail: "void Serial.print(...)", insertText: "Serial.print(${1:value})" },
  { label: "Serial.println", detail: "void Serial.println(...)", insertText: "Serial.println(${1:value})" },
];

let completionProviderRegistered = false;

function ensureCompletionProviderRegistered(): void {
  if (completionProviderRegistered) return;
  completionProviderRegistered = true;
  monaco.languages.registerCompletionItemProvider("cpp", {
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      return {
        suggestions: ARDUINO_CORE_COMPLETIONS.map((c) => ({
          label: c.label,
          kind: monaco.languages.CompletionItemKind.Function,
          detail: c.detail,
          insertText: c.insertText,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        })),
      };
    },
  });
}

export class SketchEditor {
  private readonly editor: monaco.editor.IStandaloneCodeEditor;

  constructor(container: HTMLElement, initialValue: string) {
    ensureCompletionProviderRegistered();
    this.editor = monaco.editor.create(container, {
      value: initialValue,
      language: "cpp",
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 12,
      scrollBeyondLastLine: false,
    });

    // Monaco defers both its first paint and its actual line tokenization
    // to its own background/animation-frame-driven scheduler, which isn't
    // guaranteed to run on every host/embedding (confirmed live: .view-line
    // stayed completely empty in the DOM despite getValue() already
    // returning the real content, and separately - even with the tokenizer
    // eagerly registered above - the first paint still showed only plain
    // "mtk1" tokens, no real colors, until forced). Neither
    // requestAnimationFrame nor a ResizeObserver fixed either problem
    // reliably (both depend on that same scheduler).
    //
    // setValue(getValue()) alone is *not* enough - Monaco no-ops a
    // setValue() whose content is identical to what's already there (no
    // change event, nothing invalidated to retokenize). Actually changing
    // the content and changing it back - matching how this was proven to
    // work manually - forces a real change event, which is what actually
    // triggers tokenization; layout()+render(true) then paints it.
    const model = this.editor.getModel();
    if (model) {
      model.setValue(model.getValue() + " ");
      model.setValue(model.getValue().slice(0, -1));
    }
    this.editor.layout();
    this.editor.render(true);
  }

  getValue(): string {
    return this.editor.getValue();
  }

  // Replaces the whole sketch (an example's "Load" action) - a real model
  // change, not just re-rendering, so undo history/tokenization reset the
  // same way a user retyping the whole thing would.
  setValue(value: string): void {
    this.editor.setValue(value);
  }

  // automaticLayout (a ResizeObserver internally) is not a reliable signal
  // in every host/embedding here - same underlying issue as the
  // constructor's own forced layout()+render(true) - so main.ts calls this
  // explicitly whenever it already knows the container resized (e.g.
  // dragging #sidebar-resize-handle) instead of trusting the observer to
  // catch it on its own.
  layout(): void {
    this.editor.layout();
  }

  setTheme(theme: "light" | "dark"): void {
    monaco.editor.setTheme(theme === "dark" ? "vs-dark" : "vs");
  }

  dispose(): void {
    this.editor.dispose();
  }
}
