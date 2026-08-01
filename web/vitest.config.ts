import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Mirrors shell/vite.config.ts: rp2040js/avr8js are consumed as raw
// submodule source, not a built npm package, so tests need the same
// aliases (and useDefineForClassFields setting) the app bundle uses.
const resolve = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "rp2040js/pico": resolve("../simulators/rp2040js/src/pico/index.ts"),
      rp2040js: resolve("../simulators/rp2040js/src/index.ts"),
      // More specific key first - Vite/Vitest's object-form alias matching
      // checks entries in order and treats a key as a prefix match
      // (`id === key || id.startsWith(key + "/")`), so "avr8js" would
      // otherwise shadow "avr8js/arduino" and mangle it into an invalid
      // path (its own replacement is a specific file, not a directory).
      "avr8js/arduino": resolve("../simulators/avr8js/src/arduino/index.ts"),
      avr8js: resolve("../simulators/avr8js/src/index.ts"),
    },
  },
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        useDefineForClassFields: false,
      },
    },
  },
  test: {
    environment: "node",
    include: ["{common,adapters/*,shell}/src/**/*.test.ts"],
  },
});
