#!/usr/bin/env node
// Copies vite build's staging output (../../.vite-staging, see
// vite.config.ts's own comment) into ../../public - but only overwrites a
// file when its content actually differs, and only deletes a public/ file
// that no longer exists in staging. Anything unchanged keeps its original
// mtime untouched.
//
// Why this exists: CMakeLists.txt embeds public/ into the C++ binary via
// cpp-embedlib's cpp_embedlib_add(), whose generated per-file build rules
// key off each file's own mtime (see that macro's add_custom_command
// DEPENDS). A plain `vite build` with emptyOutDir writes every output file
// fresh on every build - even ones whose content didn't change - so every
// single embedded asset (including the ~90 untouched Monaco-editor
// language/worker bundles) got regenerated and recompiled on every web/
// change, not just the changed file(s). Stable (non-hashed) output
// filenames alone don't fix that - emptyOutDir still rewrites every file's
// mtime regardless of content - so this script is the piece that actually
// makes an unrelated one-line change embed/compile fast again.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, mkdirSync, copyFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const stagingDir = join(repoRoot, ".vite-staging");
const publicDir = join(repoRoot, "public");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

if (!existsSync(stagingDir)) {
  console.error(`sync-dist: staging directory not found: ${stagingDir}`);
  process.exit(1);
}

mkdirSync(publicDir, { recursive: true });

const stagingFiles = walk(stagingDir);
const stagingRelSet = new Set(stagingFiles.map((f) => relative(stagingDir, f)));

let copied = 0;
let skipped = 0;
for (const src of stagingFiles) {
  const rel = relative(stagingDir, src);
  const dest = join(publicDir, rel);
  if (existsSync(dest) && hashFile(dest) === hashFile(src)) {
    skipped++;
    continue;
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  copied++;
}

let removed = 0;
if (existsSync(publicDir)) {
  for (const existing of walk(publicDir)) {
    const rel = relative(publicDir, existing);
    if (!stagingRelSet.has(rel)) {
      rmSync(existing, { force: true });
      removed++;
    }
  }
}

// Written unconditionally (unlike every file above, only touched when its
// content actually changed) and deliberately outside public/ - it isn't a
// web asset and shouldn't be embedded into WebAssets alongside real ones.
// build_and_run.bat's tools/check-web-stale.ps1 compares source mtimes
// against *this* file, not e.g. public/index.html, precisely because
// index.html (or any given output file) might not get touched on a given
// build if its own content happened not to change - this stamp always
// does, so it's a reliable "when did a build last actually run" marker.
writeFileSync(join(repoRoot, ".web-build-stamp"), new Date().toISOString());

console.log(`sync-dist: ${copied} file(s) updated, ${skipped} unchanged, ${removed} removed`);
