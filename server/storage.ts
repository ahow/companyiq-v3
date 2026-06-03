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
      fetchedAt: schema.documents.fetchedAt,
      createdAt: schema.documents.createdAt,
    })
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

// Bulk reset all companies in a workspace (efficient single SQL statements)
export async function resetAllCompanies(workspaceId: number): Promise<number> {
  // Delete all measure scores for companies in this workspace
  await db.execute(sql`
    DELETE FROM measure_scores WHERE company_id IN (
      SELECT id FROM companies WHERE workspace_id = ${workspaceId}
    )
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

export async function addTrustedSource(workspaceId: number, name: string, domain: string, description?: string | null) {
  const [source] = await db.insert(schema.trustedSources).values({ workspaceId, name, domain, description: description || null }).returning();
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

// ─── Framework Editor Operations ───────────────────────────────────────────
export async function updateFramework(frameworkId: number, updates: Partial<{ name: string; topicDescription: string; trustedSourceIds: number[]; searchTemplates: string[]; negativeKeywords: string[]; negativeDomains: string[]; knownDisclosureUrls: string[] }>) {
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

export async function updateMeasure(frameworkId: number, measureId: string, updates: Partial<{ title: string; definition: string; scoringGuidance: any; evidenceKeywords: string[]; category: string }>) {
  const setObj: any = {};
  if (updates.title !== undefined) setObj.title = updates.title;
  if (updates.definition !== undefined) setObj.definition = updates.definition;
  if (updates.category !== undefined) setObj.category = updates.category;
  if (updates.evidenceKeywords !== undefined) setObj.evidenceKeywords = updates.evidenceKeywords;
  if (updates.scoringGuidance !== undefined) {
    setObj.scoringGuidance = typeof updates.scoringGuidance === 'object'
      ? JSON.stringify(updates.scoringGuidance)
      : updates.scoringGuidance;
  }
  if (Object.keys(setObj).length > 0) {
    await db.execute(sql`
      UPDATE framework_measures SET ${sql.raw(
        Object.entries(setObj).map(([k, v]) => {
          const col = k.replace(/([A-Z])/g, '_$1').toLowerCase();
          return `${col} = '${String(v).replace(/'/g, "''")}'`;
        }).join(', ')
      )}
      WHERE framework_id = ${frameworkId} AND measure_id = ${measureId}
    `);
  }
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
