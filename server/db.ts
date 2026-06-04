import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import * as schema from "../shared/schema.js";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
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
        content TEXT,
        fetched_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        UNIQUE(company_id, url)
      )
    `);

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
        display_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);

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

    // ─── Seed Default Settings for All Workspaces ──────────────────────────
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
    { name: "Banking on Climate Chaos", domain: "bankingonclimatechaos.org", description: "Banks' fossil fuel financing activities" },
    { name: "CDP", domain: "cdp.net", description: "CDP climate and environmental disclosures" },
    { name: "Coal Policy Tool", domain: "coalpolicytool.org", description: "Banks' coal financing policies" },
    { name: "GRI", domain: "globalreporting.org", description: "GRI sustainability reporting standards" },
    { name: "Net Zero Asset Managers", domain: "netzeroassetmanagers.org", description: "Asset managers' net-zero progress" },
    { name: "NIST", domain: "nist.gov", description: "NIST AI Risk Management Framework" },
    { name: "OECD", domain: "oecd.org", description: "OECD AI principles and policy observatory" },
    { name: "Oil & Gas Policy Tracker", domain: "oilgaspolicytracker.org", description: "Banks' oil and gas financing policies" },
    { name: "Partnership on AI", domain: "partnershiponai.org", description: "Partnership on AI research and guidelines" },
    { name: "Responsible AI Institute", domain: "responsibleai.org", description: "Responsible AI certifications" },
    { name: "SBTi", domain: "sciencebasedtargets.org", description: "Science-based emissions reduction targets" },
    { name: "US SEC", domain: "sec.gov", description: "US SEC filings - 10-K, DEF14A, proxy statements" },
    { name: "TCFD Hub", domain: "tcfdhub.org", description: "TCFD-related disclosures and guidance" },
    { name: "UNEP FI", domain: "unepfi.org", description: "Net Zero Banking Alliance materials" },
    { name: "UN Global Compact", domain: "unglobalcompact.org", description: "UN Global Compact sustainability reports" },
    { name: "Company Reports", domain: "company.com", description: "Company sustainability reports" },
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
