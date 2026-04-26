# Artifact Analysis

JAR inspection, loader metadata parsing, mixin extraction, binary fingerprints, and embedded-library detection live here.

Phase 8 now includes the first real JVM boundary for artifact analysis:

- `src/main/java/com/modcompat/artifactanalysis/ArtifactAnalysisBoundary.java` is a JVM process boundary that reads artifact-analysis requests from stdin and emits overlap/divergence results on stdout.
- `packages/platform-core` can opt into that boundary with `ARTIFACT_ANALYSIS_JAVA_SOURCE`.
- The TypeScript orchestrator still builds artifact records locally, but the overlap and embedded-library divergence analysis now runs inside the JVM process when the boundary is enabled.

This is the safer fork for the current repo state:

- it introduces a real cross-runtime boundary now
- it keeps the Phase 7/8 demo flow working without a broad async refactor through the orchestrator
- it leaves room for a later HTTP/RPC artifact-analysis service once the orchestration pipeline is ready for async service calls
