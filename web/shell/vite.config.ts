import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Simulator libraries are consumed directly from their submodule source
// (simulators/<name>/src) rather than a pre-built npm package. Swapping a
// simulator later is a one-line change to these two aliases plus the
// matching adapter package.
const resolve = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: __dirname,
  resolve: {
    alias: {
      rp2040js: resolve("../../simulators/rp2040js/src/index.ts"),
      avr8js: resolve("../../simulators/avr8js/src/index.ts"),
    },
  },
  server: {
    fs: {
      allow: [resolve("../..")],
    },
  },
  worker: {
    format: "es",
  },
  // rp2040js/avr8js are aliased in as raw source (see above), but Vite
  // transforms the whole bundle against this project's tsconfig rather than
  // each vendored file's own tsconfig.json. Both vendored libraries build
  // themselves with useDefineForClassFields:false (rp2040js sets it
  // explicitly; avr8js targets ES2015, which implies it) because several of
  // their classes assign fields that read sibling fields in the same
  // constructor pass — with esbuild's native (spec) class-field semantics
  // that trips a use-before-init crash at runtime (not just a type error).
  // Match that setting here for the whole bundle, workers included.
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        useDefineForClassFields: false,
      },
    },
  },
  build: {
    outDir: resolve("../../public"),
    emptyOutDir: true,
  },
});
