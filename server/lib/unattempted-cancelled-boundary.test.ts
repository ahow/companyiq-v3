/**
 * batch-1277 (item 5, part b) — explicit terminal outcome for URLs never attempted
 * because the operation was CANCELLED, against the REAL Postgres fetch-state store.
 *
 * The fetch loop in runFetchPhase exits the moment cancelCheck flips true. Before
 * this change the remaining 'pending' accepted documents were left 'pending' — a
 * silent drop: downstream, a pending doc reads as "still fetching" and feeds the
 * thin-corpus / readiness heuristics as though work were ongoing, so a cancelled
 * run looks indistinguishable from one that genuinely found nothing. The fix marks
 * every unattempted URL with an EXPLICIT terminal outcome
 * (fetch_status='dead', failure_reason='not_attempted_cancelled') — distinct from
 * 'budget_exceeded' so an audit can tell "cancelled before trying" from "ran out
 * of time". This test drives the extracted production helper markUnattemptedCancelled
 * against a real company + real documents rows and asserts the real DB transition.
 *
 * No Chromium, no network, no paid calls — only the real Postgres on DATABASE_URL.
 *
 *   DATABASE_URL=postgres://ciq:ciq@127.0.0.1:55432/ciq npx tsx server/lib/unattempted-cancelled-boundary.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

Object.assign(process.env, {
  DATABASE_URL: process.env.DATABASE_URL || "postgres://ciq:ciq@127.0.0.1:55432/ciq",
});

const { db, pool } = await import("../db.js");
const { sql } = await import("drizzle-orm");
const { markUnattemptedCancelled, NOT_ATTEMPTED_CANCELLED_REASON } = await import("./pipeline.js");
const storage = await import("../storage.js");

// Reuse an existing workspace (companies.workspace_id has an FK to workspaces).
// Companies are isolated by their own unique id + cleaned up, so sharing a
// workspace with other data is safe (no isin set → no unique-key collision).
let WS = 0;
async function pickWorkspace(): Promise<number> {
  const r = await db.execute(sql`SELECT id FROM workspaces ORDER BY id LIMIT 1`);
  const id = (r.rows[0] as any)?.id;
  assert.ok(id, "an existing workspace is required to anchor the test company");
  return Number(id);
}

async function makeCompany(name: string): Promise<number> {
  if (!WS) WS = await pickWorkspace();
  const r = await db.execute(sql`
    INSERT INTO companies (workspace_id, name) VALUES (${WS}, ${name}) RETURNING id
  `);
  return Number((r.rows[0] as any).id);
}

async function addAcceptedDoc(companyId: number, url: string, fetchStatus: string, reason: string | null = null): Promise<void> {
  // getAcceptedDocuments filters on gate_verdict='accept'; insert that verbatim.
  await db.execute(sql`
    INSERT INTO documents (company_id, url, title, type, gate_verdict, fetch_status, source_type, fetch_failures, failure_reason)
    VALUES (${companyId}, ${url}, 'T', 'pdf', 'accept', ${fetchStatus}, 'first_party', 0, ${reason})
  `);
}

async function rowByUrl(companyId: number, url: string): Promise<{ fetch_status: string; failure_reason: string | null }> {
  const r = await db.execute(sql`
    SELECT fetch_status, failure_reason FROM documents WHERE company_id = ${companyId} AND url = ${url} LIMIT 1
  `);
  return r.rows[0] as any;
}

async function cleanup(companyId: number): Promise<void> {
  await db.execute(sql`DELETE FROM documents WHERE company_id = ${companyId}`);
  await db.execute(sql`DELETE FROM companies WHERE id = ${companyId}`);
}

// ── B6-1 — unattempted (pending) URLs get the explicit cancelled outcome; already-
//           resolved docs are untouched ──────────────────────────────────────
test("B6-1 cancellation marks every unattempted URL not_attempted_cancelled and leaves resolved docs alone", async () => {
  const cid = await makeCompany("Cancel-Unattempted Co");
  try {
    await addAcceptedDoc(cid, "https://x.example/pending-1.pdf", "pending");
    await addAcceptedDoc(cid, "https://x.example/pending-2.pdf", "pending");
    await addAcceptedDoc(cid, "https://x.example/pending-3.pdf", "pending");
    await addAcceptedDoc(cid, "https://x.example/already-ok.pdf", "ok");
    await addAcceptedDoc(cid, "https://x.example/already-dead.pdf", "dead", "timeout");

    // Pre-condition: exactly the 3 pending docs are unattempted.
    const prePending = (await storage.getAcceptedDocuments(cid)).filter((d) => d.fetchStatus === "pending");
    assert.equal(prePending.length, 3, "3 pending docs seeded");

    const marked = await markUnattemptedCancelled(cid, "Cancel-Unattempted Co");
    assert.equal(marked, 3, "exactly the 3 unattempted URLs were marked");

    // Every formerly-pending URL is now an EXPLICIT terminal outcome — not a silent
    // 'pending' drop.
    for (const u of ["pending-1", "pending-2", "pending-3"]) {
      const row = await rowByUrl(cid, `https://x.example/${u}.pdf`);
      assert.equal(row.fetch_status, "dead", `${u} reached a terminal fetch_status`);
      assert.equal(row.failure_reason, NOT_ATTEMPTED_CANCELLED_REASON, `${u} names cancellation as the reason`);
    }

    // No 'pending' left behind — the silent-drop regression this guards against.
    const postPending = (await storage.getAcceptedDocuments(cid)).filter((d) => d.fetchStatus === "pending");
    assert.equal(postPending.length, 0, "no URL left silently pending after cancellation");

    // Already-resolved docs are untouched: the ok doc stays ok, the pre-existing
    // dead doc keeps its ORIGINAL reason (not overwritten with not_attempted_cancelled).
    const ok = await rowByUrl(cid, "https://x.example/already-ok.pdf");
    assert.equal(ok.fetch_status, "ok", "the fetched doc is untouched");
    const dead = await rowByUrl(cid, "https://x.example/already-dead.pdf");
    assert.equal(dead.fetch_status, "dead", "the pre-dead doc stays dead");
    assert.equal(dead.failure_reason, "timeout", "the pre-dead doc keeps its original reason, not overwritten");
  } finally {
    await cleanup(cid);
  }
});

// ── B6-2 — nothing pending → no-op, returns 0 ────────────────────────────────
test("B6-2 a fully-resolved corpus yields no marks (returns 0, mutates nothing)", async () => {
  const cid = await makeCompany("All-Resolved Co");
  try {
    await addAcceptedDoc(cid, "https://y.example/a.pdf", "ok");
    await addAcceptedDoc(cid, "https://y.example/b.pdf", "dead", "budget_exceeded");

    const marked = await markUnattemptedCancelled(cid, "All-Resolved Co");
    assert.equal(marked, 0, "nothing pending → nothing marked");

    const b = await rowByUrl(cid, "https://y.example/b.pdf");
    assert.equal(b.failure_reason, "budget_exceeded", "existing terminal reason untouched");
  } finally {
    await cleanup(cid);
  }
});

test.after(async () => { await pool.end().catch(() => {}); });
