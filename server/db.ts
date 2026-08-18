import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import * as schema from "../shared/schema.js";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required");
}

// PG pool size is environment-driven so we can scale worker replicas safely.
// Railway Postgres has max_connections=100; with N worker replicas the total
// pool demand is N * PG_POOL_MAX (plus the app service). Keep N*PG_POOL_MAX
// comfortably under ~90. e.g. 8 replicas * 10 = 80. Each replica only runs
// WORKER_CONCURRENCY jobs at a time, so 10 connections/replica is ample.
const PG_POOL_MAX = parseInt(process.env.PG_POOL_MAX || "20", 10);

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: PG_POOL_MAX,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

export const db = drizzle(pool, { schema });

/**
 * Auto-create tables on startup if they don't exist.
 * DDL matches shared/schema.ts exactly.
 */
export async function initializeDatabase(): Promise<void> {
  console.log("[DB] Initializing database tables...");

  try {
    // ─── Users ──────────────────────────────────────────────────────────────
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);

    // ─── Workspaces ─────────────────────────────────────────────────────────
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS workspaces (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL DEFAULT '',
        owner_id INTEGER NOT NULL REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);
    await db.execute(sql`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS slug TEXT NOT NULL DEFAULT ''`);

    // ─── Workspace Members ──────────────────────────────────────────────────
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS workspace_members (
        id SERIAL PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        role TEXT DEFAULT 'member' NOT NULL,
        joined_at TIMESTAMP DEFAULT NOW() NOT NULL,
        UNIQUE(workspace_id, user_id)
      )
    `);

    // ─── Frameworks ─────────────────────────────────────────────────────────
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS frameworks (
        id SERIAL PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
        name TEXT NOT NULL,
        topic_description TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        is_active BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);

    // Add framework discovery configuration columns
    await db.execute(sql`ALTER TABLE frameworks ADD COLUMN IF NOT EXISTS is_shared BOOLEAN NOT NULL DEFAULT false`);
    await db.execute(sql`ALTER TABLE frameworks ADD COLUMN IF NOT EXISTS trusted_source_ids JSONB`);
    await db.execute(sql`ALTER TABLE frameworks ADD COLUMN IF NOT EXISTS search_templates JSONB`);
    await db.execute(sql`ALTER TABLE frameworks ADD COLUMN IF NOT EXISTS negative_keywords JSONB`);
    await db.execute(sql`ALTER TABLE frameworks ADD COLUMN IF NOT EXISTS negative_domains JSONB`);
    await db.execute(sql`ALTER TABLE frameworks ADD COLUMN IF NOT EXISTS known_disclosure_urls JSONB`);

    // ─── Framework Measures ─────────────────────────────────────────────────
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS framework_measures (
        id SERIAL PRIMARY KEY,
        framework_id INTEGER NOT NULL REFERENCES frameworks(id),
        measure_id TEXT NOT NULL,
        category TEXT NOT NULL,
        category_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        definition TEXT,
        scoring_guidance TEXT,
        evidence_keywords JSONB,
        display_order INTEGER NOT NULL DEFAULT 0
      )
    `);
    // v3e (Section 3+5): per-measure required source types (topic-agnostic gating).
    await db.execute(sql`ALTER TABLE framework_measures ADD COLUMN IF NOT EXISTS required_source_types JSONB`);

    // ─── Company Lists ──────────────────────────────────────────────────────
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS company_lists (
        id SERIAL PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
        name TEXT NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);

    await db.execute(sql`ALTER TABLE company_lists ADD COLUMN IF NOT EXISTS is_shared BOOLEAN NOT NULL DEFAULT false`);

    // ─── Companies ──────────────────────────────────────────────────────────
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS companies (
        id SERIAL PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
        name TEXT NOT NULL,
        isin TEXT,
        domain TEXT,
        sector TEXT,
        country TEXT,
        ticker TEXT,
        pinned_documents JSONB,
        analysis_status TEXT NOT NULL DEFAULT 'idle',
        total_score REAL,
        measures_met_count INTEGER,
        measures_total_count INTEGER,
        summary TEXT,
        discovery_diagnostics JSONB,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);

    // ─── Company List Members ───────────────────────────────────────────────
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS company_list_members (
        id SERIAL PRIMARY KEY,
        list_id INTEGER NOT NULL REFERENCES company_lists(id),
        company_id INTEGER NOT NULL REFERENCES companies(id)
      )
    `);

    // ─── Documents ──────────────────────────────────────────────────────────
    // ─── Document Content (Deduplicated) ──────────────────────────────────────
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS document_content (
        id SERIAL PRIMARY KEY,
        url_hash TEXT NOT NULL UNIQUE,
        url TEXT NOT NULL,
        content TEXT NOT NULL,
        content_length INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS documents (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id),
        url TEXT NOT NULL,
        title TEXT,
        type TEXT NOT NULL DEFAULT 'html',
        gate_verdict TEXT,
        gate_reason TEXT,
        fetch_status TEXT NOT NULL DEFAULT 'pending',
        fetch_failures INTEGER NOT NULL DEFAULT 0,
        content_id INTEGER REFERENCES document_content(id),
        content TEXT,
        fetched_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        UNIQUE(company_id, url)
      )
    `);
    // Migration: add content_id column if documents table already exists
    await db.execute(sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS content_id INTEGER REFERENCES document_content(id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS documents_content_id_idx ON documents(content_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS dc_url_hash_idx ON document_content(url_hash)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS dc_url_idx ON document_content(url)`);

    // ─── Measure Scores ─────────────────────────────────────────────────────
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS measure_scores (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id),
        framework_id INTEGER NOT NULL REFERENCES frameworks(id),
        measure_id TEXT NOT NULL,
        category TEXT NOT NULL,
        category_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        definition TEXT,
        score REAL NOT NULL DEFAULT 0,
        coverage TEXT,
        confidence TEXT NOT NULL DEFAULT 'Low',
        evidence_summary TEXT,
        quotes JSONB,
        verdict TEXT NOT NULL DEFAULT 'No',
        verdict_nuance TEXT,
        abstained BOOLEAN NOT NULL DEFAULT false,
        evidence_fingerprint TEXT,
        display_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);
    // v3e (Section 3 + 4): abstain flag + evidence fingerprint (idempotent migration).
    await db.execute(sql`ALTER TABLE measure_scores ADD COLUMN IF NOT EXISTS abstained BOOLEAN NOT NULL DEFAULT false`);
    await db.execute(sql`ALTER TABLE measure_scores ADD COLUMN IF NOT EXISTS evidence_fingerprint TEXT`);

    // ─── Batch Runs ─────────────────────────────────────────────────────────
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS batch_runs (
        id SERIAL PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
        framework_id INTEGER NOT NULL REFERENCES frameworks(id),
        list_id INTEGER REFERENCES company_lists(id),
        status TEXT NOT NULL DEFAULT 'running',
        total_jobs INTEGER NOT NULL DEFAULT 0,
        completed_jobs INTEGER NOT NULL DEFAULT 0,
        failed_jobs INTEGER NOT NULL DEFAULT 0,
        started_at TIMESTAMP DEFAULT NOW() NOT NULL,
        completed_at TIMESTAMP
      )
    `);

    // ─── Analysis Jobs ──────────────────────────────────────────────────────
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS analysis_jobs (
        id SERIAL PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
        batch_id INTEGER NOT NULL REFERENCES batch_runs(id),
        company_id INTEGER NOT NULL REFERENCES companies(id),
        company_name TEXT NOT NULL,
        framework_id INTEGER NOT NULL REFERENCES frameworks(id),
        status TEXT NOT NULL DEFAULT 'pending',
        worker_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        claimed_at TIMESTAMP,
        completed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);

    // ─── Summary Cache ──────────────────────────────────────────────────────
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS summary_cache (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id),
        document_hash TEXT NOT NULL,
        summary TEXT NOT NULL,
        summarizer_model TEXT,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        UNIQUE(company_id, document_hash)
      )
    `);

    // ─── Terminology Cache ──────────────────────────────────────────────────
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS terminology_cache (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id),
        framework_id INTEGER NOT NULL REFERENCES frameworks(id),
        terms JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        UNIQUE(company_id, framework_id)
      )
    `);

    // ─── Trusted Sources ────────────────────────────────────────────────────
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS trusted_sources (
        id SERIAL PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
        name TEXT NOT NULL,
        domain TEXT NOT NULL,
        description TEXT,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);
    await db.execute(sql`ALTER TABLE trusted_sources ADD COLUMN IF NOT EXISTS description TEXT`);
    await db.execute(sql`ALTER TABLE trusted_sources ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true`);

    // ─── Workspace Settings ─────────────────────────────────────────────────
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS workspace_settings (
        id SERIAL PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        UNIQUE(workspace_id, key)
      )
    `);

    // ─── Processing Errors ──────────────────────────────────────────────────
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS processing_errors (
        id SERIAL PRIMARY KEY,
        workspace_id INTEGER REFERENCES workspaces(id),
        company_id INTEGER,
        company_name TEXT,
        stage TEXT,
        error TEXT,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);

    // ─── System Alerts ────────────────────────────────────────────────────────
    // Cross-process, cross-replica alert state (e.g. API credit exhaustion).
    // One active row per `kind` is the convention; `active=false` rows are kept
    // for history. Read by the dashboard via /batch/status to render a banner.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS system_alerts (
        id SERIAL PRIMARY KEY,
        kind TEXT NOT NULL,
        provider TEXT,
        message TEXT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_system_alerts_active ON system_alerts(kind, active)
    `);

    // ─── Analysis Results Snapshots ─────────────────────────────────────────
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS analysis_results (
        id SERIAL PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
        batch_id INTEGER NOT NULL REFERENCES batch_runs(id),
        framework_id INTEGER NOT NULL REFERENCES frameworks(id),
        framework_name TEXT NOT NULL,
        list_name TEXT,
        results_data JSONB NOT NULL,
        companies_count INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);
    await db.execute(sql`ALTER TABLE analysis_results ADD COLUMN IF NOT EXISTS list_name TEXT`);
    await db.execute(sql`ALTER TABLE analysis_results ADD COLUMN IF NOT EXISTS average_score INTEGER`);
    await db.execute(sql`ALTER TABLE analysis_results ADD COLUMN IF NOT EXISTS share_token TEXT`);

    // ─── Indexes ────────────────────────────────────────────────────────────
    await db.execute(sql`CREATE INDEX IF NOT EXISTS companies_workspace_idx ON companies(workspace_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS companies_status_idx ON companies(workspace_id, analysis_status)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS lists_workspace_idx ON company_lists(workspace_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS measures_framework_idx ON framework_measures(framework_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS documents_company_idx ON documents(company_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS scores_company_framework_idx ON measure_scores(company_id, framework_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS batch_workspace_idx ON batch_runs(workspace_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS batch_status_idx ON batch_runs(status)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS jobs_status_idx ON analysis_jobs(status)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS jobs_batch_idx ON analysis_jobs(batch_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS jobs_workspace_idx ON analysis_jobs(workspace_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS frameworks_workspace_idx ON frameworks(workspace_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS trusted_workspace_idx ON trusted_sources(workspace_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS results_workspace_idx ON analysis_results(workspace_id)`);

    // ─── Excluded Sources ────────────────────────────────────────────────────
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS excluded_sources (
        id SERIAL PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
        domain TEXT NOT NULL,
        reason TEXT,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS excluded_workspace_idx ON excluded_sources(workspace_id)`);

    // ─── Platform Sources (GLOBAL — shared multi-tenant hosts) ───────────────
    // workspace_id is nullable (global rows use NULL). domain is globally unique.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS platform_sources (
        id SERIAL PRIMARY KEY,
        workspace_id INTEGER REFERENCES workspaces(id),
        domain TEXT NOT NULL,
        reason TEXT,
        auto_detected BOOLEAN NOT NULL DEFAULT false,
        company_count INTEGER,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS platform_domain_idx ON platform_sources(domain)`);
    await db.execute(sql`ALTER TABLE platform_sources ADD COLUMN IF NOT EXISTS suppressed BOOLEAN NOT NULL DEFAULT false`);

    // Seed well-known shared/multi-tenant hosts (idempotent).
    const seedPlatformHosts: { domain: string; reason: string }[] = [
      { domain: "q4cdn.com", reason: "Shared investor-relations CDN (hosts many issuers)" },
      { domain: "q4web.com", reason: "Shared investor-relations platform" },
      { domain: "q4inc.com", reason: "Shared investor-relations platform" },
      { domain: "s3.amazonaws.com", reason: "Shared object storage (multi-tenant)" },
      { domain: "cloudfront.net", reason: "Shared CDN (multi-tenant)" },
      { domain: "sharepoint.com", reason: "Shared document hosting (multi-tenant)" },
      { domain: "substack.com", reason: "Third-party blog platform (multi-author)" },
      { domain: "blogspot.com", reason: "Third-party blog platform (multi-author)" },
      { domain: "wordpress.com", reason: "Third-party blog platform (multi-author)" },
      { domain: "medium.com", reason: "Third-party blog platform (multi-author)" },
      { domain: "seekingalpha.com", reason: "Third-party financial aggregator (covers many companies)" },
      { domain: "marketscreener.com", reason: "Third-party financial aggregator (covers many companies)" },
      { domain: "financialreports.eu", reason: "Third-party filing aggregator (covers many companies)" },
    ];
    for (const p of seedPlatformHosts) {
      await db.execute(sql`
        INSERT INTO platform_sources (workspace_id, domain, reason, auto_detected, is_active)
        VALUES (NULL, ${p.domain}, ${p.reason}, false, true)
        ON CONFLICT (domain) DO NOTHING
      `);
    }

    // ─── Review Fix Columns (Aug 2026) ─────────────────────────────────
    // Fix 5: Methodology versioning on measure_scores
    await db.execute(sql`ALTER TABLE measure_scores ADD COLUMN IF NOT EXISTS model_id TEXT`);
    await db.execute(sql`ALTER TABLE measure_scores ADD COLUMN IF NOT EXISTS prompt_hash TEXT`);
    await db.execute(sql`ALTER TABLE measure_scores ADD COLUMN IF NOT EXISTS pipeline_version TEXT`);
    // Fix 6: First-party vs third-party evidence tagging
    await db.execute(sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_type TEXT`);
    // Share lifecycle: opt-in public sharing + expiry
    await db.execute(sql`ALTER TABLE analysis_results ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false`);
    await db.execute(sql`ALTER TABLE analysis_results ADD COLUMN IF NOT EXISTS share_expires_at TIMESTAMP`);
    // Off-peak scheduling: flag batches to only run during DeepSeek off-peak hours
    await db.execute(sql`ALTER TABLE batch_runs ADD COLUMN IF NOT EXISTS off_peak_only BOOLEAN NOT NULL DEFAULT false`);
    // Score-only mode: skip fetch phase, score from stored corpus (reproducibility fix)
    await db.execute(sql`ALTER TABLE batch_runs ADD COLUMN IF NOT EXISTS score_only BOOLEAN NOT NULL DEFAULT false`);
    // Snapshot persistence: track whether the results snapshot was saved successfully
    await db.execute(sql`ALTER TABLE batch_runs ADD COLUMN IF NOT EXISTS snapshot_saved BOOLEAN NOT NULL DEFAULT false`);
    // Backfill: mark historical batches that already have snapshots in analysis_results
    await db.execute(sql`
      UPDATE batch_runs SET snapshot_saved = TRUE
      WHERE status = 'completed' AND snapshot_saved = FALSE
        AND id IN (SELECT DISTINCT (results_data->>'batchId')::int FROM analysis_results WHERE results_data->>'batchId' IS NOT NULL)
    `);
    // Dead-fetch diagnosis fix 1: record failure reason on documents
    await db.execute(sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS failure_reason TEXT`);
    await db.execute(sql`ALTER TABLE documents ALTER COLUMN failure_reason SET DEFAULT 'unspecified'`);

    // Corpus snapshot: freeze the evidence set per batch for reproducibility
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS batch_corpus (
        batch_id INTEGER NOT NULL,
        company_id INTEGER NOT NULL,
        document_id INTEGER NOT NULL,
        PRIMARY KEY (batch_id, company_id, document_id)
      )
    `);


    // P2d: Framework-declared required document types and data patterns
    await db.execute(sql`ALTER TABLE frameworks ADD COLUMN IF NOT EXISTS required_doc_types JSONB`);
    await db.execute(sql`ALTER TABLE frameworks ADD COLUMN IF NOT EXISTS data_patterns JSONB`);

    // B8: Topic-branched data-seed migrations REMOVED (Instruction 35 commit).
    // These fields are now populated by the framework-builder route on framework
    // creation, derived from the framework's own measures/evidenceKeywords.
    // Existing production rows (fw3/fw8/fw AI) retain their values because the
    // seeds only fired when the field was NULL, and they've already run.
    // See server/routes/framework-builder.ts for the replacement derivation logic.

    // Instruction 21a: Add legacyQueryTemplates and multiDocumentQueryTemplates columns
    await db.execute(sql`ALTER TABLE frameworks ADD COLUMN IF NOT EXISTS legacy_query_templates JSONB`);
    await db.execute(sql`ALTER TABLE frameworks ADD COLUMN IF NOT EXISTS multi_document_query_templates JSONB`);

    // B5: Auto-populate legacy_query_templates and multi_document_query_templates
    // from each framework's evidenceKeywords (generalised, no topic branches).
    // Frameworks that already have templates populated are not overwritten.
    await db.execute(sql`
      UPDATE frameworks f SET legacy_query_templates = (
        SELECT jsonb_agg(DISTINCT '"{company}" ' || elem || ' {currentYear} OR {lastYear}')
        FROM (
          SELECT DISTINCT jsonb_array_elements_text(m.evidence_keywords) AS elem
          FROM framework_measures m
          WHERE m.framework_id = f.id AND m.evidence_keywords IS NOT NULL
            AND jsonb_array_length(m.evidence_keywords) > 0
          LIMIT 8
        ) sub
      )
      WHERE (f.legacy_query_templates IS NULL OR jsonb_array_length(f.legacy_query_templates) = 0)
    `);

    // Fix B: Add prior_best_score column for below-prior-best diagnostics
    await db.execute(sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS prior_best_score INTEGER`);

    // 40-0: OpenFIGI canonical-name resolution fields
    await db.execute(sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS figi_name TEXT`);
    await db.execute(sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS figi_ticker TEXT`);
    await db.execute(sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS figi_resolved_at TIMESTAMPTZ`);
    // 42-A: Pipeline version tags for cache invalidation
    await db.execute(sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS figi_pipeline_version TEXT`);
    // 40-D: Evidence-gated related domains
    await db.execute(sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS related_domains JSONB`);
    // 40-E: Manual override for cross-brand domain siblings
    await db.execute(sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS related_domains_manual JSONB`);
    // 42-A: Pipeline version for related domains cache
    await db.execute(sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS related_domains_pipeline_version TEXT`);

    // 42-G: Explicitly null out pipeline version on existing rows so the new
    // cache-check treats them as needing re-derivation. Idempotent.
    await db.execute(sql`
      UPDATE companies SET
        figi_pipeline_version = NULL,
        related_domains_pipeline_version = NULL
      WHERE figi_pipeline_version IS NULL OR related_domains_pipeline_version IS NULL
    `);

    // Instruction 31: Add authoritative_registries and authoritative_filing_types columns
    await db.execute(sql`ALTER TABLE frameworks ADD COLUMN IF NOT EXISTS authoritative_registries JSONB`);
    // B1: Add scoring_examples and anti_inference_rules columns
    await db.execute(sql`ALTER TABLE frameworks ADD COLUMN IF NOT EXISTS scoring_examples JSONB`);
    await db.execute(sql`ALTER TABLE frameworks ADD COLUMN IF NOT EXISTS anti_inference_rules JSONB`);
    await db.execute(sql`ALTER TABLE frameworks ADD COLUMN IF NOT EXISTS authoritative_filing_types JSONB`);


    // B7 repair: fix corrupted authoritativeFilingTypes patterns containing literal
    // backspace characters (0x08) where \b word boundaries were intended.
    // Idempotent: only rows whose JSONB-cast-to-text contains the two-char sequence
    // `\b` are updated. This condition alone scopes to affected rows (only fw3 patterns
    // used \b word boundaries), so no topic branch is needed.
    await db.execute(sql`
      UPDATE frameworks SET
        authoritative_filing_types = '[{"pattern":"\\\\bcdp\\\\b|tcfd|climate.?report","weight":8.0},{"pattern":"sustainab|esg\\\\b|csr\\\\b|responsibility","weight":6.0}]'::jsonb
      WHERE authoritative_filing_types::text LIKE '%\\b%'
    `);

    // 41-C: Add withdrawal_patterns column
    await db.execute(sql`ALTER TABLE frameworks ADD COLUMN IF NOT EXISTS withdrawal_patterns JSONB DEFAULT '{"queries": [], "documentRegex": []}'::jsonb`);

    // 41-C: Seed fw3 (climate) withdrawal patterns
    await db.execute(sql`
      UPDATE frameworks SET withdrawal_patterns = '{
        "queries": [
          "\\"\{companyName\}\\" withdraws climate target OR drops net zero OR leaves NZBA",
          "\\"\{companyName\}\\" scraps financed emissions target OR abandons climate goal",
          "\\"\{companyName\}\\" removes coal policy OR drops fossil fuel exclusion"
        ],
        "documentRegex": [
          "(?:withdrew|exited|left) (?:the )?(?:Net.?Zero|NZBA|SBTi|Climate Action)",
          "(?:removed|deleted) .{0,30}(?:coal|fossil|climate|net.?zero) .{0,30}(?:policy|commitment|target)"
        ]
      }'::jsonb
      WHERE id = 3 AND (withdrawal_patterns IS NULL OR withdrawal_patterns->>'queries' = '[]')
    `);

    // 41-C: Seed fw8 (modern slavery) withdrawal patterns
    await db.execute(sql`
      UPDATE frameworks SET withdrawal_patterns = '{
        "queries": [
          "\\"\{companyName\}\\" withdraws modern slavery statement OR discontinues supplier code",
          "\\"\{companyName\}\\" exits Ethical Trading Initiative OR leaves ETI"
        ],
        "documentRegex": [
          "(?:withdrew|discontinued) (?:the )?(?:modern slavery|human trafficking) statement",
          "(?:no longer) .{0,30}(?:supplier code|due diligence|human rights)"
        ]
      }'::jsonb
      WHERE id = 8 AND (withdrawal_patterns IS NULL OR withdrawal_patterns->>'queries' = '[]')
    `);

    // ─── Seed Default Settings for All Workspaces ──────────────────────
    await seedDefaultSettings();

    console.log("[DB] All tables created successfully");
  } catch (error) {
    console.error("[DB] Migration error:", error);
    throw error;
  }
}

/**
 * Seed default ensemble scoring settings and trusted sources for all workspaces.
 * Uses INSERT ... ON CONFLICT DO NOTHING so it's idempotent.
 */
async function seedDefaultSettings(): Promise<void> {
  // Get all workspace IDs
  const workspaces = await db.execute(sql`SELECT id FROM workspaces`);
  if (!workspaces.rows || workspaces.rows.length === 0) return;

  const defaultSettings: Record<string, string> = {
    ensemble_scoring: "true",
    ensemble_iterations: "3",
    pipeline_llm_1: "deepseek",
    pipeline_llm_2: "claude",
    pipeline_llm_3: "gemini",
    scoring_provider: "deepseek",
    use_bm25_retrieval: "true",
    terminology_discovery_enabled: "true",
    scoring_mode: "binary",
    search_depth: "20",
    discovery_query_variants: "3",
    auto_pin_sources: "true",
  };

  const defaultTrustedSources = [
    // Generic filing repositories (relevant to ALL frameworks)
    { name: "US SEC", domain: "sec.gov", description: "US SEC filings - 10-K, DEF14A, proxy statements" },
    { name: "UK Companies House", domain: "find-and-update.company-information.service.gov.uk", description: "UK annual reports and accounts" },
    // AI Governance & Technology
    { name: "NIST", domain: "nist.gov", description: "NIST AI Risk Management Framework and standards" },
    { name: "OECD AI", domain: "oecd.ai", description: "OECD AI Policy Observatory - principles, country policies, company commitments" },
    { name: "Partnership on AI", domain: "partnershiponai.org", description: "Multi-stakeholder AI governance research and guidelines" },
    { name: "Responsible AI Institute", domain: "responsibleai.org", description: "Responsible AI certifications and assessments" },
    { name: "Evident AI Index", domain: "evidentinsights.com", description: "AI maturity benchmarking for financial institutions" },
    { name: "World Economic Forum", domain: "weforum.org", description: "AI governance frameworks and corporate pledges" },
    { name: "EU AI Act", domain: "artificialintelligenceact.eu", description: "EU AI Act compliance and high-risk AI systems registry" },
    // Climate & Emissions
    { name: "CDP", domain: "cdp.net", description: "CDP climate, water, and forest disclosures" },
    { name: "SBTi", domain: "sciencebasedtargets.org", description: "Science-based emissions reduction targets" },
    { name: "TCFD Hub", domain: "tcfdhub.org", description: "TCFD-aligned climate disclosures" },
    { name: "UNEP FI", domain: "unepfi.org", description: "Net Zero Banking Alliance materials" },
    { name: "Banking on Climate Chaos", domain: "bankingonclimatechaos.org", description: "Banks' fossil fuel financing activities" },
    { name: "Coal Policy Tool", domain: "coalpolicytool.org", description: "Banks' coal financing policies" },
    { name: "Oil & Gas Policy Tracker", domain: "oilgaspolicytracker.org", description: "Banks' oil and gas financing policies" },
    { name: "Net Zero Asset Managers", domain: "netzeroassetmanagers.org", description: "Asset managers' net-zero progress" },
    // ESG & Sustainability (broad)
    { name: "GRI", domain: "globalreporting.org", description: "GRI sustainability reporting standards" },
    { name: "UN Global Compact", domain: "unglobalcompact.org", description: "UN Global Compact sustainability commitments" },
    { name: "PRI", domain: "unpri.org", description: "Principles for Responsible Investment signatory reports" },
    // Human Rights & Social
    { name: "Modern Slavery Registry", domain: "modernslaveryregistry.org", description: "UK Modern Slavery Act statements" },
    { name: "Business & Human Rights", domain: "business-humanrights.org", description: "Corporate human rights tracking" },
  ];

  for (const row of workspaces.rows as any[]) {
    const workspaceId = row.id;

    // Seed settings (only if not already set)
    for (const [key, value] of Object.entries(defaultSettings)) {
      await db.execute(sql`
        INSERT INTO workspace_settings (workspace_id, key, value)
        VALUES (${workspaceId}, ${key}, ${value})
        ON CONFLICT (workspace_id, key) DO NOTHING
      `);
    }

    // Seed trusted sources (only if workspace has none)
    const existingSources = await db.execute(
      sql`SELECT COUNT(*) as cnt FROM trusted_sources WHERE workspace_id = ${workspaceId}`
    );
    const count = parseInt((existingSources.rows[0] as any).cnt || "0");
    if (count === 0) {
      for (const source of defaultTrustedSources) {
        await db.execute(sql`
          INSERT INTO trusted_sources (workspace_id, name, domain, description, is_active)
          VALUES (${workspaceId}, ${source.name}, ${source.domain}, ${source.description}, true)
        `);
      }
      console.log(`[DB] Seeded ${defaultTrustedSources.length} trusted sources for workspace ${workspaceId}`);
    }
  }

  console.log("[DB] Default settings seeded for all workspaces");
}
