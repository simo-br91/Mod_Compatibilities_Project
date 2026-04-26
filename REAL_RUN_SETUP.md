# Real Run Setup Guide

This guide walks you through setting up the offline pipeline to run with real data.

## Prerequisites

✅ Local Postgres ready  
❌ GitHub API token (optional but recommended)

## Step 1: Configure Database

Set your Postgres connection string:

```bash
export POSTGRES_URL="postgresql://user:password@localhost:5432/modcompat"
```

Or on Windows PowerShell:
```powershell
$env:POSTGRES_URL = "postgresql://user:password@localhost:5432/modcompat"
```

Verify connection:
```bash
npx tsx -e "const {Pool} = await import('pg'); const p = new Pool({connectionString: process.env.POSTGRES_URL}); const r = await p.query('SELECT NOW()'); console.log('✅ Connected:', r.rows[0].now); process.exit(0);"
```

## Step 2: Set Up GitHub Token (Optional)

For higher rate limits on GitHub API searches:

1. Go to https://github.com/settings/tokens
2. Click "Generate new token (classic)"
3. Select scopes: `public_repo`, `read:repo_hook`
4. Copy the token and set:

```bash
export GITHUB_TOKEN="ghp_your_token_here"
```

Without a token, the pipeline will still work but may hit rate limits. It will fall back to fixture data automatically.

## Step 3: Load Real Catalog

Fetch 10 real Forge mods from Modrinth (6+ months old) and ingest them:

```bash
npx tsx scripts/load-real-catalog.ts
```

This will:
- Query Modrinth for popular Forge mods
- Filter to mods 6+ months old
- Ingest them with real download URLs
- Print a summary of loaded mods

Example output:
```
CATALOG LOAD COMPLETE
{
  "projects": 10,
  "versions": 10,
  "mods": [
    {
      "name": "Sophisticated Storage",
      "slug": "sophisticated-storage",
      "version": "1.0.0",
      "downloadUrl": "https://cdn.modrinth.com/..."
    },
    ...
  ]
}
```

## Step 4: Run Real Pipeline

Now run the offline pipeline with real data:

```bash
npx tsx scripts/offline-pipeline/run.ts
```

This will:
- **Step 1**: Ingest 10 real mods from catalog
- **Step 2**: Download & analyze JAR files (this will take time!)
  - Extracts mixins, classes, resources from each mod
  - Detects potential conflicts (overlapping mixin targets)
- **Step 3**: Fetch real GitHub issues (or use fixtures if unavailable)
- **Step 4**: Synthesize knowledge snapshot from all evidence
- **Step 5**: Generate test candidates
- **Step 6**: **Persist to Postgres** (real database!)
- **Step 7**: Complete

### What to Expect

- **Speed**: Slower than mock run (30 seconds - 2 minutes depending on network)
  - JAR downloads: 50-500 MB total
  - Analysis time: 1-2 seconds per mod
  - GitHub API calls: ~10 per mod

- **Output**: Real compatibility findings based on actual mod analysis

## Step 5: Verify Database

Check that data was persisted:

```bash
psql -h localhost -U user -d modcompat -c "
  SELECT 
    ks.snapshot_id, 
    COUNT(DISTINCT pc.claim_id) as claims,
    COUNT(DISTINCT pw.record_id) as pairwise_records
  FROM knowledge_snapshots ks
  LEFT JOIN promoted_compatibility_claims pc ON pc.snapshot_id = ks.snapshot_id
  LEFT JOIN pairwise_compatibility_records pw ON pw.snapshot_id = ks.snapshot_id
  GROUP BY ks.snapshot_id
  ORDER BY ks.created_at DESC
  LIMIT 1;
"
```

Should show non-zero claims and records.

## Troubleshooting

### "JAR download failed"
- Check network connectivity
- Verify download URLs are valid (they should be from Modrinth)
- Some mods may be archived/unavailable

### "GitHub rate limit exceeded"
- This is normal without a token
- The pipeline automatically falls back to fixtures
- Set `GITHUB_TOKEN` env var for 5000 requests/hour

### "Postgres connection refused"
- Verify Postgres is running
- Check POSTGRES_URL env var is set correctly
- Confirm database exists: `createdb modcompat`

### "No mods found from Modrinth"
- Network issue or Modrinth API down
- Try again or manually add mods to catalog

## Next Steps

Once the real run completes successfully:

1. **Inspect results**: Check the generated snapshot and candidates
2. **Tune mod selection**: Edit `scripts/load-real-catalog.ts` to load different mods
3. **Expand evidence sources**: Add real Reddit/Discord scraping (Phase D)
4. **Run Pipeline 1**: Use ground-truth testing on generated candidates
5. **Deploy**: Move to production with real Modrinth/CurseForge integrations (Phase C)
