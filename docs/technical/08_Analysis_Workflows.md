# 08. Analysis Workflows

## High-level analysis pipeline
1. Accept pack input
2. Normalize mods and versions
3. Resolve hard dependencies and explicit incompatibilities
4. Enrich with catalog and graph context
5. Run static artifact analysis
6. Pull relevant evidence neighborhoods
7. Run heuristics and prediction models
8. Merge and deduplicate findings
9. Generate recommendations
10. Optionally run simulation
11. Re-score findings with simulation evidence
12. Materialize report and notify listeners

## Orchestration approach
Use a durable workflow engine such as Temporal.
Each major phase becomes an activity with retry and timeout policy.

## Suggested workflow states
- `queued`
- `normalizing`
- `resolving`
- `static_analyzing`
- `evidence_enriching`
- `heuristic_scoring`
- `recommending`
- `simulating`
- `finalizing`
- `completed`
- `failed`
- `cancelled`

## Pseudocode
```text
start analysis
  normalize pack
  resolve hard constraints
  if resolution impossible:
    emit hard findings
  analyze artifacts in parallel
  gather graph neighborhood
  retrieve supporting evidence
  run heuristics
  run ML scoring
  merge findings
  generate candidate recommendations
  if simulation enabled and budget allows:
    run smoke tests
    attach simulation outcomes
    update finding confidence
  persist report
  emit analysis.completed
end
```

## Candidate-pair generation
Avoid full O(n²) pairwise checks for large packs.

Use staged narrowing:
- only compare mods sharing subsystem clusters
- compare mods with overlapping class/mixin/resource targets
- compare mods close in graph neighborhoods
- compare mods implicated by evidence retrieval

## Re-analysis workflow
When a watched dependency changes:
1. detect affected canonical project/version
2. find impacted pack snapshots
3. enqueue incremental analyses
4. compute diff from previous analysis
5. send alerts only if severity/confidence crossed threshold

## Failure handling
### Soft failure
If one source connector is degraded, the analysis should still complete with degraded evidence coverage.

### Hard failure
If pack normalization fails or storage is unavailable, mark analysis as failed and preserve partial diagnostics.

## SLA tiers
### Fast
- no simulation
- lighter evidence retrieval
- intended for interactive iteration

### Standard
- default product mode
- complete rule, graph, and heuristic pass

### Deep
- wider evidence retrieval
- heavier candidate generation
- optional simulation
- best for release gating
