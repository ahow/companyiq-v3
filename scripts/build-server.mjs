// Precompile the server + shared TypeScript tree to plain ESM JavaScript under
// dist/, preserving the source directory structure.
//
// WHY: the worker forks one isolated child process per analysis job. When the
// child is started under `node --import tsx`, every child cold-compiles the
// entire pipeline module graph via tsx/esbuild at runtime. Under a batch-start
// fork storm (many children spawning at once) the per-child compile starves CPU
// and some children never progress past the "spawn" stage before the job
// deadline kills them. Precompiling to JS removes the per-child compile cost:
// the child loads plain JS and reaches its first heartbeat quickly.
//
// This is transpile-only (bundle:false): each .ts file maps 1:1 to a .js file
// at the same relative path, so every `import.meta.url`-anchored asset path
// resolves exactly as it does today. Only the language changes (TS -> JS); the
// module graph and laziness of dynamic imports are unchanged. node_modules are
// never touched (not bundled).
//
// esbuild transpile-only does NOT rewrite import specifiers, and the source uses
// extensionless relative imports (e.g. `from "./table-horizon-normaliser"`) that
// tsx tolerates but Node's ESM loader rejects (ERR_MODULE_NOT_FOUND). So after
// emit we rewrite every extensionless relative specifier to an explicit
// `./foo.js` (or `./dir/index.js`), resolved against the emitted tree.

import esbuild from "esbuild";
import { promises as fs, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIRS = ["server", "shared"];
const OUT_DIR = path.join(repoRoot, "dist");

// Directories/files that must NOT be compiled or copied into the runtime image.
const EXCLUDE_DIR_NAMES = new Set(["__fixtures__", "__tests__", "node_modules"]);
const isTestFile = (p) => /\.test\.ts$/.test(p) || /\.spec\.ts$/.test(p);

async function walk(dir, acc = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return acc; // dir may not exist (e.g. no shared/)
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (EXCLUDE_DIR_NAMES.has(e.name)) continue;
      await walk(full, acc);
    } else {
      acc.push(full);
    }
  }
  return acc;
}

const HAS_EXT = /\.(js|mjs|cjs|json|node|wasm)$/;
// Matches the specifier string of: `... from "x"`, side-effect `import "x"`,
// and dynamic `import("x")`. Group 1 = prefix up to and including the opening
// quote; group 2 = specifier; group 3 = closing quote.
const SPEC_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.\.?\/[^"']+)(["'])/g;

async function collectJsFiles(dir, acc = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await collectJsFiles(full, acc);
    else if (e.name.endsWith(".js")) acc.push(full);
  }
  return acc;
}

async function rewriteRelativeSpecifiers(outDir) {
  const files = await collectJsFiles(outDir);
  let rewritten = 0, filesTouched = 0, unresolved = 0;
  for (const file of files) {
    const dir = path.dirname(file);
    const code = await fs.readFile(file, "utf8");
    let changed = false;
    const out = code.replace(SPEC_RE, (m, pre, q1, spec, q2) => {
      if (HAS_EXT.test(spec)) return m; // already explicit
      const asFile = path.resolve(dir, spec + ".js");
      const asIndex = path.resolve(dir, spec, "index.js");
      let resolved = null;
      if (existsSync(asFile)) resolved = spec + ".js";
      else if (existsSync(asIndex)) resolved = spec.replace(/\/?$/, "/") + "index.js";
      if (!resolved) { unresolved++; return m; }
      changed = true; rewritten++;
      return `${pre}${q1}${resolved}${q2}`;
    });
    if (changed) { await fs.writeFile(file, out); filesTouched++; }
  }
  console.log(`[build-server] rewrote ${rewritten} relative specifier(s) across ${filesTouched} file(s)` + (unresolved ? ` (${unresolved} left unchanged)` : ""));
}

async function main() {
  const allFiles = [];
  for (const d of SRC_DIRS) await walk(path.join(repoRoot, d), allFiles);

  const tsEntries = allFiles.filter((p) => p.endsWith(".ts") && !p.endsWith(".d.ts") && !isTestFile(p));
  // Everything that is not a compiled .ts source but still needs to exist at the
  // same relative path at runtime (e.g. pdf-parse-worker.cjs resolved via
  // new URL("./pdf-parse-worker.cjs", import.meta.url)).
  const assetFiles = allFiles.filter(
    (p) => !p.endsWith(".ts") || p.endsWith(".d.ts"),
  );

  console.log(`[build-server] transpiling ${tsEntries.length} TypeScript files -> dist/`);
  const result = await esbuild.build({
    entryPoints: tsEntries,
    outdir: OUT_DIR,
    outbase: repoRoot,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: true,
    bundle: false,          // 1:1 transpile; relative .js specifiers resolve at runtime
    logLevel: "warning",
    tsconfigRaw: {
      compilerOptions: {
        // Match tsconfig.json runtime-relevant settings; no type-checking here
        // (tsx did not type-check either — the worker image only needs JS).
        target: "es2022",
        useDefineForClassFields: false,
      },
    },
  });
  if (result.errors.length) {
    console.error(`[build-server] ${result.errors.length} errors`);
    process.exit(1);
  }

  // Rewrite extensionless relative import/export specifiers in emitted JS to
  // explicit paths Node's ESM loader can resolve.
  await rewriteRelativeSpecifiers(OUT_DIR);

  // Copy non-TS runtime assets, preserving structure.
  let copied = 0;
  for (const src of assetFiles) {
    const rel = path.relative(repoRoot, src);
    const dest = path.join(OUT_DIR, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
    copied++;
  }
  console.log(`[build-server] copied ${copied} non-TS asset(s) into dist/`);
  console.log(`[build-server] done.`);
}

main().catch((e) => {
  console.error("[build-server] FAILED:", e);
  process.exit(1);
});
