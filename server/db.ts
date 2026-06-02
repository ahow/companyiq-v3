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
 */
export async function initializeDatabase(): Promise<void> {
  console.log("[DB] Initializing database tables...");
  
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS workspaces (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        owner_id INTEGER NOT NULL REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS workspace_members (
        id SERIAL PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        role VARCHAR(50) DEFAULT 'member' NOT NULL,
        joined_at TIMESTAMP DEFAULT NOW() NOT NULL,
        UNIQUE(workspace_id, user_id)
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS frameworks (
        id SERIAL PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
        name VARCHAR(500) NOT NULL,
        description TEXT,
        topic_description TEXT,
        version INTEGER DEFAULT 1,
        is_active BOOLEAN DEFAULT false,
        trusted_sources JSONB DEFAULT '[]'::jsonb,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS framework_measures (
        id SERIAL PRIMARY KEY,
        framework_id INTEGER NOT NULL REFERENCES frameworks(id),
        category VARCHAR(255) NOT NULL,
        category_number INTEGER NOT NULL,
        title VARCHAR(500) NOT NULL,
        definition TEXT,
        scoring_guidance TEXT,
        evidence_keywords TEXT,
        display_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS company_lists (
        id SERIAL PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
        name VARCHAR(255) NOT NULL,
        description TEXT,
        company_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS companies (
        id SERIAL PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
        list_id INTEGER REFERENCES company_lists(id),
        name VARCHAR(500) NOT NULL,
        isin VARCHAR(50),
        sector VARCHAR(255),
        country VARCHAR(100),
        total_score REAL DEFAULT 0,
        measures_met_count INTEGER DEFAULT 0,
        measures_total_count INTEGER DEFAULT 0,
        analysis_status VARCHAR(50) DEFAULT 'pending',
        executive_summary TEXT,
        analyzed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS documents (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id),
        url TEXT NOT NULL,
        title VARCHAR(1000),
        doc_type VARCHAR(50),
        gate_status VARCHAR(50) DEFAULT 'pending',
        fetch_status VARCHAR(50) DEFAULT 'pending',
        content TEXT,
        relevance_score REAL,
        discovered_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS measure_scores (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id),
        framework_id INTEGER NOT NULL REFERENCES frameworks(id),
        measure_id INTEGER NOT NULL REFERENCES framework_measures(id),
        score VARCHAR(50) DEFAULT 'Not Met',
        confidence VARCHAR(50) DEFAULT 'Low',
        evidence TEXT,
        source_url TEXT,
        scored_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS batch_runs (
        id SERIAL PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
        framework_id INTEGER NOT NULL REFERENCES frameworks(id),
        list_id INTEGER REFERENCES company_lists(id),
        status VARCHAR(50) DEFAULT 'running',
        total_jobs INTEGER DEFAULT 0,
        completed_jobs INTEGER DEFAULT 0,
        failed_jobs INTEGER DEFAULT 0,
        started_at TIMESTAMP DEFAULT NOW() NOT NULL,
        completed_at TIMESTAMP
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS analysis_jobs (
        id SERIAL PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
        batch_id INTEGER NOT NULL REFERENCES batch_runs(id),
        company_id INTEGER NOT NULL REFERENCES companies(id),
        framework_id INTEGER NOT NULL REFERENCES frameworks(id),
        status VARCHAR(50) DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        error TEXT,
        started_at TIMESTAMP,
        completed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS analysis_results (
        id SERIAL PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
        batch_id INTEGER NOT NULL REFERENCES batch_runs(id),
        results_data JSONB,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS processing_errors (
        id SERIAL PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
        company_id INTEGER REFERENCES companies(id),
        error_type VARCHAR(100),
        message TEXT,
        stack TEXT,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS settings (
        id SERIAL PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
        key VARCHAR(255) NOT NULL,
        value TEXT,
        UNIQUE(workspace_id, key)
      )
    `);

    console.log("[DB] All tables created successfully");
  } catch (error) {
    console.error("[DB] Migration error:", error);
    throw error;
  }
}
