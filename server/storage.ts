import { db } from "./db.js";
import { eq, and, sql, desc, asc, inArray, isNull } from "drizzle-orm";
import * as schema from "../shared/schema.js";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { buildRunKey, computeProgressSnapshot, deploymentFingerprintFromEnvironment, isHeartbeatStalled, type DeploymentFingerprint, type RunKeyInput, type RunLifecycleState } from "./lib/reliability.js";

// ─── URL Hashing for Content Deduplication ─────────────────────────────────

function hashUrl(url: string): string {
  // Normalize URL before hashing: lowercase, trim, remove trailing slash
  const normalized = url.trim().toLowerCase().replace(/\/+$/, "");
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

// ─── User Operations ────────────────────────────────────────────────────────

export async function createUser(email: string, password: string, name: string) {
  const passwordHash = await bcrypt.hash(password, 12);
  const [user] = await db.insert(schema.users).values({ email, passwordHash, name }).returning();
  return user;
}

export async function getUserByEmail(email: string) {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  return user || null;
}

export async function getUserById(id: number) {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, id));
  return user || null;
}

export async function verifyPassword(user: schema.User, password: string) {
  return bcrypt.compare(password, user.passwordHash);
}

/** Update a user's password (bcrypt cost 12). */
export async function updateUserPassword(userId: number, newPassword: string) {
  const passwordHash = await bcrypt.hash(newPassword, 12);
  await db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, userId));
}

// ─── Workspace Operations ───────────────────────────────────────────────────

export async function createWorkspace(name: string, ownerId: number) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const [workspace] = await db.insert(schema.workspaces).values({ name, slug, ownerId }).returning();
  // Add owner as a member
  await db.insert(schema.workspaceMembers).values({
    workspaceId: workspace.id,
    userId: ownerId,
    role: "owner",
  });
  return workspace;
}

export async function getUserWorkspaces(userId: number) {
  const memberships = await db
    .select({ workspace: schema.workspaces, role: schema.workspaceMembers.role })
    .from(schema.workspaceMembers)
    .innerJoin(schema.workspaces, eq(schema.workspaceMembers.workspaceId, schema.workspaces.id))
    .where(eq(schema.workspaceMembers.userId, userId));
  return memberships;
}

export async function getWorkspaceById(id: number) {
  const [workspace] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, id));
  return workspace || null;
}

export async function isWorkspaceMember(workspaceId: number, userId: number) {
  const [member] = await db
    .select()
    .from(schema.workspaceMembers)
    .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, userId)));
  return !!member;
}

export async function getAllWorkspaces() {
  return db.select({
    id: schema.workspaces.id,
    name: schema.workspaces.name,
    slug: schema.workspaces.slug,
  }).from(schema.workspaces).orderBy(asc(schema.workspaces.name));
}

export async function joinWorkspace(workspaceId: number, userId: number) {
  await db.insert(schema.workspaceMembers).values({
    workspaceId,
    userId,
    role: "member",
  }).onConflictDoNothing();
}

// ─── Workspace Member Management ────────────────────────────────────────────

// List all members of a workspace with their user details and role.
export async function getWorkspaceMembers(workspaceId: number) {
  return db
    .select({
      membershipId: schema.workspaceMembers.id,
      userId: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      role: schema.workspaceMembers.role,
      joinedAt: schema.workspaceMembers.joinedAt,
    })
    .from(schema.workspaceMembers)
    .innerJoin(schema.users, eq(schema.workspaceMembers.userId, schema.users.id))
    .where(eq(schema.workspaceMembers.workspaceId, workspaceId))
    .orderBy(asc(schema.users.name));
}

// Get a single member's role within a workspace (null if not a member).
export async function getMemberRole(workspaceId: number, userId: number): Promise<string | null> {
  const [member] = await db
    .select({ role: schema.workspaceMembers.role })
    .from(schema.workspaceMembers)
    .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, userId)));
  return member?.role ?? null;
}

// Add an existing user to a workspace with a given role (idempotent).
export async function addWorkspaceMember(workspaceId: number, userId: number, role: string = "member") {
  await db.insert(schema.workspaceMembers).values({ workspaceId, userId, role }).onConflictDoNothing();
  return getMemberRole(workspaceId, userId);
}

// Create a brand-new user and add them to the workspace in one step.
export async function createUserAndAddToWorkspace(
  email: string,
  password: string,
  name: string,
  workspaceId: number,
  role: string = "member"
) {
  const user = await createUser(email, password, name);
  await addWorkspaceMember(workspaceId, user.id, role);
  return user;
}

// Update a member's role within a workspace.
export async function updateMemberRole(workspaceId: number, userId: number, role: string) {
  await db
    .update(schema.workspaceMembers)
    .set({ role })
    .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, userId)));
  return getMemberRole(workspaceId, userId);
}

// Remove a member from a workspace.
export async function removeWorkspaceMember(workspaceId: number, userId: number) {
  await db
    .delete(schema.workspaceMembers)
    .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, userId)));
}

// Count members holding the "owner" role in a workspace (used to prevent
// removing or demoting the last owner).
export async function countWorkspaceOwners(workspaceId: number): Promise<number> {
  const rows = await db
    .select({ id: schema.workspaceMembers.id })
    .from(schema.workspaceMembers)
    .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.role, "owner")));
  return rows.length;
}

// ─── Company Operations (Workspace-Scoped) ──────────────────────────────────

export async function getCompanies(workspaceId: number) {
  return db.select({
    id: schema.companies.id,
    workspaceId: schema.companies.workspaceId,
    name: schema.companies.name,
    isin: schema.companies.isin,
    domain: schema.companies.domain,
    sector: schema.companies.sector,
    country: schema.companies.country,
    ticker: schema.companies.ticker,
    analysisStatus: schema.companies.analysisStatus,
    totalScore: schema.companies.totalScore,
    measuresMetCount: schema.companies.measuresMetCount,
    measuresTotalCount: schema.companies.measuresTotalCount,
    summary: schema.companies.summary,
    discoveryDiagnostics: schema.companies.discoveryDiagnostics,
    createdAt: schema.companies.createdAt,
    updatedAt: schema.companies.updatedAt,
  }).from(schema.companies).where(eq(schema.companies.workspaceId, workspaceId)).orderBy(asc(schema.companies.name));
}

export async function getCompanyById(companyId: number, workspaceId: number) {
  const [company] = await db
    .select()
    .from(schema.companies)
    .where(and(eq(schema.companies.id, companyId), eq(schema.companies.workspaceId, workspaceId)));
  return company || null;
}

export async function createCompany(data: schema.InsertCompany) {
  const [company] = await db.insert(schema.companies).values(data).returning();
  return company;
}

export async function updateCompany(companyId: number, workspaceId: number, data: Partial<schema.InsertCompany>) {
  const [company] = await db
    .update(schema.companies)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(schema.companies.id, companyId), eq(schema.companies.workspaceId, workspaceId)))
    .returning();
  return company;
}

export async function deleteCompany(companyId: number, workspaceId: number) {
  await db.delete(schema.companies).where(and(eq(schema.companies.id, companyId), eq(schema.companies.workspaceId, workspaceId)));
}

// ─── Company List Operations ────────────────────────────────────────────────

export async function getCompanyLists(workspaceId: number) {
  // Get own workspace lists + shared lists from other workspaces
  const lists = await db.select().from(schema.companyLists)
    .where(sql`${schema.companyLists.workspaceId} = ${workspaceId} OR ${schema.companyLists.isShared} = true`)
    .orderBy(desc(schema.companyLists.createdAt));
  
  // Add memberCount for each list
  const listsWithCounts = await Promise.all(
    lists.map(async (list) => {
      const [result] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.companyListMembers)
        .where(eq(schema.companyListMembers.listId, list.id));
      return { ...list, memberCount: result?.count || 0 };
    })
  );
  
  return listsWithCounts;
}

export async function createCompanyList(workspaceId: number, name: string, description?: string) {
  const [list] = await db.insert(schema.companyLists).values({ workspaceId, name, description }).returning();
  return list;
}

export async function updateCompanyList(listId: number, workspaceId: number, updates: { isShared?: boolean }) {
  await db.update(schema.companyLists)
    .set(updates)
    .where(and(eq(schema.companyLists.id, listId), eq(schema.companyLists.workspaceId, workspaceId)));
}

export async function getListCompanies(listId: number) {
  return db
    .select({ company: schema.companies })
    .from(schema.companyListMembers)
    .innerJoin(schema.companies, eq(schema.companyListMembers.companyId, schema.companies.id))
    .where(eq(schema.companyListMembers.listId, listId))
    .orderBy(asc(schema.companies.id));
}

export async function addCompanyToList(listId: number, companyId: number) {
  await db.insert(schema.companyListMembers).values({ listId, companyId }).onConflictDoNothing();
}

export async function removeCompanyFromList(listId: number, companyId: number) {
  await db.delete(schema.companyListMembers).where(
    and(eq(schema.companyListMembers.listId, listId), eq(schema.companyListMembers.companyId, companyId))
  );
}

// ─── Framework Operations (Workspace-Scoped) ────────────────────────────────

export async function getFrameworks(workspaceId: number) {
  // Get own workspace frameworks + shared frameworks from other workspaces
  return db.select().from(schema.frameworks)
    .where(sql`${schema.frameworks.workspaceId} = ${workspaceId} OR ${schema.frameworks.isShared} = true`)
    .orderBy(desc(schema.frameworks.updatedAt));
}

export async function getActiveFramework(workspaceId: number) {
  const [framework] = await db
    .select()
    .from(schema.frameworks)
    .where(and(eq(schema.frameworks.workspaceId, workspaceId), eq(schema.frameworks.isActive, true)));
  return framework || null;
}

export async function getFrameworkById(frameworkId: number, workspaceId: number) {
  // Also allow access to shared frameworks from other workspaces
  const [framework] = await db
    .select()
    .from(schema.frameworks)
    .where(sql`${schema.frameworks.id} = ${frameworkId} AND (${schema.frameworks.workspaceId} = ${workspaceId} OR ${schema.frameworks.isShared} = true)`);
  if (!framework) return null;

  // Instruction 50 — Root-cause fix (framework-agnostic, data-driven):
  //
  // Some frameworks have framework.evidenceKeywords stored as NULL because
  // topic-specific keywords are held per-measure in framework_measures rather
  // than at the framework row. Downstream code (HIGH_VALUE_RE fetch
  // prioritisation in pipeline.ts runFetchPhase; query-expansion; discovery)
  // reads (framework as any).evidenceKeywords and expects a populated array.
  // When it is NULL, the fetch-priority regex loses all topic-specific
  // patterns (only universal filings + document containers remain), causing
  // systematic under-retrieval on framework-relevant primary sources.
  //
  // The single source of truth is framework_measures.evidenceKeywords. This
  // block back-fills the framework-level view from the measure rows on every
  // read. No topic, company, or jurisdiction literal is introduced. New
  // frameworks inherit the same behaviour automatically. Behaviour is
  // deterministic (measure order + string sort).
  try {
    const existingKws = (framework as any).evidenceKeywords as string[] | null | undefined;
    if (!existingKws || existingKws.length === 0) {
      const measures = await getFrameworkMeasures(frameworkId);
      const kwSet = new Set<string>();
      for (const m of measures) {
        const mk = (m as any).evidenceKeywords as string[] | null | undefined;
        if (Array.isArray(mk)) {
          for (const kw of mk) {
            if (typeof kw === "string") {
              const norm = kw.trim().toLowerCase();
              if (norm.length >= 3) kwSet.add(norm);
            }
          }
        }
      }
      if (kwSet.size > 0) {
        // Sort by discriminativeness: longer multi-word phrases first (they are
        // more specific and better fetch-priority signals than short numeric or
        // year tokens like "2030"). Break length ties alphabetically for
        // determinism. Downstream code (pipeline.ts HIGH_VALUE_RE) truncates to
        // ~20 patterns via .slice(0, N); this ordering ensures the surviving
        // 20 are the most informative rather than the alphabetically-earliest.
        (framework as any).evidenceKeywords = Array.from(kwSet)
          .sort((a, b) => (b.length - a.length) || a.localeCompare(b));
      }
    }
  } catch (kwErr: any) {
    // Non-fatal: leave framework.evidenceKeywords as-is if measure lookup fails.
    console.warn(`[getFrameworkById] evidenceKeywords back-fill failed for framework ${frameworkId}: ${kwErr?.message ?? kwErr}`);
  }

  return framework;
}

export async function createFramework(data: schema.InsertFramework) {
  const [framework] = await db.insert(schema.frameworks).values(data).returning();
  return framework;
}

export async function setActiveFramework(frameworkId: number, workspaceId: number) {
  // Deactivate all frameworks in workspace
  await db.update(schema.frameworks).set({ isActive: false }).where(eq(schema.frameworks.workspaceId, workspaceId));
  // Activate the specified one
  await db.update(schema.frameworks).set({ isActive: true }).where(
    and(eq(schema.frameworks.id, frameworkId), eq(schema.frameworks.workspaceId, workspaceId))
  );
}

export async function getFrameworkMeasures(frameworkId: number) {
  return db
    .select()
    .from(schema.frameworkMeasures)
    .where(eq(schema.frameworkMeasures.frameworkId, frameworkId))
    .orderBy(asc(schema.frameworkMeasures.categoryNumber), asc(schema.frameworkMeasures.displayOrder));
}

export async function createFrameworkMeasure(data: schema.InsertFrameworkMeasure) {
  const [measure] = await db.insert(schema.frameworkMeasures).values(data).returning();
  return measure;
}

export async function deleteFrameworkMeasures(frameworkId: number) {
  await db.delete(schema.frameworkMeasures).where(eq(schema.frameworkMeasures.frameworkId, frameworkId));
}

// ─── Document Operations (with Content Deduplication) ───────────────────────

export async function getAcceptedDocuments(companyId: number) {
  return db
    .select({
      id: schema.documents.id,
      companyId: schema.documents.companyId,
      url: schema.documents.url,
      title: schema.documents.title,
      type: schema.documents.type,
      gateVerdict: schema.documents.gateVerdict,
      gateReason: schema.documents.gateReason,
      fetchStatus: schema.documents.fetchStatus,
      fetchFailures: schema.documents.fetchFailures,
      failureReason: schema.documents.failureReason,
      sourceType: schema.documents.sourceType,
      fetchedAt: schema.documents.fetchedAt,
      createdAt: schema.documents.createdAt,
    })
    .from(schema.documents)
    .where(and(eq(schema.documents.companyId, companyId), eq(schema.documents.gateVerdict, "accept")))
    .orderBy(asc(schema.documents.id));  // 37-A.1: deterministic ordering
}

/**
 * U17: Update a document's source_type after re-classification with full
 * content. Used by the pipeline's corpus-build provenance filter to persist
 * upgrades (title-only misclassified third_party → issuer once content shows
 * an identity match) and downgrades (title-suggested issuer → third_party
 * when full content reveals the doc doesn't actually reference the issuer).
 */
export async function updateDocumentSourceType(
  docId: number,
  sourceType: "first_party" | "third_party"
): Promise<void> {
  await db.execute(sql`
    UPDATE documents SET source_type = ${sourceType} WHERE id = ${docId}
  `);
}

/**
 * Document Pool: returns ALL ever-successfully-fetched documents for a company,
 * regardless of current fetch_status. This includes docs that were fetched in
 * prior runs (even under different frameworks) and may have been reset since.
 * The pool is safe because BM25 + topic-term signal self-filter off-topic docs.
 */
export async function getAllFetchedDocumentsForCompany(companyId: number) {
  // Return all documents that have content (either via content_id or inline),
  // including those currently marked 'ok' AND those that have content_id set
  // (meaning they were successfully fetched at some point, even if later reset).
  const rows = await db.execute(sql`
    SELECT d.id, d.company_id, d.url, d.title, d.type, d.gate_verdict,
           d.gate_reason, d.fetch_status, d.fetch_failures, d.fetched_at, d.created_at,
           d.source_type,
           COALESCE(dc.content, d.content) AS content
    FROM documents d
    LEFT JOIN document_content dc ON dc.id = d.content_id
    WHERE d.company_id = ${companyId}
      AND (d.fetch_status = 'ok' OR d.content_id IS NOT NULL)
      AND COALESCE(dc.content_length, length(d.content)) > 50
    ORDER BY d.id
  `);
  return rows.rows as Array<{
    id: number;
    company_id: number;
    url: string;
    title: string | null;
    type: string;
    gate_verdict: string | null;
    gate_reason: string | null;
    fetch_status: string;
    fetch_failures: number;
    fetched_at: Date | null;
    created_at: Date;
    source_type: string | null;
    content: string | null;
  }>;
}

export async function getFetchedDocuments(companyId: number) {
  // JOIN with document_content to get deduplicated content
  // Falls back to inline content column for rows not yet migrated
  const rows = await db.execute(sql`
    SELECT d.id, d.company_id, d.url, d.title, d.type, d.gate_verdict,
           d.gate_reason, d.fetch_status, d.fetch_failures, d.fetched_at, d.created_at,
           COALESCE(dc.content, d.content) AS content
    FROM documents d
    LEFT JOIN document_content dc ON dc.id = d.content_id
    WHERE d.company_id = ${companyId} AND d.fetch_status = 'ok'
    ORDER BY d.id                             -- 37-A.2: deterministic ordering
  `);
  return rows.rows as Array<{
    id: number;
    company_id: number;
    url: string;
    title: string | null;
    type: string;
    gate_verdict: string | null;
    gate_reason: string | null;
    fetch_status: string;
    fetch_failures: number;
    fetched_at: Date | null;
    created_at: Date;
    content: string | null;
  }>;
}

/**
 * Total character count of the company's USABLE corpus (all `ok` documents,
 * COALESCE-joined to deduplicated content). This is the decisive signal that
 * lets the auto-reexamination gate distinguish a fetch-coverage artifact (thin
 * corpus because key docs died) from a LEGITIMATE zero (a large real corpus
 * that simply contains no qualifying disclosure). A 3.6M-char corpus is never a
 * fetch failure, regardless of how many ancillary URLs went `dead`.
 */
export async function getCorpusCharCount(companyId: number): Promise<number> {
  const rows = await db.execute(sql`
    SELECT COALESCE(SUM(length(COALESCE(dc.content, d.content))), 0) AS total
    FROM documents d
    LEFT JOIN document_content dc ON dc.id = d.content_id
    WHERE d.company_id = ${companyId} AND d.fetch_status = 'ok'
  `);
  return Number((rows.rows[0] as any)?.total || 0);
}

export async function upsertDocument(data: { companyId: number; url: string; title?: string; type: string; gateVerdict: string; gateReason?: string; sourceType?: string }) {
  const [doc] = await db
    .insert(schema.documents)
    .values(data)
    .onConflictDoUpdate({
      target: [schema.documents.companyId, schema.documents.url],
      set: { title: data.title, gateVerdict: data.gateVerdict, gateReason: data.gateReason, sourceType: data.sourceType },
    })
    .returning();
  return doc;
}

export async function getDocumentByUrl(companyId: number, url: string) {
  const rows = await db.execute(sql`
    SELECT id FROM documents WHERE company_id = ${companyId} AND url = ${url} LIMIT 1
  `);
  return (rows.rows as any[])?.[0] || null;
}

export async function addDiscoveredDocument(companyId: number, url: string, title: string, sourceType: string) {
  await db.execute(sql`
    INSERT INTO documents (company_id, url, title, type, gate_verdict, gate_reason, fetch_status, source_type, fetch_failures)
    VALUES (${companyId}, ${url}, ${title}, 'pdf', 'accepted', 'pdf_harvest', 'pending', ${sourceType}, 0)
    ON CONFLICT (company_id, url) DO NOTHING
  `);
}

export async function recordFetchSuccess(companyId: number, url: string, content: string) {
  // Step 1: Upsert content into the deduplicated document_content table
  const urlHash = hashUrl(url);
  const contentLength = content.length;

  const dcResult = await db.execute(sql`
    INSERT INTO document_content (url_hash, url, content, content_length, created_at, updated_at)
    VALUES (${urlHash}, ${url}, ${content}, ${contentLength}, NOW(), NOW())
    ON CONFLICT (url_hash) DO UPDATE SET
      content = EXCLUDED.content,
      content_length = EXCLUDED.content_length,
      updated_at = NOW()
    RETURNING id
  `);
  const contentId = (dcResult.rows[0] as any)?.id;

  // Step 2: Update the documents row to reference the content and mark as fetched
  await db.execute(sql`
    UPDATE documents SET
      fetch_status = 'ok',
      content_id = ${contentId},
      content = NULL,
      fetched_at = NOW()
    WHERE company_id = ${companyId} AND url = ${url}
  `);
}

export async function recordFetchFailure(companyId: number, url: string, failureReason?: string) {
  await db.execute(sql`
    UPDATE documents SET fetch_failures = fetch_failures + 1,
    fetch_status = CASE WHEN fetch_failures + 1 >= 3 THEN 'dead' ELSE 'pending' END,
    failure_reason = COALESCE(${failureReason || null}, failure_reason)
    WHERE company_id = ${companyId} AND url = ${url}
  `);
}

/**
 * One-shot terminal failure: mark a URL 'dead' immediately, without waiting for
 * the 3-strike counter. Used for failures that will NOT resolve on retry within
 * the same run (401 paywall, 403 CDN block) and for per-document timeouts (a URL
 * that times out is the single most budget-expensive failure mode and almost
 * never succeeds on a subsequent pass in the same run). This stops the fetch
 * loop from burning multiple passes — and minutes of the fetch budget — on URLs
 * that are effectively unreachable.
 */
export async function recordFetchDead(companyId: number, url: string, failureReason?: string) {
  await db.execute(sql`
    UPDATE documents SET fetch_failures = 3, fetch_status = 'dead',
    failure_reason = COALESCE(${failureReason || null}, failure_reason)
    WHERE company_id = ${companyId} AND url = ${url}
  `);
}

/**
 * Terminal rejection: the post-fetch LLM verifier determined this document
 * belongs to a DIFFERENT company (or is generic/non-disclosure). Mark it
 * 'rejected' so it is (a) excluded from scoring (getAcceptedDocuments only
 * returns 'ok'), (b) never retried (status is terminal, not 'pending'), and
 * (c) purged on the next re-discovery. The reason/issuer is stored in
 * gate_reason for auditability. Any previously linked content reference is
 * cleared so the wrong-company text cannot leak into analysis.
 */
export async function recordVerificationReject(companyId: number, url: string, reason: string, batchId?: number) {
  await db.execute(sql`
    UPDATE documents SET
      fetch_status = 'rejected',
      fetch_failures = 99,
      content_id = NULL,
      content = NULL,
      gate_verdict = 'reject',
      gate_reason = ${reason.slice(0, 500)}
    WHERE company_id = ${companyId} AND url = ${url}
  `);
  if (batchId != null) {
    const [batch] = await db.select({ workspaceId: schema.batchRuns.workspaceId, reliabilityRunId: schema.batchRuns.reliabilityRunId })
      .from(schema.batchRuns).where(eq(schema.batchRuns.id, batchId)).limit(1);
    await recordReliabilityAuditEvent({
      workspaceId: batch?.workspaceId ?? 0,
      runId: batch?.reliabilityRunId ?? null,
      batchId,
      artifactId: url,
      eventType: "rejection",
      reason: `document verification rejected: ${reason}`,
      metadata: { companyId, url },
    });
  }
}

/**
 * Fix 4 (Fetch Stability): Look up previously-fetched content for a URL from the
 * global document_content table. Returns the content string if found, null otherwise.
 * This enables reuse of content that was successfully fetched in a prior run.
 */
export async function getContentByUrl(url: string): Promise<string | null> {
  const urlHash = hashUrl(url);
  const rows = await db.execute(sql`
    SELECT content FROM document_content WHERE url_hash = ${urlHash} AND content_length > 50 LIMIT 1
  `);
  return (rows.rows as any[])?.[0]?.content || null;
}

/**
 * Cross-workspace document reuse: for any pending documents that already have
 * content in the global document_content table (fetched for ANOTHER company),
 * link the cached content to avoid re-fetching the same URL.
 *
 * IMPORTANT (contamination fix): the global document_content cache is keyed only
 * by URL hash and is shared across ALL companies/workspaces. A shared-CDN URL
 * (e.g. s206.q4cdn.com/.../10-K.pdf) fetched once for company A would otherwise
 * be linked to company B and marked 'ok', BYPASSING the post-fetch issuer
 * verifier — which is exactly how a Pfizer 10-K became attached to 3SBio.
 *
 * Therefore reused content is linked but marked 'needs_verify' (NOT 'ok'), so
 * the pipeline still runs the same issuer-verification on it (using the cached
 * content, so no network re-fetch is needed) before it can be scored.
 */
export async function linkExistingContent(companyId: number): Promise<number> {
  // URL normalization must match hashUrl(): lowercase, trim, remove trailing slash
  const result = await db.execute(sql`
    UPDATE documents d
    SET content_id = dc.id,
        fetch_status = 'needs_verify',
        fetched_at = NOW(),
        content = NULL
    FROM document_content dc
    WHERE d.company_id = ${companyId}
      AND d.fetch_status = 'pending'
      AND dc.url_hash = encode(sha256(regexp_replace(lower(trim(d.url)), '/+$', '')::bytea), 'hex')
  `);
  return result.rowCount || 0;
}

/**
 * Return documents that were linked from cached content and still need issuer
 * verification ('needs_verify'), including the cached content text so the
 * pipeline can verify without re-fetching.
 */
export async function getDocumentsNeedingVerification(companyId: number) {
  const rows = await db.execute(sql`
    SELECT d.id, d.url, d.title, d.type,
           COALESCE(dc.content, d.content) AS content
    FROM documents d
    LEFT JOIN document_content dc ON dc.id = d.content_id
    WHERE d.company_id = ${companyId} AND d.fetch_status = 'needs_verify'
  `);
  return rows.rows as Array<{
    id: number;
    url: string;
    title: string | null;
    type: string;
    content: string | null;
  }>;
}

/**
 * Promote a verified, cache-linked document to 'ok' (keeps its existing
 * content_id; no re-fetch). Used after issuer verification of reused content.
 */
export async function markLinkedDocumentVerified(companyId: number, url: string) {
  await db.execute(sql`
    UPDATE documents SET fetch_status = 'ok', fetched_at = NOW()
    WHERE company_id = ${companyId} AND url = ${url} AND fetch_status = 'needs_verify'
  `);
}

export async function clearDiscoveredDocuments(companyId: number) {
  // Clear PENDING documents (never fetched from prior runs)
  await db.delete(schema.documents).where(
    and(eq(schema.documents.companyId, companyId), eq(schema.documents.fetchStatus, "pending"))
  );
  // Also clear DEAD documents (failed fetches from prior runs) — these are noise
  // that should not persist across re-discovery runs. Successfully fetched docs
  // (status: "ok") are preserved for reuse.
  await db.delete(schema.documents).where(
    and(eq(schema.documents.companyId, companyId), eq(schema.documents.fetchStatus, "dead"))
  );
  // Rejected documents are terminal evidence artifacts. Preserve them with their
  // gate_reason; only an explicit full reset may remove them, and that path audits
  // the deletion. This prevents silent loss of contamination evidence.
  // Clear NEEDS_VERIFY documents (cache-linked but not yet issuer-verified) —
  // these are transient and must be re-evaluated on each re-discovery.
  await db.delete(schema.documents).where(
    and(eq(schema.documents.companyId, companyId), eq(schema.documents.fetchStatus, "needs_verify"))
  );
}

// Full reset: purge ALL documents including successfully fetched ones
export async function fullResetCompanyDocuments(companyId: number) {
  const [company] = await db.select({ workspaceId: schema.companies.workspaceId }).from(schema.companies).where(eq(schema.companies.id, companyId)).limit(1);
  const count = await db.execute(sql`SELECT COUNT(*)::int AS n FROM documents WHERE company_id = ${companyId}`);
  await db.delete(schema.documents).where(eq(schema.documents.companyId, companyId));
  if (company) {
    await recordReliabilityAuditEvent({ workspaceId: company.workspaceId, eventType: "deletion", reason: "explicit company full reset deleted document artifacts", metadata: { companyId, deletedDocumentCount: Number((count.rows[0] as any)?.n || 0) } });
  }
}

// Bulk full reset all companies in a workspace (purge ALL documents)
export async function fullResetAllCompanies(workspaceId: number): Promise<number> {
  // Delete all measure scores for companies in this workspace
  await db.execute(sql`
    DELETE FROM measure_scores WHERE company_id IN (
      SELECT id FROM companies WHERE workspace_id = ${workspaceId}
    )
  `);
  // Delete ALL documents (including ok) for a completely fresh start
    const deletedDocs = await db.execute(sql`SELECT COUNT(*)::int AS n FROM documents WHERE company_id IN (SELECT id FROM companies WHERE workspace_id = ${workspaceId})`);
    await db.execute(sql`
      DELETE FROM documents WHERE company_id IN (
        SELECT id FROM companies WHERE workspace_id = ${workspaceId}
      )
    `);
    await recordReliabilityAuditEvent({ workspaceId, eventType: "deletion", reason: "explicit workspace full reset deleted document artifacts", metadata: { deletedDocumentCount: Number((deletedDocs.rows[0] as any)?.n || 0) } });
  // Reset all companies (42-C: also clear FIGI + domain caches)
  await db.execute(sql`
    UPDATE companies SET
      analysis_status = 'idle',
      total_score = NULL,
      summary = NULL,
      measures_met_count = NULL,
      measures_total_count = NULL,
      discovery_diagnostics = NULL,
      figi_name = NULL,
      figi_ticker = NULL,
      figi_resolved_at = NULL,
      figi_pipeline_version = NULL,
      related_domains = NULL,
      related_domains_pipeline_version = NULL,
      updated_at = NOW()
    WHERE workspace_id = ${workspaceId}
  `);
  const countResult = await db.execute(sql`SELECT COUNT(*) as cnt FROM companies WHERE workspace_id = ${workspaceId}`);
  return (countResult.rows[0] as any)?.cnt || 0;
}

// Bulk full reset all companies in a specific list (purge ALL documents)
export async function fullResetListCompanies(listId: number, workspaceId: number): Promise<number> {
  // Delete measure scores for companies in this list
  await db.execute(sql`
    DELETE FROM measure_scores WHERE company_id IN (
      SELECT company_id FROM company_list_members WHERE list_id = ${listId}
    )
  `);
  // Delete ALL documents (including ok)
  const deletedDocs = await db.execute(sql`SELECT COUNT(*)::int AS n FROM documents WHERE company_id IN (SELECT company_id FROM company_list_members WHERE list_id = ${listId})`);
  await db.execute(sql`
      DELETE FROM documents WHERE company_id IN (
        SELECT company_id FROM company_list_members WHERE list_id = ${listId}
      )
    `);
  await recordReliabilityAuditEvent({ workspaceId, eventType: "deletion", reason: "explicit list full reset deleted document artifacts", metadata: { listId, deletedDocumentCount: Number((deletedDocs.rows[0] as any)?.n || 0) } });
  // Reset companies in this list (42-C: also clear FIGI + domain caches)
  await db.execute(sql`
    UPDATE companies SET
      analysis_status = 'idle',
      total_score = NULL,
      summary = NULL,
      measures_met_count = NULL,
      measures_total_count = NULL,
      discovery_diagnostics = NULL,
      figi_name = NULL,
      figi_ticker = NULL,
      figi_resolved_at = NULL,
      figi_pipeline_version = NULL,
      related_domains = NULL,
      related_domains_pipeline_version = NULL,
      updated_at = NOW()
    WHERE id IN (
      SELECT company_id FROM company_list_members WHERE list_id = ${listId}
    ) AND workspace_id = ${workspaceId}
  `);
  const countResult = await db.execute(sql`SELECT COUNT(*) as cnt FROM company_list_members WHERE list_id = ${listId}`);
  return (countResult.rows[0] as any)?.cnt || 0;
}


// ─── Discovery Cache Reset (42-C) ───────────────────────────────────────────

export async function resetCompanyDiscoveryCache(companyId: number, workspaceId: number) {
  await db.execute(sql`
    UPDATE companies SET
      figi_name = NULL,
      figi_ticker = NULL,
      figi_resolved_at = NULL,
      figi_pipeline_version = NULL,
      related_domains = NULL,
      related_domains_pipeline_version = NULL,
      updated_at = NOW()
    WHERE id = ${companyId} AND workspace_id = ${workspaceId}
  `);
}

export async function resetListDiscoveryCache(listId: number, workspaceId: number): Promise<number> {
  const result = await db.execute(sql`
    UPDATE companies SET
      figi_name = NULL,
      figi_ticker = NULL,
      figi_resolved_at = NULL,
      figi_pipeline_version = NULL,
      related_domains = NULL,
      related_domains_pipeline_version = NULL,
      updated_at = NOW()
    WHERE workspace_id = ${workspaceId}
      AND id IN (SELECT company_id FROM company_list_members WHERE list_id = ${listId})
  `);
  return (result as any).rowCount ?? 0;
}
// ─── Measure Score Operations ───────────────────────────────────────────────

export async function getMeasureScores(companyId: number, frameworkId?: number) {
  if (frameworkId) {
    return db.select().from(schema.measureScores).where(
      and(eq(schema.measureScores.companyId, companyId), eq(schema.measureScores.frameworkId, frameworkId))
    ).orderBy(asc(schema.measureScores.categoryNumber), asc(schema.measureScores.displayOrder));
  }
  return db.select().from(schema.measureScores).where(eq(schema.measureScores.companyId, companyId))
    .orderBy(asc(schema.measureScores.categoryNumber), asc(schema.measureScores.displayOrder));
}

export async function createMeasureScores(scores: any[]) {
  if (scores.length === 0) return;
  await db.insert(schema.measureScores).values(scores);
}

export async function clearMeasureScores(companyId: number) {
  await db.delete(schema.measureScores).where(eq(schema.measureScores.companyId, companyId));
}

/**
 * Framework-scoped score clearing: deletes only the scores for a specific
 * framework, preserving scores from other frameworks. This prevents one
 * framework's analysis run from overwriting another framework's results.
 */
export async function clearMeasureScoresForFramework(companyId: number, frameworkId: number) {
  await db.delete(schema.measureScores).where(
    and(eq(schema.measureScores.companyId, companyId), eq(schema.measureScores.frameworkId, frameworkId))
  );
}

// Bulk reset all companies in a workspace (efficient single SQL statements)
export async function resetAllCompanies(workspaceId: number): Promise<number> {
  // Delete all measure scores for companies in this workspace
  await db.execute(sql`
    DELETE FROM measure_scores WHERE company_id IN (
      SELECT id FROM companies WHERE workspace_id = ${workspaceId}
    )
  `);
  // Clear dead and pending documents so fresh discovery can find better sources
  await db.execute(sql`
    DELETE FROM documents WHERE company_id IN (
      SELECT id FROM companies WHERE workspace_id = ${workspaceId}
    ) AND fetch_status IN ('pending', 'dead')
  `);
  // Reset all companies in one UPDATE
  const result = await db.execute(sql`
    UPDATE companies SET
      analysis_status = 'idle',
      total_score = NULL,
      summary = NULL,
      measures_met_count = NULL,
      measures_total_count = NULL,
      updated_at = NOW()
    WHERE workspace_id = ${workspaceId} AND analysis_status != 'idle'
  `);
  // Also reset idle ones that might have stale scores
  await db.execute(sql`
    UPDATE companies SET
      total_score = NULL,
      summary = NULL,
      measures_met_count = NULL,
      measures_total_count = NULL,
      updated_at = NOW()
    WHERE workspace_id = ${workspaceId} AND total_score IS NOT NULL
  `);
  // Return count of all companies in workspace
  const countResult = await db.execute(sql`SELECT COUNT(*) as cnt FROM companies WHERE workspace_id = ${workspaceId}`);
  return (countResult.rows[0] as any)?.cnt || 0;
}

// Bulk reset all companies in a specific list
export async function resetListCompanies(listId: number, workspaceId: number): Promise<number> {
  // Delete measure scores for companies in this list
  await db.execute(sql`
    DELETE FROM measure_scores WHERE company_id IN (
      SELECT company_id FROM company_list_members WHERE list_id = ${listId}
    )
  `);
  // Clear dead and pending documents so fresh discovery can find better sources
  await db.execute(sql`
    DELETE FROM documents WHERE company_id IN (
      SELECT company_id FROM company_list_members WHERE list_id = ${listId}
    ) AND fetch_status IN ('pending', 'dead')
  `);
  // Reset companies in this list
  await db.execute(sql`
    UPDATE companies SET
      analysis_status = 'idle',
      total_score = NULL,
      summary = NULL,
      measures_met_count = NULL,
      measures_total_count = NULL,
      updated_at = NOW()
    WHERE id IN (
      SELECT company_id FROM company_list_members WHERE list_id = ${listId}
    ) AND workspace_id = ${workspaceId}
  `);
  // Return count of members in the list
  const countResult = await db.execute(sql`SELECT COUNT(*) as cnt FROM company_list_members WHERE list_id = ${listId}`);
  return (countResult.rows[0] as any)?.cnt || 0;
}

// ─── Framework Resolution Helper ────────────────────────────────────────────

export async function getMostRecentFrameworkIdForCompany(companyId: number, workspaceId: number): Promise<number | null> {
  const rows = await db.execute(sql`
    SELECT framework_id
    FROM analysis_jobs
    WHERE company_id = ${companyId} AND workspace_id = ${workspaceId} AND framework_id IS NOT NULL
    ORDER BY created_at DESC LIMIT 1
  `).then((x: any) => x.rows);
  return rows?.[0]?.framework_id ?? null;
}

// ─── Reliability Run Operations ──────────────────────────────────────────────

export type ReliabilityRunCreateInput = RunKeyInput & {
  workspaceId: number;
  commitSha: string;
  deploymentFingerprint: DeploymentFingerprint;
  diagnosticRun?: boolean;
};

export async function getReliabilityRunsForCycle(testCycleId: string, workspaceId: number) {
  return db.select({ batteryLabel: schema.reliabilityRuns.batteryLabel, lifecycleState: schema.reliabilityRuns.lifecycleState, acceptanceState: schema.reliabilityRuns.acceptanceState, runKey: schema.reliabilityRuns.runKey })
    .from(schema.reliabilityRuns)
    .where(and(eq(schema.reliabilityRuns.testCycleId, testCycleId), eq(schema.reliabilityRuns.workspaceId, workspaceId)))
    .orderBy(asc(schema.reliabilityRuns.id));
}

export async function getReliabilityRunByKey(runKey: string, workspaceId?: number) {
  const conditions = workspaceId == null
    ? eq(schema.reliabilityRuns.runKey, runKey)
    : and(eq(schema.reliabilityRuns.runKey, runKey), eq(schema.reliabilityRuns.workspaceId, workspaceId));
  const [run] = await db.select().from(schema.reliabilityRuns).where(conditions).limit(1);
  return run || null;
}

export async function createOrAdoptReliabilityRun(input: ReliabilityRunCreateInput): Promise<{ run: schema.ReliabilityRun; adopted: boolean }> {
  const runKey = buildRunKey(input);
  const existing = await getReliabilityRunByKey(runKey, input.workspaceId);
  if (existing) return { run: existing, adopted: true };
  try {
    const [run] = await db.insert(schema.reliabilityRuns).values({
      workspaceId: input.workspaceId,
      testCycleId: input.testCycleId,
      runKey,
      commitSha: input.commitSha,
      frameworkId: input.frameworkId,
      listId: input.listId ?? null,
      batteryLabel: input.batteryLabel,
      deploymentFingerprint: input.deploymentFingerprint,
      diagnosticRun: input.diagnosticRun ?? false,
      lifecycleState: "created",
      acceptanceState: "pending",
    }).returning();
    if (!run) throw new Error("Reliability run insert returned no row");
    return { run, adopted: false };
  } catch (error: any) {
    if (error?.code !== "23505") throw error;
    const raced = await getReliabilityRunByKey(runKey, input.workspaceId);
    if (!raced) throw error;
    return { run: raced, adopted: true };
  }
}

export async function updateReliabilityRunLifecycle(runId: number, state: RunLifecycleState, fields: {
  acceptanceState?: string;
  artifactId?: string | null;
  rejectionReason?: string | null;
  lastHeartbeatAt?: Date;
  lastProgressAt?: Date;
  terminalAt?: Date;
} = {}) {
  const now = new Date();
  const values: Record<string, unknown> = { lifecycleState: state };
  if (state === "running") values.startedAt = now;
  if (state === "terminal_success" || state === "terminal_failed" || state === "cancelled" || state === "accepted" || state === "rejected") {
    values.terminalAt = fields.terminalAt ?? now;
  }
  if (fields.acceptanceState !== undefined) values.acceptanceState = fields.acceptanceState;
  if (fields.artifactId !== undefined) values.artifactId = fields.artifactId;
  if (fields.rejectionReason !== undefined) values.rejectionReason = fields.rejectionReason;
  if (fields.lastHeartbeatAt !== undefined) values.lastHeartbeatAt = fields.lastHeartbeatAt;
  if (fields.lastProgressAt !== undefined) values.lastProgressAt = fields.lastProgressAt;
  const [run] = await db.update(schema.reliabilityRuns).set(values as any).where(eq(schema.reliabilityRuns.id, runId)).returning();
  return run || null;
}

export async function markReliabilityRunAccepted(runId: number, batchId: number, artifactId: string, reason = "complete evidence snapshot accepted") {
  const [run] = await db.select().from(schema.reliabilityRuns).where(eq(schema.reliabilityRuns.id, runId)).limit(1);
  if (!run) return null;
  // Durable acceptance gate: artifactId must be non-null and the analysis_results
  // snapshot row must already exist before we flip acceptance state. This prevents
  // acceptanceState=accepted with artifactId=None.
  if (!artifactId) {
    console.error(`[markReliabilityRunAccepted] Refusing to accept run ${runId}: artifactId is null/empty`);
    return null;
  }
  // Verify the snapshot row exists in analysis_results before accepting
  const snapshotCheck = await db.execute(sql`
    SELECT id FROM analysis_results
    WHERE batch_id = ${batchId} AND run_key = ${run.runKey} AND immutable_snapshot = TRUE
    LIMIT 1
  `);
  if (snapshotCheck.rows.length === 0) {
    console.error(`[markReliabilityRunAccepted] Refusing to accept run ${runId}: no analysis_results snapshot found for batch ${batchId}, run_key ${run.runKey}`);
    return null;
  }
  const updated = await updateReliabilityRunLifecycle(runId, "accepted", { acceptanceState: "accepted", artifactId, rejectionReason: null });
  await db.execute(sql`UPDATE batch_runs SET acceptance_state = 'accepted', artifact_id = ${artifactId}, rejection_reason = NULL WHERE id = ${batchId}`);
  await db.execute(sql`UPDATE analysis_results SET acceptance_state = 'accepted', accepted_at = NOW(), rejection_reason = NULL WHERE batch_id = ${batchId} AND run_key = ${run.runKey} AND immutable_snapshot = TRUE`);
  await recordReliabilityAuditEvent({ workspaceId: run.workspaceId, runId, batchId, artifactId, eventType: "acceptance", fromState: run.lifecycleState, toState: "accepted", reason });
  return updated;
}

export async function markReliabilityRunRejected(runId: number, batchId: number, reason: string, artifactId?: string | null) {
  const [run] = await db.select().from(schema.reliabilityRuns).where(eq(schema.reliabilityRuns.id, runId)).limit(1);
  if (!run) return null;
  const updated = await updateReliabilityRunLifecycle(runId, "rejected", { acceptanceState: "rejected", artifactId: artifactId ?? null, rejectionReason: reason });
  await db.execute(sql`UPDATE batch_runs SET acceptance_state = 'rejected', artifact_id = ${artifactId ?? null}, rejection_reason = ${reason} WHERE id = ${batchId}`);
  await db.execute(sql`UPDATE analysis_results SET acceptance_state = 'rejected', rejection_reason = ${reason} WHERE batch_id = ${batchId} AND run_key = ${run.runKey} AND immutable_snapshot = TRUE`);
  await recordReliabilityAuditEvent({ workspaceId: run.workspaceId, runId, batchId, artifactId: artifactId ?? null, eventType: "rejection", fromState: run.lifecycleState, toState: "rejected", reason });
  return updated;
}

export async function recordReliabilityAuditEvent(data: {
  workspaceId: number;
  runId?: number | null;
  batchId?: number | null;
  artifactId?: string | null;
  eventType: string;
  fromState?: string | null;
  toState?: string | null;
  reason: string;
  metadata?: unknown;
}) {
  const [event] = await db.insert(schema.reliabilityAuditEvents).values({
    workspaceId: data.workspaceId,
    runId: data.runId ?? null,
    batchId: data.batchId ?? null,
    artifactId: data.artifactId ?? null,
    eventType: data.eventType,
    fromState: data.fromState ?? null,
    toState: data.toState ?? null,
    reason: data.reason,
    metadata: data.metadata ?? null,
  }).returning();
  return event;
}

export async function getBatchRunByRunKey(runKey: string, workspaceId: number) {
  const [batch] = await db.select().from(schema.batchRuns)
    .where(and(eq(schema.batchRuns.runKey, runKey), eq(schema.batchRuns.workspaceId, workspaceId)))
    .orderBy(asc(schema.batchRuns.id))
    .limit(1);
  return batch || null;
}

export async function getBatchRunByReliabilityRunId(runId: number, workspaceId: number) {
  const [batch] = await db.select().from(schema.batchRuns)
    .where(and(eq(schema.batchRuns.reliabilityRunId, runId), eq(schema.batchRuns.workspaceId, workspaceId)))
    .orderBy(asc(schema.batchRuns.id))
    .limit(1);
  return batch || null;
}

export async function getReliabilityRunForBatch(batchId: number) {
  const [run] = await db.select({ run: schema.reliabilityRuns })
    .from(schema.batchRuns)
    .innerJoin(schema.reliabilityRuns, eq(schema.batchRuns.reliabilityRunId, schema.reliabilityRuns.id))
    .where(eq(schema.batchRuns.id, batchId))
    .limit(1);
  return run?.run || null;
}

export async function touchBatchHeartbeat(batchId: number, progress?: { lastProgressAt?: Date; detail?: unknown }) {
  const now = new Date();
  await db.execute(sql`
    UPDATE batch_runs SET last_heartbeat_at = ${now}, last_progress_at = COALESCE(${progress?.lastProgressAt ?? null}, last_progress_at)
    WHERE id = ${batchId}
  `);
  const run = await getReliabilityRunForBatch(batchId);
  if (run) {
    await db.execute(sql`
      UPDATE reliability_runs SET last_heartbeat_at = ${now}, last_progress_at = COALESCE(${progress?.lastProgressAt ?? now}, last_progress_at)
      WHERE id = ${run.id} AND lifecycle_state = 'running'
    `);
  }
}

export async function getBatchProgress(batchId: number) {
  const rows = await db.execute(sql`
    SELECT id, status, last_progress_at, completed_at, claimed_at, progress_detail
    FROM analysis_jobs WHERE batch_id = ${batchId} ORDER BY id ASC
  `);
  const jobs = (rows.rows as any[]).map((row) => ({
    id: Number(row.id),
    status: String(row.status),
    lastProgressAt: row.last_progress_at ?? row.completed_at ?? row.claimed_at ?? null,
  }));
  return computeProgressSnapshot(jobs);
}

export async function recordReliabilityStatusTrace(runId: number, batchId: number | null, progress: ReturnType<typeof computeProgressSnapshot>, classification: string) {
  return db.insert(schema.reliabilityStatusTraces).values({
    runId,
    batchId,
    total: progress.total,
    completed: progress.completed,
    active: progress.active,
    pending: progress.pending,
    failed: progress.failed,
    oldestActiveJobAgeMs: progress.oldestActiveJobAgeMs,
    lastProgressAt: progress.lastProgressAt ? new Date(progress.lastProgressAt) : null,
    classification,
    jobProgress: progress.jobs,
  }).returning();
}

export async function classifyBatchStall(batchId: number, thresholdMs: number) {
  const batch = await db.select().from(schema.batchRuns).where(eq(schema.batchRuns.id, batchId)).limit(1);
  const row = batch[0];
  if (!row) return { stalled: false, progress: computeProgressSnapshot([]), classification: "unknown" };
  const progress = await getBatchProgress(batchId);
  const stalled = isHeartbeatStalled({
    lifecycleState: row.status,
    lastHeartbeatAt: row.lastHeartbeatAt,
    activeJobs: progress.jobs.filter((job) => job.status === "claimed" || job.status === "active"),
    thresholdMs,
  });
  return { stalled, progress, classification: stalled ? "stalled" : "active" };
}

// ─── Batch Run Operations (Workspace-Scoped) ────────────────────────────────

export async function createBatchRun(workspaceId: number, frameworkId: number, totalJobs: number, listId?: number, offPeakOnly: boolean = false, scoreOnly: boolean = false, reliability?: { runId: number; runKey: string; testCycleId: string; batteryLabel: string; deploymentFingerprint: DeploymentFingerprint }, corpusReplay?: { sourceBatchId: number; sourceRunKey: string; sourceCorpusFingerprint: string }) {
  // Legacy interactive runs retain the existing single-active behaviour. Reliability
  // runs are protected by their immutable run_key and never cancel a concurrent run.
  if (!reliability) {
    await db.update(schema.batchRuns)
      .set({ status: "cancelled", completedAt: new Date(), terminalAt: new Date(), acceptanceState: "rejected", rejectionReason: "superseded by a newer interactive batch" })
      .where(and(eq(schema.batchRuns.workspaceId, workspaceId), eq(schema.batchRuns.status, "running")));
  }

  try {
    const [batch] = await db.insert(schema.batchRuns).values({
      workspaceId,
      reliabilityRunId: reliability?.runId,
      runKey: reliability?.runKey,
      testCycleId: reliability?.testCycleId,
      batteryLabel: reliability?.batteryLabel,
      deploymentFingerprint: reliability?.deploymentFingerprint,
      frameworkId,
      listId,
      totalJobs,
      offPeakOnly,
      scoreOnly,
      sourceBatchId: corpusReplay?.sourceBatchId ?? null,
      corpusReplayProvenance: corpusReplay ? { sourceRunKey: corpusReplay.sourceRunKey, sourceBatchId: corpusReplay.sourceBatchId, sourceCorpusFingerprint: corpusReplay.sourceCorpusFingerprint } : null,
      status: "running",
      lastHeartbeatAt: new Date(),
      lastProgressAt: new Date(),
      acceptanceState: "pending",
    }).returning();
    return batch;
  } catch (error: any) {
    if (error?.code !== "23505" || !reliability?.runKey) throw error;
    const raced = await getBatchRunByRunKey(reliability.runKey, workspaceId);
    if (!raced) throw error;
    return raced;
  }
}

export async function getActiveBatchRun(workspaceId: number) {
  const [batch] = await db
    .select()
    .from(schema.batchRuns)
    .where(and(eq(schema.batchRuns.workspaceId, workspaceId), eq(schema.batchRuns.status, "running")))
    .orderBy(desc(schema.batchRuns.startedAt))
    .limit(1);
  return batch || null;
}

/** Guard: check if any batch is currently running for a given list */
export async function getActiveBatchesForList(listId: number, workspaceId: number) {
  return db
    .select()
    .from(schema.batchRuns)
    .where(and(
      eq(schema.batchRuns.workspaceId, workspaceId),
      eq(schema.batchRuns.listId, listId),
      eq(schema.batchRuns.status, "running")
    ));
}

/**
 * Honest "is anything actually running" summary for the dashboard.
 *
 * The legacy indicator simply checked for any batch_run row in status
 * 'running', which spins forever when stale/orphaned batches linger. Instead we
 * look at the actual in-flight WORK (analysis_jobs in 'claimed' or 'pending'
 * belonging to running batches) and summarise it:
 *   - kind: 'batch' (a multi-company portfolio run) vs 'reexam' (a 1-company
 *           re-examination), chosen from the dominant running batch by total_jobs.
 *   - startedAt: when that dominant run began.
 *   - total / completed / failed: counters for that dominant run.
 *   - inFlight: number of jobs currently claimed across ALL running batches.
 *   - pending: number of jobs still queued across ALL running batches.
 *   - etaSeconds: estimate = remaining_jobs / observed completion rate, where the
 *           rate is derived from how many jobs of the dominant batch completed
 *           since it started. Null when not yet estimable.
 * Returns null when there is genuinely no in-flight work.
 */
export async function getActiveRunSummary(workspaceId: number): Promise<{
  kind: "batch" | "reexam";
  batchId: number;
  startedAt: string | null;
  total: number;
  completed: number;
  failed: number;
  inFlight: number;
  pending: number;
  etaSeconds: number | null;
} | null> {
  // In-flight work across ALL running batches for this workspace.
  const work = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE j.status = 'claimed')::int AS in_flight,
      COUNT(*) FILTER (WHERE j.status = 'pending')::int AS pending
    FROM analysis_jobs j
    JOIN batch_runs b ON b.id = j.batch_id
    WHERE b.workspace_id = ${workspaceId} AND b.status = 'running'
  `);
  const inFlight = Number((work.rows[0] as any)?.in_flight || 0);
  const pending = Number((work.rows[0] as any)?.pending || 0);
  if (inFlight + pending === 0) return null; // nothing genuinely running

  // Dominant running batch = the one with the most total_jobs (the real
  // portfolio run, not a 1-company re-exam that happens to be newer).
  const [dom] = await db
    .select()
    .from(schema.batchRuns)
    .where(and(eq(schema.batchRuns.workspaceId, workspaceId), eq(schema.batchRuns.status, "running")))
    .orderBy(desc(schema.batchRuns.totalJobs), desc(schema.batchRuns.startedAt))
    .limit(1);
  if (!dom) return null;

  const total = Number(dom.totalJobs || 0);
  const completed = Number(dom.completedJobs || 0);
  const failed = Number(dom.failedJobs || 0);
  const startedAt = dom.startedAt ? new Date(dom.startedAt).toISOString() : null;
  const kind: "batch" | "reexam" = total <= 1 ? "reexam" : "batch";

  // ETA: remaining / rate. Rate = done-so-far / elapsed-seconds.
  let etaSeconds: number | null = null;
  const done = completed + failed;
  const remaining = Math.max(0, total - done);
  if (dom.startedAt && done > 0 && remaining > 0) {
    const elapsedSec = Math.max(1, (Date.now() - new Date(dom.startedAt).getTime()) / 1000);
    const ratePerSec = done / elapsedSec;
    if (ratePerSec > 0) etaSeconds = Math.round(remaining / ratePerSec);
  }

  return { kind, batchId: dom.id, startedAt, total, completed, failed, inFlight, pending, etaSeconds };
}

/** Most recent batch awaiting review (status = pending_review) for a workspace. */
export async function getLatestReviewableBatch(workspaceId: number) {
  const [batch] = await db
    .select()
    .from(schema.batchRuns)
    .where(and(eq(schema.batchRuns.workspaceId, workspaceId), eq(schema.batchRuns.status, "pending_review")))
    .orderBy(desc(schema.batchRuns.startedAt))
    .limit(1);
  return batch || null;
}

/** How many batches are awaiting review (status = pending_review) for a workspace. */
export async function countReviewableBatches(workspaceId: number): Promise<number> {
  const r = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM batch_runs
    WHERE workspace_id = ${workspaceId} AND status = 'pending_review'
  `);
  return Number((r.rows[0] as any)?.n || 0);
}

/** Get a single batch run by id (workspace-scoped). */
export async function getBatchRunById(batchId: number, workspaceId: number) {
  const [batch] = await db
    .select()
    .from(schema.batchRuns)
    .where(and(eq(schema.batchRuns.id, batchId), eq(schema.batchRuns.workspaceId, workspaceId)))
    .limit(1);
  return batch || null;
}

export async function incrementBatchCompleted(batchId: number) {
  const now = new Date();
  const [batch] = await db.execute(sql`
    UPDATE batch_runs SET completed_jobs = completed_jobs + 1, last_heartbeat_at = ${now}, last_progress_at = ${now}
    WHERE id = ${batchId}
    RETURNING id, completed_jobs, failed_jobs, total_jobs
  `).then(r => r.rows);
  await touchBatchHeartbeat(batchId, { lastProgressAt: now });
  return batch;
}

export async function incrementBatchFailed(batchId: number) {
  const now = new Date();
  const [batch] = await db.execute(sql`
    UPDATE batch_runs SET failed_jobs = failed_jobs + 1, last_heartbeat_at = ${now}, last_progress_at = ${now}
    WHERE id = ${batchId}
    RETURNING id, completed_jobs, failed_jobs, total_jobs
  `).then(r => r.rows);
  await touchBatchHeartbeat(batchId, { lastProgressAt: now });
  return batch;
}

export async function completeBatchRun(batchId: number) {
  const now = new Date();
  await db.update(schema.batchRuns).set({ status: "completed", completedAt: now, terminalAt: now, lastHeartbeatAt: now, lastProgressAt: now }).where(eq(schema.batchRuns.id, batchId));
  const run = await getReliabilityRunForBatch(batchId);
  if (run) await updateReliabilityRunLifecycle(run.id, "terminal_success", { lastHeartbeatAt: now, lastProgressAt: now, terminalAt: now });
}

/** Set an arbitrary batch status (e.g. "pending_review", "running"). */
export async function setBatchRunStatus(batchId: number, status: string, reason?: string) {
  const previous = await db.select({ status: schema.batchRuns.status, workspaceId: schema.batchRuns.workspaceId, reliabilityRunId: schema.batchRuns.reliabilityRunId })
    .from(schema.batchRuns).where(eq(schema.batchRuns.id, batchId)).limit(1);
  await db.execute(sql`UPDATE batch_runs SET status = ${status}, last_heartbeat_at = NOW() WHERE id = ${batchId}`);
  const prior = previous[0];
  if (prior?.reliabilityRunId) {
    if (status === "running") {
      await updateReliabilityRunLifecycle(prior.reliabilityRunId, "running", { acceptanceState: "pending", rejectionReason: null, lastHeartbeatAt: new Date(), lastProgressAt: new Date() });
    } else if (["completed", "pending_review", "cancelled"].includes(status)) {
      const lifecycle: RunLifecycleState = status === "cancelled" ? "cancelled" : status === "completed" ? "terminal_success" : "terminal_failed";
      await updateReliabilityRunLifecycle(prior.reliabilityRunId, lifecycle, { acceptanceState: status === "completed" ? "pending" : "rejected", rejectionReason: reason ?? null });
    }
  }
  if (prior && prior.status !== status) {
    await recordReliabilityAuditEvent({
      workspaceId: prior.workspaceId,
      runId: prior.reliabilityRunId,
      batchId,
      eventType: "lifecycle_transition",
      fromState: prior.status,
      toState: status,
      reason: reason ?? `batch transitioned from ${prior.status} to ${status}`,
    });
  }
}

/** Mark a batch's snapshot as successfully saved. */
export async function markBatchSnapshotSaved(batchId: number) {
  await db.execute(sql`UPDATE batch_runs SET snapshot_saved = TRUE WHERE id = ${batchId}`);
}

/** Mark a batch as needing a snapshot save (failed on first attempt). */
export async function markBatchSnapshotPending(batchId: number) {
  await db.execute(sql`UPDATE batch_runs SET snapshot_saved = FALSE WHERE id = ${batchId}`);
}

/** Find completed batches that never got their snapshot saved (for self-heal on startup). */
export async function getCompletedBatchesMissingSnapshot(): Promise<Array<{ id: number; framework_id: number; workspace_id: number; list_id: number | null }>> {
  const rows = await db.execute(sql`
    SELECT id, framework_id, workspace_id, list_id FROM batch_runs
    WHERE status = 'completed' AND snapshot_saved = FALSE
      AND total_jobs > 1
    ORDER BY id DESC LIMIT 20
  `);
  return (rows.rows as any[]).map(r => ({
    id: Number(r.id),
    framework_id: Number(r.framework_id),
    workspace_id: Number(r.workspace_id),
    list_id: r.list_id ? Number(r.list_id) : null,
  }));
}

/** Return the terminal-failed jobs (company + error) for a batch. */
export async function getFailedJobsForBatch(
  batchId: number,
): Promise<Array<{ companyId: number; companyName: string; error: string }>> {
  const r = await db.execute(sql`
    SELECT company_id, company_name, last_error
    FROM analysis_jobs
    WHERE batch_id = ${batchId} AND status = 'failed'
    ORDER BY company_name ASC
  `);
  return (r.rows as any[]).map(row => ({
    companyId: Number(row.company_id),
    companyName: String(row.company_name || ""),
    error: String(row.last_error || ""),
  }));
}

/** Return all jobs for a batch (any status). Used by anomaly detection to identify completed companies. */
export async function getJobsForBatch(
  batchId: number,
): Promise<Array<{ id: number; companyId: number; companyName: string; status: string }>> {
  const r = await db.execute(sql`
    SELECT id, company_id, company_name, framework_id, workspace_id, status
    FROM analysis_jobs
    WHERE batch_id = ${batchId}
    ORDER BY id ASC
  `);
  return (r.rows as any[]).map(row => ({
    id: Number(row.id),
    companyId: Number(row.company_id),
    companyName: String(row.company_name || ""),
    frameworkId: Number(row.framework_id),
    workspaceId: Number(row.workspace_id),
    status: String(row.status || ""),
  }));
}

/**
 * Reset the terminal-failed jobs of a batch back to `pending` (attempts=0,
 * cleared error/worker/claim) so they can be re-enqueued. Also resets the
 * affected companies' analysisStatus to idle and decrements the batch's
 * failed_jobs counter by the number reset. Returns the jobs to re-enqueue.
 */
export async function requeueFailedJobsForBatch(
  batchId: number,
): Promise<Array<{ id: number; companyId: number; companyName: string; frameworkId: number; workspaceId: number }>> {
  // Capture the failed jobs first (with all fields needed to re-enqueue).
  // We also pick up jobs already left in `pending` for a batch awaiting review:
  // a previously-interrupted re-examine may have flipped a job to `pending`
  // without re-enqueueing it (so it is stuck out-of-queue). Including them here
  // makes the operation safely idempotent/retryable.
  const failed = await db.execute(sql`
    SELECT id, company_id, company_name, framework_id, workspace_id
    FROM analysis_jobs
    WHERE batch_id = ${batchId} AND status IN ('failed', 'pending')
  `);
  const rows = failed.rows as any[];
  if (rows.length === 0) return [];

  // Reset those jobs to a clean pending state.
  await db.execute(sql`
    UPDATE analysis_jobs SET
      status = 'pending',
      attempts = 0,
      last_error = NULL,
      worker_id = NULL,
      claimed_at = NULL
    WHERE batch_id = ${batchId} AND status IN ('failed', 'pending')
  `);

  // Reset affected companies to idle so the UI reflects re-processing.
  // Use Drizzle's inArray() so the IN-list is built correctly regardless of
  // length. (A raw `id = ANY(${companyIds})` mis-binds a single-element JS
  // array as a scalar in Postgres -> "malformed array literal".)
  const companyIds = rows.map(r => Number(r.company_id)).filter(n => Number.isFinite(n));
  if (companyIds.length > 0) {
    await db
      .update(schema.companies)
      .set({ analysisStatus: "idle" })
      .where(inArray(schema.companies.id, companyIds));
  }

  // Decrement the batch failed counter by the number we just reset.
  await db.execute(sql`
    UPDATE batch_runs SET failed_jobs = GREATEST(0, failed_jobs - ${rows.length})
    WHERE id = ${batchId}
  `);

  return rows.map(r => ({
    id: Number(r.id),
    companyId: Number(r.company_id),
    companyName: String(r.company_name || ""),
    frameworkId: Number(r.framework_id),
    workspaceId: Number(r.workspace_id),
  }));
}

export async function cancelBatchRun(batchId: number, reason = "cancelled by user") {
  const [batch] = await db.select().from(schema.batchRuns).where(eq(schema.batchRuns.id, batchId)).limit(1);
  const now = new Date();
  await db.update(schema.batchRuns).set({ status: "cancelled", completedAt: now, terminalAt: now, acceptanceState: "rejected", rejectionReason: reason }).where(eq(schema.batchRuns.id, batchId));
  const run = await getReliabilityRunForBatch(batchId);
  if (run) {
    await db.execute(sql`UPDATE analysis_results SET acceptance_state = 'rejected', rejection_reason = ${reason} WHERE batch_id = ${batchId} AND immutable_snapshot = TRUE`);
    await updateReliabilityRunLifecycle(run.id, "cancelled", { acceptanceState: "rejected", rejectionReason: reason, terminalAt: now });
    await recordReliabilityAuditEvent({
      workspaceId: batch?.workspaceId ?? run.workspaceId,
      runId: run.id,
      batchId,
      artifactId: run.artifactId,
      eventType: "cancellation",
      fromState: batch?.status ?? null,
      toState: "cancelled",
      reason,
    });
  }
}

// ─── Job Queue Operations ───────────────────────────────────────────────────

export async function createAnalysisJobs(jobs: Array<{ workspaceId: number; batchId: number; companyId: number; companyName: string; frameworkId: number }>) {
  if (jobs.length === 0) return [];
  const now = new Date();
  const rows = await db.insert(schema.analysisJobs).values(jobs.map((job) => ({ ...job, lastProgressAt: now }))).onConflictDoNothing({ target: [schema.analysisJobs.batchId, schema.analysisJobs.companyId] }).returning();
  await touchBatchHeartbeat(jobs[0].batchId, { lastProgressAt: now });
  return rows;
}

/**
 * Auto-reexamination enqueue (v3k-r15).
 *
 * Triggered by the pipeline's corpus-health gate when a company completed with a
 * fetch-coverage-DEGRADED corpus (most key docs `dead`, thin retrieval) rather
 * than a legitimate no-disclosure zero. It schedules a FRESH, self-contained
 * single-job batch that forces a full re-discovery + re-fetch (skipFetch=false)
 * so the previously-`dead` documents are re-attempted.
 *
 * Design notes that keep this safe alongside the in-flight portfolio run:
 *  - It creates its OWN batch_runs row (totalJobs=1), so it never perturbs the
 *    counters of the large portfolio batch the company originally belonged to.
 *  - It clears pending/dead/rejected docs (clearDiscoveredDocuments) so the next
 *    fetch phase genuinely re-discovers, instead of reusing the empty corpus.
 *  - The caller is responsible for the bounded-retry accounting in
 *    discoveryDiagnostics.autoReexam; this function only does the enqueue.
 */
export async function enqueueReexamination(opts: {
  companyId: number;
  companyName: string;
  frameworkId: number;
  workspaceId: number;
  recoveryReason?: string;
}): Promise<{ batchId: number; jobId: number } | null> {
  const { companyId, companyName, frameworkId, workspaceId } = opts;

  // ── Idempotency guard ──────────────────────────────────────────────────────
  // Do NOT create a new re-exam batch if this company already has an active
  // (pending/claimed) job in ANY still-active batch. Without this, repeated
  // triggers (reconciler passes, double-clicks, overlapping recovery paths)
  // spawn parallel single-company batches for the SAME company (observed in
  // production: Oriental Land had batches 729 AND 743). Returning the existing
  // batch/job makes the operation safely repeatable.
  try {
    const existing = await db.execute(sql`
      SELECT j.id AS job_id, j.batch_id
      FROM analysis_jobs j
      JOIN batch_runs b ON b.id = j.batch_id
      WHERE j.company_id = ${companyId}
        AND j.status IN ('pending','claimed')
        AND b.status IN ('running','pending_review')
      ORDER BY j.id DESC
      LIMIT 1
    `);
    if (existing.rows.length > 0) {
      const r = existing.rows[0] as any;
      console.log(`[enqueueReexamination] Company ${companyId} already has active job ${r.job_id} in batch ${r.batch_id}; skipping duplicate batch creation`);
      return { batchId: Number(r.batch_id), jobId: Number(r.job_id) };
    }
  } catch (e: any) {
    console.warn(`[enqueueReexamination] Dedup check failed (proceeding): ${e?.message}`);
  }

  // Dedicated single-job batch so portfolio batch counters are untouched. Every
  // recovery is a replacement run with a fresh immutable run_key.
  const recoveryLabel = `recovery-${companyId}-${Date.now()}`;
  const recoveryRun = await createOrAdoptReliabilityRun({
    workspaceId,
    testCycleId: "recovery",
    commitSha: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_SHA || "unknown",
    frameworkId,
    listId: null,
    batteryLabel: recoveryLabel,
    deploymentFingerprint: deploymentFingerprintFromEnvironment(),
    diagnosticRun: true,
  });
  const batch = await createBatchRun(workspaceId, frameworkId, 1, undefined, false, false, {
    runId: recoveryRun.run.id,
    runKey: recoveryRun.run.runKey,
    testCycleId: "recovery",
    batteryLabel: recoveryLabel,
    deploymentFingerprint: recoveryRun.run.deploymentFingerprint as DeploymentFingerprint,
  });
  if (!batch) return null;

  const [job] = await db
    .insert(schema.analysisJobs)
    .values({ workspaceId, batchId: batch.id, companyId, companyName, frameworkId, lastProgressAt: new Date() })
    .onConflictDoNothing({ target: [schema.analysisJobs.batchId, schema.analysisJobs.companyId] })
    .returning();
  if (!job) {
    const existingJobs = await db.select().from(schema.analysisJobs).where(and(eq(schema.analysisJobs.batchId, batch.id), eq(schema.analysisJobs.companyId, companyId))).limit(1);
    if (!existingJobs[0]) return null;
    return { batchId: batch.id, jobId: existingJobs[0].id };
  }
  await updateReliabilityRunLifecycle(recoveryRun.run.id, "running", { lastHeartbeatAt: new Date(), lastProgressAt: new Date() });
  await recordReliabilityAuditEvent({ workspaceId, runId: recoveryRun.run.id, batchId: batch.id, eventType: "replacement", fromState: "created", toState: "running", reason: opts.recoveryReason || "resumable recovery created a fresh run_key" });

  // Force a genuine re-fetch: purge prior pending/dead/rejected docs so the next
  // fetch phase re-discovers and re-attempts the previously-dead URLs. Successful
  // (`ok`) docs are preserved by clearDiscoveredDocuments.
  await clearDiscoveredDocuments(companyId);
  // Framework-scoped clearing: only remove scores for the framework being re-examined,
  // preserving scores from other frameworks.
  await clearMeasureScoresForFramework(companyId, frameworkId);
  await updateCompany(companyId, workspaceId, { analysisStatus: "idle" });

  // Push onto the BullMQ queue with skipFetch=false. Dynamic import avoids a
  // circular module dependency (queue -> worker type) at load time.
  const { getQueue } = await import("./queue.js");
  const q = getQueue();
  await q.add(
    `reexam-${batch.id}-${companyId}`,
    { jobId: job.id, companyId, frameworkId, batchId: batch.id, workspaceId, skipFetch: false },
    { priority: 1, jobId: `reexam-company-${companyId}-batch-${batch.id}` }
  );

  return { batchId: batch.id, jobId: job.id };
}

export async function claimJob(jobId: number) {
  const now = new Date();
  const result = await db.execute(sql`
    UPDATE analysis_jobs SET
      status = 'claimed',
      claimed_at = ${now},
      last_progress_at = ${now},
      attempts = attempts + 1
    WHERE id = ${jobId} AND (status = 'pending' OR (status = 'claimed' AND attempts < 3))
    RETURNING *
  `);
  const row = result.rows[0] as any;
  if (row?.batch_id) await touchBatchHeartbeat(Number(row.batch_id), { lastProgressAt: now, detail: { jobId, status: "claimed" } });
  return row || null;
}

export async function completeJob(jobId: number) {
  const now = new Date();
  const result = await db.execute(sql`UPDATE analysis_jobs SET status = 'completed', completed_at = ${now}, last_progress_at = ${now} WHERE id = ${jobId} RETURNING batch_id`);
  const batchId = (result.rows[0] as any)?.batch_id;
  if (batchId) await touchBatchHeartbeat(Number(batchId), { lastProgressAt: now, detail: { jobId, status: "completed" } });
}

export async function failJob(jobId: number, error: string) {
  const now = new Date();
  const result = await db.execute(sql`
    UPDATE analysis_jobs SET
      status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END,
      last_error = ${error},
      worker_id = NULL,
      claimed_at = NULL,
      last_progress_at = ${now},
      progress_detail = ${JSON.stringify({ error: String(error).slice(0, 500) })}::jsonb
    WHERE id = ${jobId}
    RETURNING batch_id
  `);
  const batchId = (result.rows[0] as any)?.batch_id;
  if (batchId) await touchBatchHeartbeat(Number(batchId), { lastProgressAt: now, detail: { jobId, status: "failed", error } });
}

export async function updateJobProgress(jobId: number, detail: unknown = null) {
  const now = new Date();
  const result = await db.execute(sql`UPDATE analysis_jobs SET last_progress_at = ${now}, progress_detail = ${detail == null ? null : JSON.stringify(detail)}::jsonb WHERE id = ${jobId} RETURNING batch_id`);
  const batchId = (result.rows[0] as any)?.batch_id;
  if (batchId) await touchBatchHeartbeat(Number(batchId), { lastProgressAt: now, detail });
}

// ─── Summary Cache ──────────────────────────────────────────────────────────

export async function getCachedSummary(companyId: number, documentHash: string) {
  const [cached] = await db
    .select()
    .from(schema.summaryCache)
    .where(and(eq(schema.summaryCache.companyId, companyId), eq(schema.summaryCache.documentHash, documentHash)));
  return cached?.summary || null;
}

export async function cacheSummary(data: { companyId: number; documentHash: string; summary: string; summarizerModel?: string }) {
  await db
    .insert(schema.summaryCache)
    .values(data)
    .onConflictDoUpdate({
      target: [schema.summaryCache.companyId, schema.summaryCache.documentHash],
      set: { summary: data.summary, summarizerModel: data.summarizerModel },
    });
}

// ─── Trusted Sources (GLOBAL) ─────────────────────────────────────────────────
// Source lists are now GLOBAL: every workspace shares one list. The
// `workspaceId` parameters are retained for call-site compatibility but the
// queries intentionally ignore them so all workspaces see/share the same rows.

export async function getTrustedSources(_workspaceId?: number) {
  return db.select().from(schema.trustedSources);
}

export async function addTrustedSource(workspaceId: number, name: string, domain: string, description?: string | null) {
  const [source] = await db.insert(schema.trustedSources).values({ workspaceId, name, domain, description: description || null }).returning();
  return source;
}

export async function updateTrustedSource(id: number, _workspaceId: number, updates: { name?: string; domain?: string; description?: string | null; isActive?: boolean }) {
  await db.update(schema.trustedSources).set(updates as any).where(eq(schema.trustedSources.id, id));
}

export async function deleteTrustedSource(id: number, _workspaceId: number) {
  await db.delete(schema.trustedSources).where(eq(schema.trustedSources.id, id));
}

// ─── Excluded Sources (GLOBAL) ────────────────────────────────────────────────

export async function getExcludedSources(_workspaceId?: number) {
  return db.select().from(schema.excludedSources);
}

export async function addExcludedSource(workspaceId: number, domain: string, reason?: string | null) {
  const [source] = await db.insert(schema.excludedSources).values({ workspaceId, domain, reason: reason || null }).returning();
  return source;
}

export async function updateExcludedSource(id: number, _workspaceId: number, updates: { domain?: string; reason?: string | null; isActive?: boolean }) {
  await db.update(schema.excludedSources).set(updates as any).where(eq(schema.excludedSources.id, id));
}

export async function deleteExcludedSource(id: number, _workspaceId: number) {
  await db.delete(schema.excludedSources).where(eq(schema.excludedSources.id, id));
}

// ─── Platform Sources (GLOBAL — shared multi-tenant hosts) ────────────────────
// Documents hosted on these domains are ALWAYS issuer-verified by the LLM,
// overriding the own-domain fast-path. The list is global across all workspaces.

export async function getPlatformSources() {
  return db.select().from(schema.platformSources);
}

/** Active platform host domains (normalized) for the verification gate. */
export async function getActivePlatformHosts(): Promise<string[]> {
  const rows = await db.select().from(schema.platformSources)
    .where(and(eq(schema.platformSources.isActive, true), eq(schema.platformSources.suppressed, false)));
  return rows
    .map(r => (r.domain || "").trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, ""))
    .filter(Boolean);
}

export async function addPlatformSource(domain: string, reason?: string | null, autoDetected = false, companyCount?: number | null) {
  const norm = (domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (!norm) throw new Error("Invalid domain");
  const [source] = await db
    .insert(schema.platformSources)
    .values({ workspaceId: null as any, domain: norm, reason: reason || null, autoDetected, companyCount: companyCount ?? null })
    .onConflictDoNothing({ target: schema.platformSources.domain })
    .returning();
  if (source) return source;
  // Already exists — return the existing row.
  const [existing] = await db.select().from(schema.platformSources).where(eq(schema.platformSources.domain, norm));
  return existing;
}

export async function updatePlatformSource(id: number, updates: { domain?: string; reason?: string | null; isActive?: boolean }) {
  await db.update(schema.platformSources).set(updates as any).where(eq(schema.platformSources.id, id));
}

export async function deletePlatformSource(id: number) {
  await db.delete(schema.platformSources).where(eq(schema.platformSources.id, id));
}

/**
 * Delete-and-suppress: instead of removing the row, mark it suppressed and
 * inactive so it (a) stops force-verifying immediately and (b) will NOT be
 * re-added by the >=3-companies auto-detection even if it keeps qualifying.
 * If the row no longer exists (was hard-deleted), insert a suppressed tombstone
 * keyed on the domain so future auto-detect runs still skip it.
 */
export async function suppressPlatformSource(id: number) {
  const [row] = await db.select().from(schema.platformSources).where(eq(schema.platformSources.id, id));
  if (row) {
    await db.update(schema.platformSources)
      .set({ suppressed: true, isActive: false })
      .where(eq(schema.platformSources.id, id));
    return row.domain;
  }
  return null;
}

/** Suppress by domain (used when re-adding a tombstone for a hard-deleted row). */
export async function suppressPlatformDomain(domain: string) {
  const norm = (domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (!norm) throw new Error("Invalid domain");
  const [existing] = await db.select().from(schema.platformSources).where(eq(schema.platformSources.domain, norm));
  if (existing) {
    await db.update(schema.platformSources).set({ suppressed: true, isActive: false }).where(eq(schema.platformSources.domain, norm));
  } else {
    await db.insert(schema.platformSources)
      .values({ workspaceId: null as any, domain: norm, reason: "Suppressed: will not auto-re-add", autoDetected: true, suppressed: true, isActive: false })
      .onConflictDoNothing({ target: schema.platformSources.domain });
  }
  return norm;
}

/** Lift suppression so a domain can be auto-detected / re-activated again. */
export async function unsuppressPlatformSource(id: number) {
  await db.update(schema.platformSources).set({ suppressed: false }).where(eq(schema.platformSources.id, id));
}

/**
 * AUTO-ENFORCE the >=3-companies rule. Scans the documents table for the
 * registrable domain of every accepted/fetched URL, counts how many DISTINCT
 * companies each domain appears on, and upserts any domain meeting the
 * threshold as an auto-detected platform source. Returns the list of domains
 * added/updated. Idempotent.
 */
export async function detectAndUpsertPlatformSources(minCompanies = 3): Promise<{ domain: string; companyCount: number; added: boolean }[]> {
  // Compute registrable-ish domain (last two labels, or three for known
  // two-part TLDs) from each document URL, then count distinct companies.
  const rows: any[] = (await db.execute(sql`
    WITH hosts AS (
      SELECT
        d.company_id AS company_id,
        lower(
          regexp_replace(
            regexp_replace(split_part(split_part(d.url, '://', 2), '/', 1), '^www\\.', ''),
            ':\\d+$', ''
          )
        ) AS host
      FROM documents d
      WHERE d.url ~ '://'
    ),
    regdom AS (
      SELECT
        company_id,
        CASE
          WHEN host ~ '\\.(co|com|org|net|gov|edu|ac)\\.[a-z]{2}$'
            THEN (regexp_match(host, '([^.]+\\.[^.]+\\.[a-z]{2})$'))[1]
          ELSE (regexp_match(host, '([^.]+\\.[^.]+)$'))[1]
        END AS domain
      FROM hosts
      WHERE host IS NOT NULL AND host <> ''
    )
    SELECT domain, COUNT(DISTINCT company_id)::int AS company_count
    FROM regdom
    WHERE domain IS NOT NULL
    GROUP BY domain
    HAVING COUNT(DISTINCT company_id) >= ${minCompanies}
    ORDER BY company_count DESC
  `)).rows as any[];

  const results: { domain: string; companyCount: number; added: boolean }[] = [];
  for (const r of rows) {
    const domain = (r.domain || "").toLowerCase();
    const companyCount = parseInt(r.company_count, 10) || 0;
    if (!domain) continue;
    // Upsert: insert if new, otherwise refresh company_count for existing rows.
    const [inserted] = await db
      .insert(schema.platformSources)
      .values({ workspaceId: null as any, domain, reason: `Auto-detected: appears across ${companyCount} companies`, autoDetected: true, companyCount })
      .onConflictDoNothing({ target: schema.platformSources.domain })
      .returning();
    if (inserted) {
      results.push({ domain, companyCount, added: true });
    } else {
      // Keep company_count fresh on existing auto-detected rows, but NEVER
      // touch suppressed rows (they were deliberately removed and must not be
      // re-activated or re-counted into the active set).
      await db.update(schema.platformSources)
        .set({ companyCount })
        .where(and(
          eq(schema.platformSources.domain, domain),
          eq(schema.platformSources.autoDetected, true),
          eq(schema.platformSources.suppressed, false),
        ));
      results.push({ domain, companyCount, added: false });
    }
  }
  return results;
}

// ─── Workspace Settings ─────────────────────────────────────────────────────

export async function getSettings(workspaceId: number): Promise<Record<string, string>> {
  const rows = await db.select().from(schema.workspaceSettings).where(eq(schema.workspaceSettings.workspaceId, workspaceId));
  const settings: Record<string, string> = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  return settings;
}

export async function setSetting(workspaceId: number, key: string, value: string) {
  await db
    .insert(schema.workspaceSettings)
    .values({ workspaceId, key, value })
    .onConflictDoUpdate({
      target: [schema.workspaceSettings.workspaceId, schema.workspaceSettings.key],
      set: { value },
    });
}

// ─── System Alerts (cross-process; e.g. API credit exhaustion) ───────────────

export interface SystemAlert {
  id: number;
  kind: string;
  provider: string | null;
  message: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Raise (or refresh) an active alert of a given kind. Idempotent: if an active
 * alert of the same kind already exists, its message/provider/updated_at are
 * refreshed rather than inserting a duplicate.
 */
export async function setSystemAlert(opts: { kind: string; provider?: string; message: string; active?: boolean }): Promise<void> {
  const { kind, provider = null, message } = opts;
  const existing = await db.execute(sql`
    SELECT id FROM system_alerts WHERE kind = ${kind} AND active = TRUE ORDER BY id DESC LIMIT 1
  `);
  if (existing.rows.length > 0) {
    const id = (existing.rows[0] as any).id;
    await db.execute(sql`
      UPDATE system_alerts SET message = ${message}, provider = ${provider}, updated_at = NOW() WHERE id = ${id}
    `);
  } else {
    await db.execute(sql`
      INSERT INTO system_alerts (kind, provider, message, active) VALUES (${kind}, ${provider}, ${message}, TRUE)
    `);
  }
}

/** Clear (deactivate) active alerts of a kind, optionally scoped to a provider. */
export async function clearSystemAlert(kind: string, provider?: string): Promise<void> {
  if (provider) {
    await db.execute(sql`
      UPDATE system_alerts SET active = FALSE, updated_at = NOW() WHERE kind = ${kind} AND active = TRUE AND (provider = ${provider} OR provider IS NULL)
    `);
  } else {
    await db.execute(sql`
      UPDATE system_alerts SET active = FALSE, updated_at = NOW() WHERE kind = ${kind} AND active = TRUE
    `);
  }
}

/** Return the most recent active alert of a kind, or null. */
export async function getActiveSystemAlert(kind: string): Promise<SystemAlert | null> {
  const r = await db.execute(sql`
    SELECT id, kind, provider, message, active, created_at, updated_at
    FROM system_alerts WHERE kind = ${kind} AND active = TRUE ORDER BY id DESC LIMIT 1
  `);
  return (r.rows[0] as any) || null;
}

/** Return all active alerts (any kind). */
export async function getActiveSystemAlerts(): Promise<SystemAlert[]> {
  const r = await db.execute(sql`
    SELECT id, kind, provider, message, active, created_at, updated_at
    FROM system_alerts WHERE active = TRUE ORDER BY id DESC
  `);
  return r.rows as any[];
}

// ─── Processing Errors ──────────────────────────────────────────────────────

export async function logProcessingError(data: { workspaceId?: number; companyId?: number; companyName?: string; stage?: string; error?: string }) {
  await db.insert(schema.processingErrors).values(data);
}

// ─── Analysis Results ───────────────────────────────────────────────────────

export async function getAnalysisResultByRunKey(runKey: string, workspaceId: number) {
  const [row] = await db.select().from(schema.analysisResults)
    .where(and(eq(schema.analysisResults.workspaceId, workspaceId), eq(schema.analysisResults.runKey, runKey)))
    .limit(1);
  return row || null;
}

export async function saveAnalysisResults(data: {
  workspaceId: number;
  batchId: number;
  runId?: number | null;
  runKey?: string | null;
  deploymentFingerprint?: DeploymentFingerprint | null;
  frameworkId: number;
  frameworkName: string;
  listName?: string;
  resultsData: any;
  companiesCount: number;
  averageScore?: number;
  shareToken?: string;
  acceptanceState?: string;
  acceptedAt?: Date | null;
  rejectionReason?: string | null;
}): Promise<{ id: number; batchId: number; companiesCount: number; acceptanceState: string; [key: string]: any } | null> {
  // Validate: reject empty/missing snapshot data
  if (!data.resultsData || (Array.isArray(data.resultsData) && data.resultsData.length === 0)) {
    console.error(`[saveAnalysisResults] Rejecting empty snapshot for batch ${data.batchId}, runKey ${data.runKey}`);
    return null;
  }
  if (data.companiesCount <= 0) {
    console.error(`[saveAnalysisResults] Rejecting zero-company snapshot for batch ${data.batchId}, runKey ${data.runKey}`);
    return null;
  }

  if (data.runKey) {
    const existing = await getAnalysisResultByRunKey(data.runKey, data.workspaceId);
    if (existing) {
      // Durable upsert: if the existing row points to a DIFFERENT batch or has
      // fewer companies (stale/partial from a prior attempt), UPDATE it with the
      // new complete data. The runKey uniquely identifies the logical run — a newer
      // batch with the same runKey is a retry of the same logical analysis.
      // Never downgrade: only update if new data is at least as complete.
      // Never overwrite an accepted snapshot.
      const existingBatchMatches = existing.batchId === data.batchId;
      const existingIsAccepted = existing.acceptanceState === "accepted";
      const existingIsIncomplete = (existing.companiesCount || 0) < data.companiesCount;

      if (existingIsAccepted && existingBatchMatches) {
        // True idempotent: same batch, already accepted — return as-is
        return existing;
      }
      if (!existingBatchMatches || existingIsIncomplete) {
        // Stale or incomplete row from prior batch attempt — update with new data
        if (existingIsAccepted) {
          // Edge case: accepted row from a different batch — do not overwrite
          console.warn(`[saveAnalysisResults] Existing accepted row (batch ${existing.batchId}) differs from new batch ${data.batchId} — skipping update`);
          return existing;
        }
        console.log(`[saveAnalysisResults] Updating stale snapshot: existing batch=${existing.batchId} companies=${existing.companiesCount} -> new batch=${data.batchId} companies=${data.companiesCount}`);
        const [updated] = await db.update(schema.analysisResults).set({
          batchId: data.batchId,
          runId: data.runId ?? null,
          frameworkId: data.frameworkId,
          frameworkName: data.frameworkName,
          listName: data.listName ?? null,
          resultsData: data.resultsData,
          companiesCount: data.companiesCount,
          averageScore: data.averageScore ?? null,
          deploymentFingerprint: data.deploymentFingerprint ?? null,
          acceptanceState: data.acceptanceState ?? "pending",
          acceptedAt: data.acceptedAt ?? null,
          rejectionReason: data.rejectionReason ?? null,
        }).where(eq(schema.analysisResults.id, existing.id)).returning();
        return updated || null;
      }
      // Same batch, same or more companies, not accepted — true idempotent
      return existing;
    }
  }
  try {
    const [result] = await db.insert(schema.analysisResults).values({
      ...data,
      runId: data.runId ?? null,
      runKey: data.runKey ?? null,
      deploymentFingerprint: data.deploymentFingerprint ?? null,
      acceptanceState: data.acceptanceState ?? "pending",
      acceptedAt: data.acceptedAt ?? null,
      rejectionReason: data.rejectionReason ?? null,
      immutableSnapshot: true,
    }).returning();
    return result;
  } catch (error: any) {
    if (error?.code !== "23505" || !data.runKey) throw error;
    // Race condition: another process inserted first — retry the upsert logic
    const raced = await getAnalysisResultByRunKey(data.runKey, data.workspaceId);
    if (raced && raced.batchId !== data.batchId && raced.acceptanceState !== "accepted") {
      const [updated] = await db.update(schema.analysisResults).set({
        batchId: data.batchId,
        runId: data.runId ?? null,
        frameworkId: data.frameworkId,
        frameworkName: data.frameworkName,
        listName: data.listName ?? null,
        resultsData: data.resultsData,
        companiesCount: data.companiesCount,
        averageScore: data.averageScore ?? null,
        deploymentFingerprint: data.deploymentFingerprint ?? null,
        acceptanceState: data.acceptanceState ?? "pending",
        acceptedAt: data.acceptedAt ?? null,
        rejectionReason: data.rejectionReason ?? null,
      }).where(eq(schema.analysisResults.id, raced.id)).returning();
      return updated || null;
    }
    return raced;
  }
}

export async function getAnalysisResults(workspaceId: number) {
  return db.select().from(schema.analysisResults).where(eq(schema.analysisResults.workspaceId, workspaceId)).orderBy(desc(schema.analysisResults.createdAt));
}

// Metadata-only list (excludes the potentially huge results_data JSONB) so the
// Results page loads fast and reliably regardless of how large any single saved
// snapshot is. The full results_data is fetched on demand via getAnalysisResultById.
export async function getAnalysisResultsMeta(workspaceId: number) {
  return db
    .select({
      id: schema.analysisResults.id,
      workspaceId: schema.analysisResults.workspaceId,
      batchId: schema.analysisResults.batchId,
      frameworkId: schema.analysisResults.frameworkId,
      frameworkName: schema.analysisResults.frameworkName,
      listName: schema.analysisResults.listName,
      companiesCount: schema.analysisResults.companiesCount,
      averageScore: schema.analysisResults.averageScore,
      shareToken: schema.analysisResults.shareToken,
      createdAt: schema.analysisResults.createdAt,
    })
    .from(schema.analysisResults)
    .where(eq(schema.analysisResults.workspaceId, workspaceId))
    .orderBy(desc(schema.analysisResults.createdAt));
}

// Full single result including results_data, fetched on demand (e.g. CSV export).
export async function getAnalysisResultById(id: number, workspaceId: number) {
  const [row] = await db
    .select()
    .from(schema.analysisResults)
    .where(and(eq(schema.analysisResults.id, id), eq(schema.analysisResults.workspaceId, workspaceId)));
  return row || null;
}

export async function deleteAnalysisResult(id: number, workspaceId: number) {
  const [row] = await db.select().from(schema.analysisResults)
    .where(and(eq(schema.analysisResults.id, id), eq(schema.analysisResults.workspaceId, workspaceId))).limit(1);
  if (row?.acceptanceState === "accepted" && row.immutableSnapshot) {
    await recordReliabilityAuditEvent({ workspaceId, runId: row.runId, batchId: row.batchId, artifactId: row.runKey, eventType: "deletion", reason: "deletion refused: accepted snapshot is immutable", metadata: { resultId: id } });
    throw new Error("Accepted reliability snapshots are immutable and cannot be deleted");
  }
  await db.delete(schema.analysisResults).where(and(eq(schema.analysisResults.id, id), eq(schema.analysisResults.workspaceId, workspaceId)));
  if (row) {
    await recordReliabilityAuditEvent({
      workspaceId,
      runId: row.runId,
      batchId: row.batchId,
      artifactId: row.runKey,
      eventType: "deletion",
      reason: "result artifact deleted by user",
      metadata: { resultId: id, immutableSnapshot: row.immutableSnapshot },
    });
  }
}

// Bulk-delete multiple saved results in a single query, scoped to the workspace
// so a user can only ever delete their own results. Returns the count removed.
export async function deleteAnalysisResults(ids: number[], workspaceId: number): Promise<number> {
  const validIds = (ids || []).filter((n) => Number.isFinite(n));
  if (validIds.length === 0) return 0;
  const rows = await db.select({ id: schema.analysisResults.id, runId: schema.analysisResults.runId, batchId: schema.analysisResults.batchId, runKey: schema.analysisResults.runKey, acceptanceState: schema.analysisResults.acceptanceState, immutableSnapshot: schema.analysisResults.immutableSnapshot })
    .from(schema.analysisResults)
    .where(and(inArray(schema.analysisResults.id, validIds), eq(schema.analysisResults.workspaceId, workspaceId)));
  const deletableIds = rows.filter((row) => !(row.acceptanceState === "accepted" && row.immutableSnapshot)).map((row) => row.id);
  const deleted = deletableIds.length > 0
    ? await db.delete(schema.analysisResults)
      .where(and(inArray(schema.analysisResults.id, deletableIds), eq(schema.analysisResults.workspaceId, workspaceId)))
      .returning({ id: schema.analysisResults.id })
    : [];
  for (const row of rows) {
    const immutable = row.acceptanceState === "accepted" && row.immutableSnapshot;
    await recordReliabilityAuditEvent({
      workspaceId,
      runId: row.runId,
      batchId: row.batchId,
      artifactId: row.runKey,
      eventType: "deletion",
      reason: immutable ? "deletion refused: accepted snapshot is immutable" : "result artifact deleted by user",
      metadata: { resultId: row.id, bulk: true, deleted: !immutable },
    });
  }
  return deleted.length;
}

// ─── Durable Gate Reports ───────────────────────────────────────────────────

export async function getAcceptedEvidenceSnapshots(testCycleId: string, workspaceId: number) {
  const result = await db.execute(sql`
    SELECT ar.id, ar.batch_id, ar.run_key, ar.acceptance_state,
           ar.results_data, ar.companies_count, b.total_jobs,
           rr.lifecycle_state, rr.battery_label, rr.deployment_fingerprint
    FROM analysis_results ar
    JOIN reliability_runs rr ON rr.id = ar.run_id
    JOIN batch_runs b ON b.id = ar.batch_id
    WHERE ar.workspace_id = ${workspaceId}
      AND rr.test_cycle_id = ${testCycleId}
      AND ar.acceptance_state = 'accepted'
      AND rr.lifecycle_state = 'accepted'
    ORDER BY ar.run_key ASC, ar.id ASC
  `);
  return (result.rows as any[]).map((row) => ({
    id: Number(row.id),
    batchId: Number(row.batch_id),
    runKey: String(row.run_key || ""),
    lifecycleState: String(row.lifecycle_state || ""),
    acceptanceState: String(row.acceptance_state || ""),
    deploymentFingerprint: row.deployment_fingerprint as DeploymentFingerprint | null,
    totalJobs: Number(row.total_jobs || 0),
    companiesCount: Number(row.companies_count || 0),
    batteryLabel: row.battery_label ? String(row.battery_label) : null,
    resultsData: row.results_data,
  }));
}

export async function getGateReport(testCycleId: string, workspaceId: number) {
  const [report] = await db.select().from(schema.gateReports)
    .where(and(eq(schema.gateReports.workspaceId, workspaceId), eq(schema.gateReports.testCycleId, testCycleId)))
    .limit(1);
  return report || null;
}

export async function saveGateReportIdempotent(data: {
  workspaceId: number;
  testCycleId: string;
  deploymentFingerprint: DeploymentFingerprint;
  sourceRunKeys: string[];
  reportData: unknown;
  reportMarkdown: string;
}) {
  const existing = await getGateReport(data.testCycleId, data.workspaceId);
  if (existing) return existing;
  try {
    const [report] = await db.insert(schema.gateReports).values({
      workspaceId: data.workspaceId,
      testCycleId: data.testCycleId,
      deploymentFingerprint: data.deploymentFingerprint,
      sourceRunKeys: data.sourceRunKeys,
      reportData: data.reportData,
      reportMarkdown: data.reportMarkdown,
      schemaVersion: "1",
    }).returning();
    return report;
  } catch (error: any) {
    if (error?.code !== "23505") throw error;
    return getGateReport(data.testCycleId, data.workspaceId);
  }
}

// ─── Terminology Cache ──────────────────────────────────────────────────────

export async function getCachedTerminology(companyId: number, frameworkId: number) {
  const [cached] = await db
    .select()
    .from(schema.terminologyCache)
    .where(and(eq(schema.terminologyCache.companyId, companyId), eq(schema.terminologyCache.frameworkId, frameworkId)));
  return cached?.terms || null;
}

export async function cacheTerminology(companyId: number, frameworkId: number, terms: any) {
  await db
    .insert(schema.terminologyCache)
    .values({ companyId, frameworkId, terms })
    .onConflictDoUpdate({
      target: [schema.terminologyCache.companyId, schema.terminologyCache.frameworkId],
      set: { terms },
    });
}

// Aliases for terminology-discovery.ts compatibility
export async function getCompanyTerminology(companyId: number, frameworkId: number) {
  const terms = await getCachedTerminology(companyId, frameworkId);
  if (!terms) return null;
  return { terms };
}

export async function upsertCompanyTerminology(data: { companyId: number; frameworkId: number; terms: any; sourceDocCount?: number; status?: string }) {
  return cacheTerminology(data.companyId, data.frameworkId, data.terms);
}

// ─── List Members ───────────────────────────────────────────────────────────
export async function getListById(listId: number, workspaceId: number) {
  const result = await db.execute(sql`
    SELECT * FROM company_lists WHERE id = ${listId} AND workspace_id = ${workspaceId}
  `);
  return result.rows[0] || null;
}

export async function getListMembers(listId: number, workspaceId: number) {
  const result = await db.execute(sql`
    SELECT c.* FROM companies c
    JOIN company_list_members clm ON clm.company_id = c.id
    WHERE clm.list_id = ${listId} AND c.workspace_id = ${workspaceId}
    ORDER BY c.name ASC
  `);
  return result.rows;
}

export async function addListMember(listId: number, companyId: number, workspaceId: number) {
  await db.execute(sql`
    INSERT INTO company_list_members (list_id, company_id)
    VALUES (${listId}, ${companyId})
    ON CONFLICT DO NOTHING
  `);
}

export async function removeListMember(listId: number, companyId: number, workspaceId: number) {
  await db.execute(sql`
    DELETE FROM company_list_members WHERE list_id = ${listId} AND company_id = ${companyId}
  `);
}

export async function deleteList(listId: number, workspaceId: number) {
  await db.execute(sql`DELETE FROM company_list_members WHERE list_id = ${listId}`);
  await db.execute(sql`DELETE FROM company_lists WHERE id = ${listId} AND workspace_id = ${workspaceId}`);
}

// ─── Framework & Measure Deletion ───────────────────────────────────────────
export async function deleteFramework(frameworkId: number, workspaceId: number) {
  await db.execute(sql`DELETE FROM framework_measures WHERE framework_id = ${frameworkId}`);
  await db.execute(sql`DELETE FROM frameworks WHERE id = ${frameworkId} AND workspace_id = ${workspaceId}`);
}

export async function deleteFrameworkMeasure(measureId: number, workspaceId: number) {
  await db.execute(sql`DELETE FROM framework_measures WHERE id = ${measureId}`);
}

// ─── Diagnostics Queries ───────────────────────────────────────────────────
export async function getBatchRuns(workspaceId: number) {
  return db
    .select()
    .from(schema.batchRuns)
    .where(eq(schema.batchRuns.workspaceId, workspaceId))
    .orderBy(desc(schema.batchRuns.startedAt))
    .limit(50);
}

export async function getRecentErrors(workspaceId: number) {
  return db
    .select()
    .from(schema.processingErrors)
    .where(eq(schema.processingErrors.workspaceId, workspaceId))
    .orderBy(desc(schema.processingErrors.createdAt))
    .limit(100);
}

// ─── Company Lookup by Name ────────────────────────────────────────────────
export async function getCompanyByName(name: string, workspaceId: number) {
  const [company] = await db
    .select()
    .from(schema.companies)
    .where(and(eq(schema.companies.workspaceId, workspaceId), eq(schema.companies.name, name)))
    .limit(1);
  return company || null;
}

// ─── Company Lookup by ISIN (normalized) ───────────────────────────────────
// Finding 1 fix: the prior ingest dedup matched only on an exact, case-sensitive
// company NAME, so the same security re-uploaded under a different casing
// ("Citigroup Inc." vs "CITIGROUP INC") was inserted as a brand-new row, creating
// duplicate ISINs with divergent scores. Identity is the ISIN, so we match on the
// normalized ISIN (UPPER(TRIM(isin))) within the workspace. Returns the oldest
// matching row (lowest id) so dedup is stable when historical duplicates exist.
export async function getCompanyByIsin(isin: string, workspaceId: number) {
  const norm = (isin || "").trim().toUpperCase();
  if (!norm) return null;
  const [company] = await db
    .select()
    .from(schema.companies)
    .where(
      and(
        eq(schema.companies.workspaceId, workspaceId),
        sql`upper(trim(${schema.companies.isin})) = ${norm}`
      )
    )
    .orderBy(asc(schema.companies.id))
    .limit(1);
  return company || null;
}

// ─── Framework Editor Operations ───────────────────────────────────────────
export async function updateFramework(frameworkId: number, updates: Partial<{ name: string; topicDescription: string; trustedSourceIds: number[]; searchTemplates: string[]; negativeKeywords: string[]; negativeDomains: string[]; knownDisclosureUrls: string[]; requiredDocTypes: string[]; dataPatterns: string[]; isShared: boolean; legacyQueryTemplates: string[]; multiDocumentQueryTemplates: string[]; authoritativeRegistries: string[]; authoritativeFilingTypes: any[]; scoringExamples: string[]; antiInferenceRules: string[] }>) {
  await db.update(schema.frameworks).set(updates as any).where(eq(schema.frameworks.id, frameworkId));
}

export async function deleteMeasure(frameworkId: number, measureId: string) {
  await db.execute(sql`
    DELETE FROM framework_measures WHERE framework_id = ${frameworkId} AND measure_id = ${measureId}
  `);
}

export async function createMeasure(data: {
  frameworkId: number;
  measureId: string;
  title: string;
  definition?: string;
  category: string;
  categoryNumber: number;
  displayOrder: number;
  scoringGuidance?: any;
  evidenceKeywords?: string[];
}) {
  const scoringGuidanceStr = typeof data.scoringGuidance === 'object'
    ? JSON.stringify(data.scoringGuidance)
    : data.scoringGuidance || '';
  await db.insert(schema.frameworkMeasures).values({
    frameworkId: data.frameworkId,
    measureId: data.measureId,
    title: data.title,
    definition: data.definition || '',
    category: data.category,
    categoryNumber: data.categoryNumber,
    displayOrder: data.displayOrder,
    scoringGuidance: scoringGuidanceStr,
    evidenceKeywords: data.evidenceKeywords || [],
  });
}

export async function updateMeasure(
  frameworkId: number,
  measureId: string,
  updates: Partial<{ title: string; definition: string; scoringGuidance: any; evidenceKeywords: string[]; category: string; requiredSourceTypes: string[] }>,
) {
  // I76: switched to Drizzle typed update so jsonb (evidenceKeywords,
  // requiredSourceTypes) columns are serialised correctly. The prior manual
  // SQL-raw string interpolation would have coerced an array via String(v),
  // producing broken values for jsonb; that path is now unused via this helper.
  const setObj: any = {};
  if (updates.title !== undefined) setObj.title = updates.title;
  if (updates.definition !== undefined) setObj.definition = updates.definition;
  if (updates.category !== undefined) setObj.category = updates.category;
  if (updates.evidenceKeywords !== undefined) setObj.evidenceKeywords = updates.evidenceKeywords;
  if (updates.requiredSourceTypes !== undefined) setObj.requiredSourceTypes = updates.requiredSourceTypes;
  if (updates.scoringGuidance !== undefined) {
    setObj.scoringGuidance = typeof updates.scoringGuidance === "object"
      ? JSON.stringify(updates.scoringGuidance)
      : updates.scoringGuidance;
  }
  if (Object.keys(setObj).length === 0) return;
  await db
    .update(schema.frameworkMeasures)
    .set(setObj)
    .where(sql`framework_id = ${frameworkId} AND measure_id = ${measureId}`);
}

// ─── Trusted Source Creation (for AI editor) ───────────────────────────────
export async function createTrustedSource(data: { domain: string; description?: string; workspaceId?: number }) {
  const [source] = await db.insert(schema.trustedSources).values({
    workspaceId: data.workspaceId || 0,
    name: data.description || data.domain,
    domain: data.domain,
    description: data.description || null,
  }).returning();
  return source;
}

// ─── Score Anomalies Storage ──────────────────────────────────────────────

export async function getScoreAnomalies(workspaceId: number, status: string = "pending") {
  return db
    .select()
    .from(schema.scoreAnomalies)
    .where(
      and(
        eq(schema.scoreAnomalies.workspaceId, workspaceId),
        eq(schema.scoreAnomalies.status, status)
      )
    )
    .orderBy(sql`abs(${schema.scoreAnomalies.residual}) DESC`);
}

export async function countPendingAnomalies(workspaceId: number): Promise<number> {
  const r = await db.execute(sql`
    SELECT count(*)::int AS cnt FROM score_anomalies
    WHERE workspace_id = ${workspaceId} AND status = 'pending'
  `);
  return Number((r.rows as any[])[0]?.cnt || 0);
}

export async function getAnomalyById(id: number, workspaceId: number) {
  const [row] = await db
    .select()
    .from(schema.scoreAnomalies)
    .where(
      and(
        eq(schema.scoreAnomalies.id, id),
        eq(schema.scoreAnomalies.workspaceId, workspaceId)
      )
    )
    .limit(1);
  return row || null;
}

export async function getAnomaliesByIds(ids: number[], workspaceId: number) {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(schema.scoreAnomalies)
    .where(
      and(
        inArray(schema.scoreAnomalies.id, ids),
        eq(schema.scoreAnomalies.workspaceId, workspaceId)
      )
    );
}

export async function dismissAnomaly(id: number, workspaceId: number) {
  await db
    .update(schema.scoreAnomalies)
    .set({ status: "dismissed", reviewedAt: new Date() })
    .where(
      and(
        eq(schema.scoreAnomalies.id, id),
        eq(schema.scoreAnomalies.workspaceId, workspaceId)
      )
    );
}

export async function markAnomalyReexamined(id: number, workspaceId: number) {
  await db
    .update(schema.scoreAnomalies)
    .set({ status: "re_examined", reviewedAt: new Date() })
    .where(
      and(
        eq(schema.scoreAnomalies.id, id),
        eq(schema.scoreAnomalies.workspaceId, workspaceId)
      )
    );
}

export async function bulkDismissAnomalies(ids: number[], workspaceId: number) {
  if (ids.length === 0) return;
  await db
    .update(schema.scoreAnomalies)
    .set({ status: "dismissed", reviewedAt: new Date() })
    .where(
      and(
        inArray(schema.scoreAnomalies.id, ids),
        eq(schema.scoreAnomalies.workspaceId, workspaceId)
      )
    );
}

export async function bulkMarkAnomaliesReexamined(ids: number[], workspaceId: number) {
  if (ids.length === 0) return;
  await db
    .update(schema.scoreAnomalies)
    .set({ status: "re_examined", reviewedAt: new Date() })
    .where(
      and(
        inArray(schema.scoreAnomalies.id, ids),
        eq(schema.scoreAnomalies.workspaceId, workspaceId)
      )
    );
}

export async function getCompletedCompanyIds(workspaceId: number): Promise<number[]> {
  const rows = await db
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(
      and(
        eq(schema.companies.workspaceId, workspaceId),
        eq(schema.companies.analysisStatus, "completed")
      )
    );
  return rows.map(r => r.id);
}

export async function getLatestCompletedBatch(workspaceId: number, frameworkId: number) {
  const [batch] = await db
    .select({ id: schema.batchRuns.id })
    .from(schema.batchRuns)
    .where(
      and(
        eq(schema.batchRuns.workspaceId, workspaceId),
        eq(schema.batchRuns.frameworkId, frameworkId),
        eq(schema.batchRuns.status, "completed")
      )
    )
    .orderBy(desc(schema.batchRuns.completedAt))
    .limit(1);
  return batch || null;
}


// ─── Provider Failure Event Persistence ─────────────────────────────────────
// Durable record of provider failures for auditability and status reporting.
// Writes to the provider_failure_events table created in db.ts.

export interface ProviderFailureEventInput {
  provider: string;
  model: string;
  failureClass: string;
  httpStatus: number | null;
  errorMessage: string;
  jobId: number | null;
  batchId: number | null;
  measureId: string | null;
}

/**
 * Persist a provider failure event to the database. Non-fatal: callers should
 * catch and log errors rather than letting persistence failures block the
 * worker hot path.
 */
export async function recordProviderFailureEvent(event: ProviderFailureEventInput): Promise<void> {
  await db.execute(sql`
    INSERT INTO provider_failure_events (provider, model, failure_class, http_status, error_message, job_id, batch_id, measure_id)
    VALUES (${event.provider}, ${event.model}, ${event.failureClass}, ${event.httpStatus}, ${event.errorMessage}, ${event.jobId}, ${event.batchId}, ${event.measureId})
  `);
}

/**
 * Retrieve recent provider failure events, optionally filtered by provider
 * and/or batch. Returns newest-first, capped at `limit`.
 */
export async function getRecentProviderFailures(opts?: {
  provider?: string;
  batchId?: number;
  limit?: number;
}): Promise<Array<{
  id: number;
  provider: string;
  model: string;
  failureClass: string;
  httpStatus: number | null;
  errorMessage: string;
  jobId: number | null;
  batchId: number | null;
  measureId: string | null;
  createdAt: string;
}>> {
  const limit = opts?.limit ?? 50;
  if (opts?.provider && opts?.batchId) {
    const r = await db.execute(sql`
      SELECT id, provider, model, failure_class, http_status, error_message, job_id, batch_id, measure_id, created_at
      FROM provider_failure_events
      WHERE provider = ${opts.provider} AND batch_id = ${opts.batchId}
      ORDER BY id DESC LIMIT ${limit}
    `);
    return r.rows as any[];
  }
  if (opts?.provider) {
    const r = await db.execute(sql`
      SELECT id, provider, model, failure_class, http_status, error_message, job_id, batch_id, measure_id, created_at
      FROM provider_failure_events
      WHERE provider = ${opts.provider}
      ORDER BY id DESC LIMIT ${limit}
    `);
    return r.rows as any[];
  }
  if (opts?.batchId) {
    const r = await db.execute(sql`
      SELECT id, provider, model, failure_class, http_status, error_message, job_id, batch_id, measure_id, created_at
      FROM provider_failure_events
      WHERE batch_id = ${opts.batchId}
      ORDER BY id DESC LIMIT ${limit}
    `);
    return r.rows as any[];
  }
  const r = await db.execute(sql`
    SELECT id, provider, model, failure_class, http_status, error_message, job_id, batch_id, measure_id, created_at
    FROM provider_failure_events
    ORDER BY id DESC LIMIT ${limit}
  `);
  return r.rows as any[];
}
