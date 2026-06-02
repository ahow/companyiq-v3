import { db } from "./db.js";
import { eq, and, sql, desc, asc, inArray, isNull } from "drizzle-orm";
import * as schema from "../shared/schema.js";
import bcrypt from "bcryptjs";

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

// ─── Company Operations (Workspace-Scoped) ──────────────────────────────────

export async function getCompanies(workspaceId: number) {
  return db.select().from(schema.companies).where(eq(schema.companies.workspaceId, workspaceId)).orderBy(asc(schema.companies.name));
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
  return db.select().from(schema.companyLists).where(eq(schema.companyLists.workspaceId, workspaceId)).orderBy(desc(schema.companyLists.createdAt));
}

export async function createCompanyList(workspaceId: number, name: string, description?: string) {
  const [list] = await db.insert(schema.companyLists).values({ workspaceId, name, description }).returning();
  return list;
}

export async function getListCompanies(listId: number) {
  return db
    .select({ company: schema.companies })
    .from(schema.companyListMembers)
    .innerJoin(schema.companies, eq(schema.companyListMembers.companyId, schema.companies.id))
    .where(eq(schema.companyListMembers.listId, listId));
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
  return db.select().from(schema.frameworks).where(eq(schema.frameworks.workspaceId, workspaceId)).orderBy(desc(schema.frameworks.updatedAt));
}

export async function getActiveFramework(workspaceId: number) {
  const [framework] = await db
    .select()
    .from(schema.frameworks)
    .where(and(eq(schema.frameworks.workspaceId, workspaceId), eq(schema.frameworks.isActive, true)));
  return framework || null;
}

export async function getFrameworkById(frameworkId: number, workspaceId: number) {
  const [framework] = await db
    .select()
    .from(schema.frameworks)
    .where(and(eq(schema.frameworks.id, frameworkId), eq(schema.frameworks.workspaceId, workspaceId)));
  return framework || null;
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

// ─── Document Operations ────────────────────────────────────────────────────

export async function getAcceptedDocuments(companyId: number) {
  return db
    .select()
    .from(schema.documents)
    .where(and(eq(schema.documents.companyId, companyId), eq(schema.documents.gateVerdict, "accept")));
}

export async function getFetchedDocuments(companyId: number) {
  return db
    .select()
    .from(schema.documents)
    .where(and(eq(schema.documents.companyId, companyId), eq(schema.documents.fetchStatus, "ok")));
}

export async function upsertDocument(data: { companyId: number; url: string; title?: string; type: string; gateVerdict: string; gateReason?: string }) {
  const [doc] = await db
    .insert(schema.documents)
    .values(data)
    .onConflictDoUpdate({
      target: [schema.documents.companyId, schema.documents.url],
      set: { title: data.title, gateVerdict: data.gateVerdict, gateReason: data.gateReason },
    })
    .returning();
  return doc;
}

export async function recordFetchSuccess(companyId: number, url: string, content: string) {
  await db
    .update(schema.documents)
    .set({ fetchStatus: "ok", content, fetchedAt: new Date() })
    .where(and(eq(schema.documents.companyId, companyId), eq(schema.documents.url, url)));
}

export async function recordFetchFailure(companyId: number, url: string) {
  await db.execute(sql`
    UPDATE documents SET fetch_failures = fetch_failures + 1,
    fetch_status = CASE WHEN fetch_failures + 1 >= 3 THEN 'dead' ELSE 'pending' END
    WHERE company_id = ${companyId} AND url = ${url}
  `);
}

export async function clearDiscoveredDocuments(companyId: number) {
  await db.delete(schema.documents).where(
    and(eq(schema.documents.companyId, companyId), eq(schema.documents.fetchStatus, "pending"))
  );
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

// ─── Batch Run Operations (Workspace-Scoped) ────────────────────────────────

export async function createBatchRun(workspaceId: number, frameworkId: number, totalJobs: number, listId?: number) {
  // Cancel any existing running batches for this workspace
  await db
    .update(schema.batchRuns)
    .set({ status: "cancelled", completedAt: new Date() })
    .where(and(eq(schema.batchRuns.workspaceId, workspaceId), eq(schema.batchRuns.status, "running")));

  const [batch] = await db.insert(schema.batchRuns).values({ workspaceId, frameworkId, listId, totalJobs }).returning();
  return batch;
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

export async function incrementBatchCompleted(batchId: number) {
  const [batch] = await db.execute(sql`
    UPDATE batch_runs SET completed_jobs = completed_jobs + 1
    WHERE id = ${batchId}
    RETURNING id, completed_jobs, failed_jobs, total_jobs
  `).then(r => r.rows);
  return batch;
}

export async function incrementBatchFailed(batchId: number) {
  const [batch] = await db.execute(sql`
    UPDATE batch_runs SET failed_jobs = failed_jobs + 1
    WHERE id = ${batchId}
    RETURNING id, completed_jobs, failed_jobs, total_jobs
  `).then(r => r.rows);
  return batch;
}

export async function completeBatchRun(batchId: number) {
  await db.update(schema.batchRuns).set({ status: "completed", completedAt: new Date() }).where(eq(schema.batchRuns.id, batchId));
}

export async function cancelBatchRun(batchId: number) {
  await db.update(schema.batchRuns).set({ status: "cancelled", completedAt: new Date() }).where(eq(schema.batchRuns.id, batchId));
}

// ─── Job Queue Operations ───────────────────────────────────────────────────

export async function createAnalysisJobs(jobs: Array<{ workspaceId: number; batchId: number; companyId: number; companyName: string; frameworkId: number }>) {
  if (jobs.length === 0) return [];
  return db.insert(schema.analysisJobs).values(jobs).returning();
}

export async function claimJob(jobId: number) {
  // Claim a specific job by ID
  const result = await db.execute(sql`
    UPDATE analysis_jobs SET
      status = 'claimed',
      claimed_at = NOW(),
      attempts = attempts + 1
    WHERE id = ${jobId} AND (status = 'pending' OR (status = 'claimed' AND attempts < 3))
    RETURNING *
  `);
  return result.rows[0] || null;
}

export async function completeJob(jobId: number) {
  await db.update(schema.analysisJobs).set({ status: "completed", completedAt: new Date() }).where(eq(schema.analysisJobs.id, jobId));
}

export async function failJob(jobId: number, error: string) {
  await db.execute(sql`
    UPDATE analysis_jobs SET
      status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END,
      last_error = ${error},
      worker_id = NULL,
      claimed_at = NULL
    WHERE id = ${jobId}
  `);
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

// ─── Trusted Sources ────────────────────────────────────────────────────────

export async function getTrustedSources(workspaceId: number) {
  return db.select().from(schema.trustedSources).where(eq(schema.trustedSources.workspaceId, workspaceId));
}

export async function addTrustedSource(workspaceId: number, name: string, domain: string) {
  const [source] = await db.insert(schema.trustedSources).values({ workspaceId, name, domain }).returning();
  return source;
}

export async function deleteTrustedSource(id: number, workspaceId: number) {
  await db.delete(schema.trustedSources).where(and(eq(schema.trustedSources.id, id), eq(schema.trustedSources.workspaceId, workspaceId)));
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

// ─── Processing Errors ──────────────────────────────────────────────────────

export async function logProcessingError(data: { workspaceId?: number; companyId?: number; companyName?: string; stage?: string; error?: string }) {
  await db.insert(schema.processingErrors).values(data);
}

// ─── Analysis Results ───────────────────────────────────────────────────────

export async function saveAnalysisResults(data: { workspaceId: number; batchId: number; frameworkId: number; frameworkName: string; resultsData: any; companiesCount: number }) {
  const [result] = await db.insert(schema.analysisResults).values(data).returning();
  return result;
}

export async function getAnalysisResults(workspaceId: number) {
  return db.select().from(schema.analysisResults).where(eq(schema.analysisResults.workspaceId, workspaceId)).orderBy(desc(schema.analysisResults.createdAt));
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

export async function upsertCompanyTerminology(data: { companyId: number; frameworkId: number; terms: any; status?: string }) {
  return cacheTerminology(data.companyId, data.frameworkId, data.terms);
}
