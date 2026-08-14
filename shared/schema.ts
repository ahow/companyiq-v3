import { pgTable, serial, text, integer, boolean, timestamp, real, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

// ─── Users & Workspaces ─────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const workspaces = pgTable("workspaces", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  ownerId: integer("owner_id").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const workspaceMembers = pgTable("workspace_members", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").references(() => workspaces.id).notNull(),
  userId: integer("user_id").references(() => users.id).notNull(),
  role: text("role").notNull().default("member"), // "owner" | "admin" | "member"
  joinedAt: timestamp("joined_at").defaultNow().notNull(),
}, (table) => ({
  uniqueMember: uniqueIndex("unique_workspace_member").on(table.workspaceId, table.userId),
}));

// ─── Companies (Workspace-Scoped) ──────────────────────────────────────────

export const companies = pgTable("companies", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").references(() => workspaces.id).notNull(),
  name: text("name").notNull(),
  isin: text("isin"),
  domain: text("domain"),
  sector: text("sector"),
  country: text("country"),
  ticker: text("ticker"),
  pinnedDocuments: jsonb("pinned_documents").$type<string[]>(),
  analysisStatus: text("analysis_status").notNull().default("idle"), // idle | fetching | fetched | analyzing | completed | failed
  totalScore: real("total_score"),
  measuresMetCount: integer("measures_met_count"),
  measuresTotalCount: integer("measures_total_count"),
  summary: text("summary"),
  discoveryDiagnostics: jsonb("discovery_diagnostics"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  workspaceIdx: index("companies_workspace_idx").on(table.workspaceId),
  statusIdx: index("companies_status_idx").on(table.workspaceId, table.analysisStatus),
  // Finding 1 fix: structurally prevent duplicate securities. One row per
  // (workspace, normalized ISIN). Partial so rows without an ISIN are unaffected.
  isinUniq: uniqueIndex("companies_ws_isin_uniq")
    .on(table.workspaceId, sql`upper(trim(${table.isin}))`)
    .where(sql`${table.isin} is not null and trim(${table.isin}) <> ''`),
}));

// ─── Company Lists (Workspace-Scoped) ──────────────────────────────────────

export const companyLists = pgTable("company_lists", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").references(() => workspaces.id).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  isShared: boolean("is_shared").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  workspaceIdx: index("lists_workspace_idx").on(table.workspaceId),
}));

export const companyListMembers = pgTable("company_list_members", {
  id: serial("id").primaryKey(),
  listId: integer("list_id").references(() => companyLists.id).notNull(),
  companyId: integer("company_id").references(() => companies.id).notNull(),
}, (table) => ({
  uniqueListMember: uniqueIndex("unique_list_member").on(table.listId, table.companyId),
}));

// ─── Frameworks (Workspace-Scoped) ─────────────────────────────────────────

export const frameworks = pgTable("frameworks", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").references(() => workspaces.id).notNull(),
  name: text("name").notNull(),
  topicDescription: text("topic_description"),
  version: integer("version").notNull().default(1),
  isActive: boolean("is_active").notNull().default(false),
  isShared: boolean("is_shared").notNull().default(false),
  trustedSourceIds: jsonb("trusted_source_ids").$type<number[]>(),
  searchTemplates: jsonb("search_templates").$type<string[]>(),
  negativeKeywords: jsonb("negative_keywords").$type<string[]>(),
  negativeDomains: jsonb("negative_domains").$type<string[]>(),
  knownDisclosureUrls: jsonb("known_disclosure_urls").$type<string[]>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  workspaceIdx: index("frameworks_workspace_idx").on(table.workspaceId),
}));

export const frameworkMeasures = pgTable("framework_measures", {
  id: serial("id").primaryKey(),
  frameworkId: integer("framework_id").references(() => frameworks.id).notNull(),
  measureId: text("measure_id").notNull(),
  category: text("category").notNull(),
  categoryNumber: integer("category_number").notNull(),
  title: text("title").notNull(),
  definition: text("definition"),
  scoringGuidance: text("scoring_guidance"),
  evidenceKeywords: jsonb("evidence_keywords").$type<string[]>(),
  // v3e (Section 3 + 5): per-measure declaration of which document/source TYPES
  // are REQUIRED to answer this measure (e.g. ["regulatory-filing"], ["proxy"],
  // ["annual-report"]). TOPIC-AGNOSTIC: the values are framework-authored source
  // categories, NOT topic keywords. When set and none of the required types are
  // present in the company's corpus, the measure is scored "Insufficient evidence"
  // (abstained) rather than a hard "No". Empty/null = no requirement (default).
  requiredSourceTypes: jsonb("required_source_types").$type<string[]>(),
  displayOrder: integer("display_order").notNull().default(0),
}, (table) => ({
  frameworkIdx: index("measures_framework_idx").on(table.frameworkId),
}));

// ─── Document Content (Deduplicated, Shared Across Companies) ────────────────

export const documentContent = pgTable("document_content", {
  id: serial("id").primaryKey(),
  urlHash: text("url_hash").notNull().unique(), // SHA-256 of normalized URL
  url: text("url").notNull(),
  content: text("content").notNull(),
  contentLength: integer("content_length").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ─── Documents (Company-Level, Reusable Across Frameworks) ─────────────────

export const documents = pgTable("documents", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  url: text("url").notNull(),
  title: text("title"),
  type: text("type").notNull().default("html"), // html | pdf
  gateVerdict: text("gate_verdict"), // accept | reject
  gateReason: text("gate_reason"),
  fetchStatus: text("fetch_status").notNull().default("pending"), // pending | ok | dead
  fetchFailures: integer("fetch_failures").notNull().default(0),
  contentId: integer("content_id").references(() => documentContent.id), // FK to deduplicated content
  content: text("content"), // DEPRECATED: kept for migration rollback safety, will be NULLed
  // Review fix 2.3: distinguish first-party (company's own disclosure) from
  // third-party (news, NGO commentary, aggregators). Passed to scorer so
  // commitment-type measures require first-party support.
  sourceType: text("source_type"), // "first_party" | "third_party" | null (legacy)
  fetchedAt: timestamp("fetched_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  companyIdx: index("documents_company_idx").on(table.companyId),
  companyUrlIdx: uniqueIndex("documents_company_url_idx").on(table.companyId, table.url),
}));

// ─── Measure Scores (Framework-Specific Results) ───────────────────────────

export const measureScores = pgTable("measure_scores", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  frameworkId: integer("framework_id").references(() => frameworks.id).notNull(),
  measureId: text("measure_id").notNull(),
  category: text("category").notNull(),
  categoryNumber: integer("category_number").notNull(),
  title: text("title").notNull(),
  definition: text("definition"),
  score: real("score").notNull().default(0),
  coverage: text("coverage"),
  confidence: text("confidence").notNull().default("Low"),
  evidenceSummary: text("evidence_summary"),
  quotes: jsonb("quotes").$type<Array<{ text: string; source: string; sourceUrl?: string; page?: number }>>(),
  verdict: text("verdict").notNull().default("No"), // Yes | No | Partial | Insufficient evidence
  verdictNuance: text("verdict_nuance"),
  // v3e (Section 3): true when the measure could not be answered because a
  // REQUIRED source type was absent from the corpus. Abstained measures contribute
  // 0 to the numerator AND are excluded from the answered-measures denominator.
  abstained: boolean("abstained").notNull().default(false),
  // v3e (Section 4): SHA1 of the sorted evidence-chunk identifiers that produced
  // this verdict, enabling identical-evidence verdict caching and drift logging.
  evidenceFingerprint: text("evidence_fingerprint"),
  // Methodology versioning (review fix 3.2/4.1): enables cross-batch comparability,
  // model-mix detection, and prompt-drift tracking.
  modelId: text("model_id"),              // e.g. "deepseek-chat", "gpt-4o-mini"
  promptHash: text("prompt_hash"),         // SHA-256 of the scoring prompt template
  pipelineVersion: text("pipeline_version"), // git SHA or semantic version tag
  displayOrder: integer("display_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  companyFrameworkIdx: index("scores_company_framework_idx").on(table.companyId, table.frameworkId),
}));

// ─── Batch Runs (Workspace-Scoped) ─────────────────────────────────────────

export const batchRuns = pgTable("batch_runs", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").references(() => workspaces.id).notNull(),
  frameworkId: integer("framework_id").references(() => frameworks.id).notNull(),
  listId: integer("list_id").references(() => companyLists.id),
  status: text("status").notNull().default("running"), // running | completed | cancelled
  totalJobs: integer("total_jobs").notNull().default(0),
  completedJobs: integer("completed_jobs").notNull().default(0),
  failedJobs: integer("failed_jobs").notNull().default(0),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
}, (table) => ({
  workspaceIdx: index("batch_workspace_idx").on(table.workspaceId),
  statusIdx: index("batch_status_idx").on(table.status),
}));

// ─── Analysis Jobs (Queue) ─────────────────────────────────────────────────

export const analysisJobs = pgTable("analysis_jobs", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").references(() => workspaces.id).notNull(),
  batchId: integer("batch_id").references(() => batchRuns.id).notNull(),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  companyName: text("company_name").notNull(),
  frameworkId: integer("framework_id").references(() => frameworks.id).notNull(),
  status: text("status").notNull().default("pending"), // pending | claimed | completed | failed
  workerId: text("worker_id"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  claimedAt: timestamp("claimed_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  statusIdx: index("jobs_status_idx").on(table.status),
  batchIdx: index("jobs_batch_idx").on(table.batchId),
  workspaceIdx: index("jobs_workspace_idx").on(table.workspaceId),
}));

// ─── Summary Cache ─────────────────────────────────────────────────────────

export const summaryCache = pgTable("summary_cache", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  documentHash: text("document_hash").notNull(),
  summary: text("summary").notNull(),
  summarizerModel: text("summarizer_model"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  companyHashIdx: uniqueIndex("summary_company_hash_idx").on(table.companyId, table.documentHash),
}));

// ─── Terminology Cache ─────────────────────────────────────────────────────

export const terminologyCache = pgTable("terminology_cache", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  frameworkId: integer("framework_id").references(() => frameworks.id).notNull(),
  terms: jsonb("terms").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  companyFrameworkIdx: uniqueIndex("terminology_company_framework_idx").on(table.companyId, table.frameworkId),
}));

// ─── Trusted Sources (Workspace-Scoped) ────────────────────────────────────

export const trustedSources = pgTable("trusted_sources", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").references(() => workspaces.id).notNull(),
  name: text("name").notNull(),
  domain: text("domain").notNull(),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  workspaceIdx: index("trusted_workspace_idx").on(table.workspaceId),
}));

// ─── Excluded Sources (Workspace-Scoped) ─────────────────────────────────

export const excludedSources = pgTable("excluded_sources", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").references(() => workspaces.id).notNull(),
  domain: text("domain").notNull(),
  reason: text("reason"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  workspaceIdx: index("excluded_workspace_idx").on(table.workspaceId),
}));

// ─── Platform Sources (Global — shared multi-tenant hosts) ─────────────────
// Hosts that serve documents for MANY different companies (shared
// investor-relations CDNs, blogs, aggregators). A document on one of these
// hosts is ALWAYS issuer-verified by the LLM, even if it would otherwise
// match a company's own verified domain (closes the fast-path bypass).
// `autoDetected` marks entries added by the >=3-companies heuristic.

export const platformSources = pgTable("platform_sources", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").references(() => workspaces.id),
  domain: text("domain").notNull(),
  reason: text("reason"),
  autoDetected: boolean("auto_detected").notNull().default(false),
  companyCount: integer("company_count"),
  isActive: boolean("is_active").notNull().default(true),
  // When true, this domain has been deliberately removed and must NOT be
  // re-added by the >=3-companies auto-detection, even if it keeps qualifying.
  suppressed: boolean("suppressed").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  domainIdx: uniqueIndex("platform_domain_idx").on(table.domain),
}));

// ─── Workspace Settings ────────────────────────────────────────────────────

export const workspaceSettings = pgTable("workspace_settings", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").references(() => workspaces.id).notNull(),
  key: text("key").notNull(),
  value: text("value").notNull(),
}, (table) => ({
  workspaceKeyIdx: uniqueIndex("settings_workspace_key_idx").on(table.workspaceId, table.key),
}));

// ─── Processing Errors (for diagnostics) ───────────────────────────────────

export const processingErrors = pgTable("processing_errors", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").references(() => workspaces.id),
  companyId: integer("company_id"),
  companyName: text("company_name"),
  stage: text("stage"),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Analysis Results Snapshots ────────────────────────────────────────────

export const analysisResults = pgTable("analysis_results", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").references(() => workspaces.id).notNull(),
  batchId: integer("batch_id").references(() => batchRuns.id).notNull(),
  frameworkId: integer("framework_id").references(() => frameworks.id).notNull(),
  frameworkName: text("framework_name").notNull(),
  listName: text("list_name"),
  resultsData: jsonb("results_data").notNull(),
  companiesCount: integer("companies_count").notNull(),
  averageScore: integer("average_score"),
  shareToken: text("share_token"),
  isPublic: boolean("is_public").notNull().default(false),
  shareExpiresAt: timestamp("share_expires_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  workspaceIdx: index("results_workspace_idx").on(table.workspaceId),
}));

// ─── Score Anomalies (Expected-Score Outlier Detection) ─────────────────────

export const scoreAnomalies = pgTable("score_anomalies", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").references(() => workspaces.id).notNull(),
  batchId: integer("batch_id").references(() => batchRuns.id).notNull(),
  frameworkId: integer("framework_id").references(() => frameworks.id).notNull(),
  companyId: integer("company_id").references(() => companies.id).notNull(),
  companyName: text("company_name").notNull(),
  sector: text("sector"),
  country: text("country"),
  actualScore: real("actual_score").notNull(),
  expectedScore: real("expected_score").notNull(),
  residual: real("residual").notNull(), // actual - expected (positive = over, negative = under)
  peerGroupSize: integer("peer_group_size").notNull(),
  peerGroupMedian: real("peer_group_median").notNull(),
  reason: text("reason").notNull(), // human-readable explanation
  status: text("status").notNull().default("pending"), // pending | reviewed | re_examined | dismissed
  createdAt: timestamp("created_at").defaultNow().notNull(),
  reviewedAt: timestamp("reviewed_at"),
}, (table) => ({
  workspaceIdx: index("anomalies_workspace_idx").on(table.workspaceId),
  batchIdx: index("anomalies_batch_idx").on(table.batchId),
  statusIdx: index("anomalies_status_idx").on(table.workspaceId, table.status),
}));

// ─── Type Exports ──────────────────────────────────────────────────────────

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type Workspace = typeof workspaces.$inferSelect;
export type InsertWorkspace = typeof workspaces.$inferInsert;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type Company = typeof companies.$inferSelect;
export type InsertCompany = typeof companies.$inferInsert;
export type CompanyList = typeof companyLists.$inferSelect;
export type Framework = typeof frameworks.$inferSelect;
export type InsertFramework = typeof frameworks.$inferInsert;
export type FrameworkMeasure = typeof frameworkMeasures.$inferSelect;
export type InsertFrameworkMeasure = typeof frameworkMeasures.$inferInsert;
export type DocumentContent = typeof documentContent.$inferSelect;
export type InsertDocumentContent = typeof documentContent.$inferInsert;
export type Document = typeof documents.$inferSelect;
export type MeasureScore = typeof measureScores.$inferSelect;
export type BatchRun = typeof batchRuns.$inferSelect;
export type AnalysisJob = typeof analysisJobs.$inferSelect;
export type TrustedSource = typeof trustedSources.$inferSelect;
export type WorkspaceSetting = typeof workspaceSettings.$inferSelect;
export type AnalysisResultSnapshot = typeof analysisResults.$inferSelect;
export type ExcludedSource = typeof excludedSources.$inferSelect;
export type PlatformSource = typeof platformSources.$inferSelect;
export type ScoreAnomaly = typeof scoreAnomalies.$inferSelect;
export type InsertScoreAnomaly = typeof scoreAnomalies.$inferInsert;
