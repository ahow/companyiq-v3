/**
 * Parses a V8 .cpuprofile (node --cpu-prof) into event-loop BLOCKING evidence.
 *
 * - A "busy run" is a maximal sequence of consecutive samples whose leaf is not
 *   "(idle)". GC and "(program)" count as busy (they block the loop too).
 * - A "blocking slice" is a busy run >= BLOCK_MIN_MS (default 50ms): the loop
 *   could not service timers / sockets (BullMQ lock renewal, Redis ping,
 *   pg acquire callbacks) for that long.
 * - Each sample inside a blocking slice is attributed to:
 *     leaf     — the self frame (function @ file),
 *     app      — the deepest frame in the repo's own server/ code (what OUR code
 *                was doing; library time is charged to the app caller),
 *     module   — the repo file of that app frame,
 *     library  — node_modules package of the leaf (if any).
 * - Concentration: share of blocking time held by top-1 / top-3 app functions
 *   and the Herfindahl index (HHI) over app functions.
 *
 * Usage: npx tsx server/scripts/analyze-cpuprofile.ts <file.cpuprofile> [out.json]
 */
import fs from "node:fs";

const file = process.argv[2];
const out = process.argv[3];
const BLOCK_MIN_MS = parseFloat(process.env.BLOCK_MIN_MS || "50");
const prof = JSON.parse(fs.readFileSync(file, "utf8"));

interface Node { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }
const byId = new Map<number, Node>();
const parent = new Map<number, number>();
for (const n of prof.nodes as Node[]) byId.set(n.id, n);
for (const n of prof.nodes as Node[]) for (const c of n.children ?? []) parent.set(c, n.id);

const short = (url: string) => url.replace(/^file:\/\//, "").replace(/^.*\/companyiq-v3\//, "").replace(/^.*\/node_modules\//, "node_modules/");
const label = (n: Node) => `${n.callFrame.functionName || "(anonymous)"} @ ${short(n.callFrame.url) || "(native)"}:${n.callFrame.lineNumber + 1}`;
const isApp = (url: string) => /\/companyiq-v3\/server\//.test(url) && !/node_modules/.test(url) && !/server\/scripts\//.test(url);
const libOf = (url: string) => { const m = url.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/); return m ? m[1] : null; };

const stackCache = new Map<number, { app: Node | null; leaf: Node; lib: string | null; entryApp: Node | null }>();
function info(id: number) {
  let c = stackCache.get(id); if (c) return c;
  const leaf = byId.get(id)!;
  let app: Node | null = null, entryApp: Node | null = null;
  for (let cur: number | undefined = id; cur != null; cur = parent.get(cur)) {
    const n = byId.get(cur)!;
    if (isApp(n.callFrame.url)) { if (!app) app = n; entryApp = n; }
  }
  c = { app, leaf, lib: libOf(leaf.callFrame.url), entryApp };
  stackCache.set(id, c); return c;
}

const samples: number[] = prof.samples;
const deltas: number[] = prof.timeDeltas; // µs before each sample
const dur = (i: number) => (i + 1 < deltas.length ? deltas[i + 1] : deltas[i]) / 1000; // ms
// Harness-only samples (corpus JSON loading, PDF fixture generation in
// server/scripts/) are not worker code: excluded from busy/blocking accounting.
const harnessCache = new Map<number, boolean>();
function isHarness(id: number): boolean {
  let h = harnessCache.get(id); if (h !== undefined) return h;
  h = false;
  if (!info(id).app) for (let cur: number | undefined = id; cur != null; cur = parent.get(cur)) {
    if (/\/server\/scripts\//.test(byId.get(cur)!.callFrame.url)) { h = true; break; }
  }
  harnessCache.set(id, h); return h;
}
let harnessMs = 0;
const idle = (id: number) => byId.get(id)!.callFrame.functionName === "(idle)";

const totalMs = deltas.reduce((a, b) => a + b, 0) / 1000;
let busyMs = 0;
interface Run { start: number; end: number; ms: number }
const runs: Run[] = [];
let cur: Run | null = null;
for (let i = 0; i < samples.length; i++) {
  const d = dur(i);
  if (isHarness(samples[i])) harnessMs += d;
  if (idle(samples[i]) || isHarness(samples[i])) { if (cur) { runs.push(cur); cur = null; } continue; }
  busyMs += d;
  if (!cur) cur = { start: i, end: i, ms: 0 };
  cur.end = i; cur.ms += d;
}
if (cur) runs.push(cur);
const blocking = runs.filter((r) => r.ms >= BLOCK_MIN_MS).sort((a, b) => b.ms - a.ms);
const blockingMs = blocking.reduce((a, r) => a + r.ms, 0);

const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
const leafT = new Map<string, number>(), appT = new Map<string, number>(), modT = new Map<string, number>(), libT = new Map<string, number>(), entryT = new Map<string, number>();
const runDetail: any[] = [];
for (const r of blocking) {
  const rApp = new Map<string, number>(), rLeaf = new Map<string, number>();
  for (let i = r.start; i <= r.end; i++) {
    const d = dur(i), s = info(samples[i]);
    const appK = s.app ? label(s.app) : `(no app frame: ${s.leaf.callFrame.functionName || "?"})`;
    add(leafT, label(s.leaf), d); add(appT, appK, d); add(rApp, appK, d); add(rLeaf, label(s.leaf), d);
    add(modT, s.app ? short(s.app.callFrame.url) : "(runtime / GC / no app frame)", d);
    add(libT, s.lib ?? (s.leaf.callFrame.url ? "(app code self)" : `(native: ${s.leaf.callFrame.functionName})`), d);
    if (s.entryApp) add(entryT, label(s.entryApp), d);
  }
  if (runDetail.length < 25) {
    const top = [...rApp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => ({ fn: k, pct: +(100 * v / r.ms).toFixed(1) }));
    const topLeaf = [...rLeaf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => ({ fn: k, pct: +(100 * v / r.ms).toFixed(1) }));
    runDetail.push({ ms: Math.round(r.ms), topApp: top, topLeaf });
  }
}
const rank = (m: Map<string, number>, n = 20) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
  .map(([k, v]) => ({ name: k, ms: Math.round(v), pctOfBlocking: +(100 * v / (blockingMs || 1)).toFixed(1) }));
const appShares = [...appT.values()].map((v) => v / (blockingMs || 1)).sort((a, b) => b - a);
const hhi = appShares.reduce((a, s) => a + s * s, 0);
const modShares = [...modT.values()].map((v) => v / (blockingMs || 1)).sort((a, b) => b - a);
const hist = (lo: number, hi: number) => blocking.filter((r) => r.ms >= lo && r.ms < hi);
const histogram = [[50, 100], [100, 250], [250, 500], [500, 1000], [1000, 2000], [2000, 5000], [5000, Infinity]].map(([lo, hi]) => {
  const rs = hist(lo, hi); return { bucket: `${lo}-${hi === Infinity ? "∞" : hi}ms`, runs: rs.length, ms: Math.round(rs.reduce((a, r) => a + r.ms, 0)) };
});

const result = {
  file, totalProfiledMs: Math.round(totalMs), busyMs: Math.round(busyMs), harnessExcludedMs: Math.round(harnessMs), blockMinMs: BLOCK_MIN_MS,
  blockingSlices: blocking.length, blockingMs: Math.round(blockingMs), longestSliceMs: Math.round(blocking[0]?.ms ?? 0),
  sliceHistogram: histogram,
  concentration: {
    distinctAppFunctions: appT.size, top1AppPct: +(100 * (appShares[0] ?? 0)).toFixed(1),
    top3AppPct: +(100 * appShares.slice(0, 3).reduce((a, b) => a + b, 0)).toFixed(1),
    top5AppPct: +(100 * appShares.slice(0, 5).reduce((a, b) => a + b, 0)).toFixed(1),
    hhiApp: +hhi.toFixed(3), top1ModulePct: +(100 * (modShares[0] ?? 0)).toFixed(1), distinctModules: modT.size,
  },
  topAppFunctions: rank(appT, 25), topModules: rank(modT, 20), topLeafFrames: rank(leafT, 25), topLibraries: rank(libT, 15),
  topEntryAppFrames: rank(entryT, 10), longestSlices: runDetail,
};
if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, topLeafFrames: result.topLeafFrames.slice(0, 12), topAppFunctions: result.topAppFunctions.slice(0, 15), longestSlices: result.longestSlices.slice(0, 8) }, null, 1));
