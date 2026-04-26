#!/usr/bin/env node
/**
 * Create system user in Postgres for pipeline
 */

import { Pool } from "pg";

async function createSystemUser() {
  if (!process.env.POSTGRES_URL) {
    console.error("❌ POSTGRES_URL not set");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.POSTGRES_URL });

  try {
    await pool.query(
      `INSERT INTO users (id, email, display_name, schema_version, created_at)
       VALUES ('usr_pipeline', 'pipeline@system.local', 'Offline Pipeline', 1, NOW())
       ON CONFLICT (id) DO NOTHING`
    );

    console.log("✅ System user created (or already exists)");
    process.exit(0);
  } catch (error) {
    console.error("❌ Failed to create user:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

createSystemUser();
