/**
 * Probe-lifecycle unit tests for runtime-diag.ts (no Redis/DB/network).
 * Run: npx tsx server/lib/runtime-diag.unit.test.ts
 *
 *  1. Hung PING: timeout fires, the client is then SKIPPED (skipped_prev_pending)
 *     on every later sweep — at most one PING outstanding per client.
 *  2. Late reply after the timeout is swallowed: no unhandled rejection, flag
 *     cleared, next sweep pings again (ok).
 *  3. Late REJECTION after the timeout: no unhandledRejection.
 *  4. Non-ready client is never pinged (nothing queued in offline queue).
 *  5. BullMQ listeners: attach adds 6, re-attach is idempotent, attaching a new
 *     worker detaches the old one, stop removes all and clears job maps.
 *  6. stopRuntimeDiag clears both timers + histogram; disableRuntimeDiag makes
 *     every export a no-op (no timers, no listeners, no pings, no cancel-path logs).
 */
process.exitCode = 1;
const keepAlive = setInterval(() => {}, 1000);

import { EventEmitter } from "node:events";
import {
  startRuntimeDiag, stopRuntimeDiag, disableRuntimeDiag, registerRedisForDiag,
  attachBullLockDiag, cancelTrace, __runtimeDiagForTests as T,
} from "./runtime-diag.js";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const unhandled: unknown[] = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

// Capture diag log lines.
const lines: string[] = [];
const origLog = console.log, origWarn = console.warn;
console.log = (...a: any[]) => { const s = a.join(" "); if (s.startsWith("[DIAG]")) lines.push(s); else origLog(...a); };
console.warn = (...a: any[]) => { const s = a.join(" "); if (s.startsWith("[DIAG]")) lines.push(s); else origWarn(...a); };
const pingLines = (client: string) => lines.filter((l) => l.includes("[DIAG][redis-ping]") && l.includes(`client=${client} `));

/** Fake ioredis client whose PINGs are resolved/rejected manually. */
function fakeClient(status = "ready") {
  const pending: Array<{ res: (v: string) => void; rej: (e: Error) => void }> = [];
  return {
    status, commandQueue: { length: 0 }, offlineQueue: { length: 0 }, pings: 0, pending, auto: false,
    ping() { this.pings++; if (this.auto) return Promise.resolve("PONG"); return new Promise<string>((res, rej) => pending.push({ res, rej })); },
  };
}

async function main() {
  const INTERVAL = 40, TIMEOUT = 30;

  // ── 1+2: hung PING then late reply ──
  const hung = fakeClient();
  const notReady = fakeClient("reconnecting");
  registerRedisForDiag("hung", hung);
  registerRedisForDiag("notready", notReady);
  startRuntimeDiag("test", { intervalMs: INTERVAL, pingTimeoutMs: TIMEOUT });
  check("started with 2 timers + histogram", T.state().timers === 2 && T.state().histogram, T.state());
  await sleep(INTERVAL * 8);
  const hl = pingLines("hung");
  check("hung client: exactly ONE ping sent across ~8 sweeps", hung.pings === 1, { pings: hung.pings });
  check("first sweep logged timeout", hl.length > 0 && hl[0].includes(`outcome=timeout>${TIMEOUT}`), hl[0]);
  check("later sweeps logged skipped_prev_pending", hl.slice(1).length >= 3 && hl.slice(1).every((l) => l.includes("outcome=skipped_prev_pending")), hl.slice(1, 3));
  check("pingOutstanding bounded at 1", T.state().pingOutstanding === 1, T.state());

  // ── 4: not-ready client never pinged ──
  check("non-ready client never pinged", notReady.pings === 0 && pingLines("notready").every((l) => l.includes("outcome=skipped_not_ready")), { pings: notReady.pings });

  // late reply
  hung.pending[0].res("PONG");
  await Promise.resolve(); await Promise.resolve(); // let the settle handler run (no timer tick)
  check("late reply clears outstanding flag", T.state().pingOutstanding === 0, T.state());
  await sleep(INTERVAL * 3);
  check("after late reply the client is pinged again (exactly one new PING)", hung.pings === 2, { pings: hung.pings });
  hung.pending[1].res("PONG");
  hung.auto = true; // healthy server from now on
  await sleep(INTERVAL * 3);
  check("healthy ping logs outcome=ok", pingLines("hung").some((l) => l.includes("outcome=ok")));

  // ── 3: late rejection ──
  const rej = fakeClient();
  registerRedisForDiag("rej", rej);
  await sleep(INTERVAL * 3);
  check("rej client: one ping, timed out", rej.pings === 1 && pingLines("rej")[0]?.includes("timeout>"), pingLines("rej")[0]);
  rej.auto = true;
  rej.pending[0].rej(new Error("Connection is closed."));
  await Promise.resolve(); await Promise.resolve();
  check("late rejection clears outstanding flag", T.state().pingOutstanding === 0, T.state());
  await sleep(10);
  check("late rejection: no unhandledRejection", unhandled.length === 0 && true, { unhandled: unhandled.length, st: T.state() });

  // ── 5: BullMQ listeners ──
  const w1 = new EventEmitter(), w2 = new EventEmitter();
  attachBullLockDiag(w1);
  const n1 = w1.eventNames().reduce((a, e) => a + w1.listenerCount(e), 0);
  check("attach adds 6 listeners", n1 === 6 && T.state().bullListeners === 6, { n1 });
  attachBullLockDiag(w1);
  check("re-attach same worker is idempotent", w1.eventNames().reduce((a, e) => a + w1.listenerCount(e), 0) === 6);
  w1.emit("active", { id: "j1" });
  check("job tracked", T.state().trackedJobs === 2, T.state());
  attachBullLockDiag(w2);
  check("attach new worker detaches old (0 on w1, 6 on w2, stale job ids dropped)",
    w1.eventNames().length === 0 && T.state().bullListeners === 6 && T.state().trackedJobs === 0, T.state());

  // ── 6: stop + disable ──
  stopRuntimeDiag();
  const s = T.state();
  check("stop: timers=0, histogram off, listeners=0, clients=0, started=false",
    s.timers === 0 && !s.histogram && s.bullListeners === 0 && s.redisClients === 0 && !s.started && w2.eventNames().length === 0, s);
  const pingsAtStop = hung.pings + rej.pings, linesAtStop = lines.length;
  await sleep(INTERVAL * 3);
  check("after stop: no further pings or log lines", hung.pings + rej.pings === pingsAtStop && lines.length === linesAtStop, { d: lines.length - linesAtStop });

  // restart works, then disable tears it down and blocks re-start
  registerRedisForDiag("hung", hung);
  startRuntimeDiag("test", { intervalMs: INTERVAL, pingTimeoutMs: TIMEOUT });
  attachBullLockDiag(w1);
  check("restart after stop works", T.state().started && T.state().timers === 2 && T.state().bullListeners === 6, T.state());
  disableRuntimeDiag();
  const linesAtDisable = lines.length;
  startRuntimeDiag("test", { intervalMs: INTERVAL, pingTimeoutMs: TIMEOUT });
  attachBullLockDiag(w2);
  registerRedisForDiag("x", fakeClient());
  cancelTrace("a", { batch: 1 });
  await sleep(INTERVAL * 3);
  const d = T.state();
  check("disabled: all exports no-op (no timers/listeners/clients/log lines)",
    !d.enabled && !d.started && d.timers === 0 && d.bullListeners === 0 && d.redisClients === 0 &&
    w1.eventNames().length === 0 && w2.eventNames().length === 0 && lines.length === linesAtDisable,
    { d, newLines: lines.slice(linesAtDisable) });
  check("no unhandled rejections overall", unhandled.length === 0, unhandled.map(String));
}

main()
  .catch((e) => { failed++; origWarn("FATAL", e); })
  .finally(() => {
    console.log = origLog; console.warn = origWarn;
    clearInterval(keepAlive);
    console.log(`\nruntime-diag.unit: ${passed} passed, ${failed} failed`);
    process.exitCode = failed === 0 ? 0 : 1;
  });
