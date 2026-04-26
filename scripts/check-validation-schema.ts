#!/usr/bin/env node
import { Pool } from "pg";

async function check() {
  if (!process.env.POSTGRES_URL) {
    console.error("POSTGRES_URL not set");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.POSTGRES_URL });

  try {
    const result = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'snapshot_validation_reports'
      ORDER BY ordinal_position
    `);

    console.log("snapshot_validation_reports columns:");
    result.rows.forEach((row) => {
      console.log(`  - ${row.column_name} (${row.data_type})`);
    });
  } catch (error) {
    console.error("Error:", error);
  } finally {
    await pool.end();
  }
}

check();
