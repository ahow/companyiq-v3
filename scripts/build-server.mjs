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
// at the same relative path, so every relative `./foo.js` import and every
// `import.meta.url`-anchored asset path resolves exactly as it does today. Only
// the language changes (TS -> JS); the module graph and laziness of dynamic
// imports are unchanged. node_modules are never touched (not bundled).

import esbuild from "esbuild";
import { promises as fs } from "fs";
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
