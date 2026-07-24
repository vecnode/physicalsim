/// <reference types="vite/client" />

// monaco-editor ships no .d.ts for basic-languages' individual language
// modules (only their *.contribution.d.ts, which types the lazy-loader
// registration, not the tokenizer itself) - sketch-editor.ts imports
// cpp.js directly (eagerly, bypassing the lazy loader - see that file's
// own comment for why) and needs this to typecheck.
declare module "monaco-editor/esm/vs/basic-languages/cpp/cpp.js" {
  import type { languages } from "monaco-editor";
  export const conf: languages.LanguageConfiguration;
  export const language: languages.IMonarchLanguage;
}
