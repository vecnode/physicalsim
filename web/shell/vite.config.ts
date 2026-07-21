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
      "@wokwi/elements": resolve("../../simulators/wokwi-elements/src/index.ts"),
      // wokwi-elements imports "lit" as a real npm dependency, but it
      // lives outside this alias's own resolution chain (simulators/ is a
      // sibling of web/, not nested under it - plain node resolution
      // walking up from simulators/wokwi-elements/src never reaches
      // web/node_modules). This alias's string form matches both the bare
      // "lit" specifier and every subpath ("lit/decorators.js" etc.) -
      // mirrored in tsconfig.json's "paths" for tsc's own typecheck.
      lit: resolve("../node_modules/lit"),
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
  // rp2040js/avr8js/wokwi-elements are aliased in as raw source (see
  // above), but Vite transforms the whole bundle against this project's
  // tsconfig rather than each vendored file's own tsconfig.json. Both
  // simulator libraries build themselves with useDefineForClassFields:false
  // (rp2040js sets it explicitly; avr8js targets ES2015, which implies it)
  // because several of their classes assign fields that read sibling
  // fields in the same constructor pass — with esbuild's native (spec)
  // class-field semantics that trips a use-before-init crash at runtime
  // (not just a type error). Match that setting here for the whole bundle,
  // workers included. experimentalDecorators is wokwi-elements' own
  // requirement (its tsconfig.json sets both) - its components are Lit
  // classes using legacy TS decorators (@customElement/@property/@query),
  // which esbuild only understands with this flag on.
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        useDefineForClassFields: false,
        experimentalDecorators: true,
      },
    },
  },
  build: {
    outDir: resolve("../../public"),
    emptyOutDir: true,
  },
});
