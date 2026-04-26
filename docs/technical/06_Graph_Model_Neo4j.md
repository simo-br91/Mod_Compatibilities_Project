# 06. Graph Model — Neo4j

Use the graph store for relationship-heavy reasoning, not as a replacement for the transactional database.

## Why graph storage is justified
The core product asks questions like:
- what other mods are indirectly connected to this one through shared targets?
- what evidence supports this finding?
- what are the strongest substitute candidates in the same ecosystem neighborhood?
- what paths explain why a pack is risky?

These are graph-native questions.

## Recommended node labels
- `Project`
- `Version`
- `Artifact`
- `Loader`
- `MinecraftVersion`
- `PackSnapshot`
- `Issue`
- `Discussion`
- `EvidenceSnippet`
- `CrashSignature`
- `MixinTarget`
- `ClassTarget`
- `ResourceTarget`
- `FunctionalCluster`
- `Recommendation`

## Recommended relationship types
- `DEPENDS_ON`
- `OPTIONALLY_DEPENDS_ON`
- `INCOMPATIBLE_WITH`
- `EMBEDS`
- `TARGETS_MIXIN`
- `TARGETS_CLASS`
- `TOUCHES_RESOURCE`
- `OBSERVED_IN`
- `MENTIONS`
- `SUGGESTS_REPLACEMENT`
- `SIMILAR_TO`
- `CAUSES_SIGNATURE`
- `REMEDIATED_BY`
- `BELONGS_TO_CLUSTER`

## Relationship properties
Every important edge should have room for:
- `confidence`
- `weight`
- `source_type`
- `source_id`
- `recency_score`
- `version_scope`
- `status` (active, disputed, superseded)

## Example node properties
### Project
- `project_id`
- `slug`
- `name`
- `functional_cluster`
- `client_side_support`
- `server_side_support`

### Version
- `version_id`
- `project_id`
- `version_label`
- `release_channel`
- `loaders`
- `minecraft_versions`

### EvidenceSnippet
- `evidence_id`
- `source_name`
- `source_url`
- `trust_score`
- `published_at`
- `extraction_confidence`

## Example Cypher patterns
### Find direct and indirect incompatibility neighborhood
```cypher
MATCH (p:Project {project_id: $projectId})-[:DEPENDS_ON|INCOMPATIBLE_WITH|TARGETS_CLASS|TARGETS_MIXIN*1..2]-(n)
RETURN DISTINCT n
LIMIT 200
```

### Find explanation path between two projects
```cypher
MATCH path = shortestPath(
  (a:Project {project_id: $projectA})-[*..5]-(b:Project {project_id: $projectB})
)
RETURN path
```

### Find replacement candidates with graph support
```cypher
MATCH (a:Project {project_id: $projectId})-[:BELONGS_TO_CLUSTER]->(c:FunctionalCluster)<-[:BELONGS_TO_CLUSTER]-(cand:Project)
WHERE cand.project_id <> a.project_id
RETURN cand
ORDER BY cand.maintenance_score DESC
LIMIT 20
```

## Materialized graph views
For performance, maintain precomputed graph summaries for:
- hot project neighborhoods
- top replacement candidates by cluster
- pack-specific active explanation subgraphs

## Governance rules
- graph is derived, not primary transactional truth
- every inferential edge needs provenance
- inferred edges should be retractable
- keep version-scoped edges separate from generic project-level edges
