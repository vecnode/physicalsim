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
      // More specific key first - see the "avr8js/arduino" entry below for
      // why (prefix-match aliasing, replacement is a specific file).
      "rp2040js/pico": resolve("../../simulators/rp2040js/src/pico/index.ts"),
      rp2040js: resolve("../../simulators/rp2040js/src/index.ts"),
      // More specific key first - Vite's object-form alias matching checks
      // entries in order and treats a key as a prefix match
      // (`id === key || id.startsWith(key + "/")`, the same mechanism the
      // "lit" alias below relies on to also match "lit/decorators.js"), so
      // "avr8js" would otherwise shadow "avr8js/arduino" first and mangle
      // it into an invalid path (its own replacement is a specific file,
      // not a directory, unlike "lit"'s). The JS-interpreted sketch
      // runtime (no compiler, no CPU emulation - see adapters/avr8-js)
      // needs this subpath resolvable on its own.
      "avr8js/arduino": resolve("../../simulators/avr8js/src/arduino/index.ts"),
      avr8js: resolve("../../simulators/avr8js/src/index.ts"),
      // JS/TS-interpreted ESP-IDF-shaped sketch runtime (no C/C++
      // toolchain, no cycle-accurate Xtensa CPU - see adapters/esp32-js).
      "esp32js/espidf": resolve("../../simulators/esp32js/src/espidf/index.ts"),
      // simulators/iot-elements (vecnode/iot-elements) is this project's
      // vendored element library - originally a fork of upstream
      // wokwi/wokwi-elements, later renamed on GitHub and consolidated
      // with the (separately vendored, then-unused) iot-elements
      // submodule into one repo, so simulators/wokwi-elements no longer
      // exists as a submodule here. The "@wokwi/elements" import
      // specifier itself is unchanged - every custom element file still
      // imports from that name, it's just the alias target that moved.
      "@wokwi/elements": resolve("../../simulators/iot-elements/src/index.ts"),
      // iot-elements imports "lit" as a real npm dependency, but it
      // lives outside this alias's own resolution chain (simulators/ is a
      // sibling of web/, not nested under it - plain node resolution
      // walking up from simulators/iot-elements/src never reaches
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
  // rp2040js/avr8js/iot-elements are aliased in as raw source (see
  // above), but Vite transforms the whole bundle against this project's
  // tsconfig rather than each vendored file's own tsconfig.json. Both
  // simulator libraries build themselves with useDefineForClassFields:false
  // (rp2040js sets it explicitly; avr8js targets ES2015, which implies it)
  // because several of their classes assign fields that read sibling
  // fields in the same constructor pass — with esbuild's native (spec)
  // class-field semantics that trips a use-before-init crash at runtime
  // (not just a type error). Match that setting here for the whole bundle,
  // workers included. experimentalDecorators is iot-elements' own
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
    // Builds into a disposable staging directory, not ../../public
    // directly - see scripts/sync-dist.mjs (chained after `vite build` in
    // package.json's own "build" script), which is what actually updates
    // public/, copying over only files whose content changed and leaving
    // everything else's mtime untouched. That step is what makes stable
    // filenames below actually pay off: CMakeLists.txt's cpp_embedlib_add()
    // embeds public/ as C++ (its own add_custom_command DEPENDS on each
    // file's mtime), and this project's own history already showed that
    // Vite's default content-hashed names shift on *unrelated* changes
    // elsewhere in the module graph (confirmed by diffing two consecutive
    // builds - files with untouched content still got new hashes) - with
    // emptyOutDir rewriting every file's mtime on every build regardless,
    // that meant the entire ~90-file embedded WebAssets library recompiled
    // on every single web/ change, not just the changed file(s).
    outDir: resolve("../../.vite-staging"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // No [hash] - see the outDir comment above for why. Collisions
        // would need distinguishing (Rollup already keys each chunk's base
        // name off its own module id, so the existing set of names here -
        // one per Monaco language/worker - are already unique without the
        // hash suffix).
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
