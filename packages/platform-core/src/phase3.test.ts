import assert from "node:assert/strict";
import test from "node:test";

import { createPhase1Platform } from "./index.js";

test("phase 3 evidence sync materializes raw payloads, documents, snippets, and search hits", () => {
  const platform = createPhase1Platform();
  const sync = platform.evidence.syncFixtures();

  assert.equal(sync.connectors.length, 2);
  assert.ok(sync.runs.every((run) => run.status === "completed"));
  assert.ok(sync.rawPayloads.length >= 4);
  assert.ok(sync.documents.length >= 4);
  assert.ok(sync.snippets.length >= 4);

  const search = platform.evidence.search({
    query: "optifine sodium fabric rendering conflict",
    projectIds: ["cp_optifine", "cp_sodium"],
    findingTypes: ["declared_incompatibility"],
    limit: 3
  });

  assert.ok(search.hits.length >= 1);
  assert.equal(search.hits[0]!.document.relatedProjectIds.includes("cp_optifine"), true);
});

test("phase 3 analysis findings are enriched with evidence and finding-linked retrieval works", () => {
  const platform = createPhase1Platform();
  const demo = platform.createDemoFlow();
  const evidenceRichFinding = demo.findings.find((finding) =>
    finding.evidence.some((evidence) => evidence.type === "evidence_document" || evidence.type === "evidence_snippet")
  );

  assert.ok(evidenceRichFinding);
  assert.ok(evidenceRichFinding!.provenance?.some((item) => item.kind === "evidence"));
  assert.ok(evidenceRichFinding!.confidenceInputs?.some((item) => item.source === "evidence"));

  const linkedEvidence = platform.evidence.getFindingEvidence(
    demo.analysis.analysisId,
    evidenceRichFinding!.findingId
  );

  assert.ok(linkedEvidence.hits.length >= 1);
});

test("phase 3 analyst curation can promote a verified rule and the rule becomes executable", () => {
  const platform = createPhase1Platform();
  platform.evidence.syncFixtures();

  const supportingDocs = [...platform.repository.evidenceDocuments.values()].filter((document) =>
    document.relatedProjectIds.includes("cp_optifine")
  );

  const curation = platform.evidence.createCuration({
    title: "Promote OptiFine and Sodium Fabric incompatibility",
    findingType: "community_verified_incompatibility",
    severity: "high",
    summary: "Curated evidence confirms the combination should be treated as incompatible for Fabric packs.",
    subjectProjectIds: ["cp_optifine", "cp_sodium"],
    evidenceDocumentIds: supportingDocs.slice(0, 2).map((document) => document.documentId),
    evidenceSnippetIds: [],
    createdBy: "usr_demo"
  });

  const promotion = platform.evidence.promoteVerifiedRule({
    curationId: curation.curationId,
    promotedBy: "usr_demo"
  });

  assert.equal(promotion.curation.status, "promoted");

  const result = platform.rules.evaluate({
    packSnapshotId: "snap_test",
    projectId: "prj_demo",
    organizationId: "org_demo",
    tenantId: "org_demo",
    sourceType: "mod_list",
    normalizedHash: "hash",
    environment: {
      minecraftVersion: "1.21.1",
      loader: "fabric",
      javaVersion: "21",
      side: "both"
    },
    mods: [
      {
        name: "optifine",
        canonicalProjectId: "cp_optifine",
        canonicalVersionId: "ver_optifine_120",
        resolutionMethod: "alias_match",
        confidence: 1
      },
      {
        name: "sodium",
        canonicalProjectId: "cp_sodium",
        canonicalVersionId: "ver_sodium_121",
        resolutionMethod: "slug_match",
        confidence: 1
      }
    ],
    schemaVersion: 1,
    createdAt: new Date().toISOString()
  });

  assert.ok(result.some((finding) => finding.type === "community_verified_incompatibility"));
});
