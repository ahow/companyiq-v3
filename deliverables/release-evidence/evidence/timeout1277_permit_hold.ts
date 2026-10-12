// Local, synthetic demonstration (no network, no DB, no prod).
// Reproduces the two mechanisms observed in batch-1277 logs using a verbatim copy
// of pipeline.ts:179 withTimeout() and the hand-off semaphore semantics of
// processor.ts:846 acquireBrowserSlot()/releaseBrowserSlot() (MAX_CONCURRENT_BROWSER=1).
//  Scenario 1: timeout while HOLDING  — op A's caller times out at 200ms, A keeps the permit.
//  Scenario 2: timeout while QUEUED   — op Q's caller times out while waiting; Q still acquires
//                                       and dispatches later, delaying company B.
class TimeoutError extends Error {}
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}
let active = 0; const MAX = 1; const waiters: Array<() => void> = [];
async function acquire() { if (active < MAX) { active++; return; } await new Promise<void>((r) => waiters.push(r)); }
function release() { const n = waiters.shift(); if (n) n(); else active = Math.max(0, active - 1); }
const t0 = Date.now(); const ts = () => Date.now() - t0;
const events: string[] = []; const log = (s: string) => events.push(`${String(ts()).padStart(5)}ms ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function browserOp(name: string, holdMs: number) {
  await acquire(); log(`${name} permit ACQUIRED (dispatch)`);
  try { await sleep(holdMs); log(`${name} work finished (would persist result)`); }
  finally { release(); log(`${name} permit RELEASED`); }
  return name;
}

async function scenario1() {
  const a = withTimeout(browserOp("A", 1500), 200, "A").catch((e) => log(`A caller: ${e.message} -> caller moves on`));
  await sleep(10);
  const bStart = ts();
  const b = (async () => { await browserOp("B(company 2)", 50); log(`B waited ${ts() - bStart - 50}ms for admission`); })();
  await Promise.all([a, b]);
}
async function scenario2() {
  const h = browserOp("H(holder)", 800);
  await sleep(5);
  const q = withTimeout(browserOp("Q(queued)", 600), 150, "Q").catch((e) => log(`Q caller: ${e.message} -> caller moves on`));
  await sleep(5);
  const bStart = ts();
  const b = (async () => { await browserOp("B(company 2)", 50); log(`B waited ${ts() - bStart - 50}ms for admission`); })();
  await Promise.all([h, q, b]);
}
(async () => {
  log("=== scenario 1: timeout while holding ==="); await scenario1();
  log("=== scenario 2: timeout while queued ==="); await scenario2();
  console.log(events.join("\n"));
})();
