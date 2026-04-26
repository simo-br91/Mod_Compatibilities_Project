# 07. Search and Indexing

Use OpenSearch for document retrieval, evidence search, and hybrid retrieval workflows.

## Index families
### Catalog indexes
- `catalog-projects`
- `catalog-versions`

### Evidence indexes
- `evidence-documents`
- `evidence-snippets`
- `crash-signatures`

### Analysis indexes
- `analysis-findings`
- `recommendations`

## Evidence document shape
```json
{
  "doc_id": "evd_001",
  "source_name": "github_issue",
  "source_project_ref": "owner/repo#123",
  "canonical_project_ids": ["prj_a", "prj_b"],
  "title": "Crash when used with X",
  "body": "...",
  "snippet": "...",
  "published_at": "2026-03-31T10:00:00Z",
  "trust_score": 0.82,
  "labels": ["bug", "compatibility"],
  "entities": {
    "mods": ["Mod A", "Mod B"],
    "loader": ["fabric"],
    "minecraft_versions": ["1.20.1"]
  },
  "embedding": [0.012, -0.022, 0.991]
}
```

## Retrieval patterns
### Lexical
For exact mod names, versions, error codes, and stack-trace fragments.

### Semantic
For messy community language such as:
- “these two optimization mods fight each other”
- “worldgen pack crashes during biome loading”

### Hybrid
Use both lexical and semantic retrieval, then rerank.

## Ranking features
- exact version match
- loader match
- Minecraft version match
- source trust
- recency
- semantic similarity
- project mapping confidence

## Operational notes
- keep large raw documents in object storage and index only what is needed
- store embeddings separately if vector scale grows significantly
- use analyzer tuning for code-like tokens, mod names, and version strings
