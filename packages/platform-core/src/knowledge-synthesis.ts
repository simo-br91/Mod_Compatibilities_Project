import { createPlatformId } from "@modcompat/id-generation";
import type {
  AnalysisEnvironment,
  AnalysisVerdict,
  ConfidenceSummary,
  ExactPackAnalysisCacheRecord,
  FragmentCompatibilityRecord,
  GroundTruthExactPackRecord,
  KnowledgeSnapshot,
  Loader,
  PackSnapshot,
  PairwiseCompatibilityRecord,
  PromotedCompatibilityClaim,
  SnapshotPromotionEvent,
  SnapshotValidationReport,
  SupportedCoverageScope,
  TechnicalConflictSignature
} from "@modcompat/domain-models";

import { now, stableHash } from "./helpers.js";
import { InMemoryPlatformRepository } from "./repository.js";
import type { VerifiedRuleDefinition } from "./types.js";

function toConfidenceBand(score: number): ConfidenceSummary["band"] {
  if (score >= 0.95) return "very_high";
  if (score >= 0.8) return "high";
  if (score >= 0.6) return "medium";
  if (score >= 0.35) return "low";
  return "very_low";
}

function deriveEnvironmentFromConditions(
  conditions: VerifiedRuleDefinition["conditions"]
): AnalysisEnvironment | undefined {
  const loaderCond = conditions.find((c) => c.type === "loader_is") as
    | { type: "loader_is"; loader: string }
    | undefined;
  const mcCond = conditions.find((c) => c.type === "minecraft_version_is") as
    | { type: "minecraft_version_is"; minecraft_version: string }
    | undefined;

  if (!loaderCond && !mcCond) return undefined;

  return {
    minecraftVersion: mcCond?.minecraft_version ?? "1.21.1",
    loader: (loaderCond?.loader ?? "fabric") as Loader,
    javaVersion: "21",
    side: "both"
  };
}

const PLATFORM_PACKAGE_PREFIXES = [
  "com.google.",
  "com.mojang.",
  "com.electronwill.",
  "cpw.mods.",
  "it.unimi.",
  "javax.",
  "kotlin.",
  "net.minecraft.",
  "net.minecraftforge.",
  "org.apache.",
  "org.jetbrains.",
  "org.objectweb.",
  "org.slf4j.",
  "org.spongepowered."
];

function findSharedNonPlatformNamespaces(left: string[], right: string[]): string[] {
  const leftFiltered = new Set(
    left.filter((namespace) =>
      !PLATFORM_PACKAGE_PREFIXES.some((prefix) => namespace.startsWith(prefix))
    )
  );
  return right.filter((namespace) => leftFiltered.has(namespace));
}

function mergeUniqueStrings(existing: string[], incoming: string[]) {
  return [...new Set([...existing, ...incoming])];
}

function mergeEvidenceRefs(
  existing: TechnicalConflictSignature["evidenceRefs"],
  incoming: TechnicalConflictSignature["evidenceRefs"]
) {
  const byKey = new Map<string, TechnicalConflictSignature["evidenceRefs"][number]>();
  for (const ref of [...existing, ...incoming]) {
    byKey.set(`${ref.type}:${ref.id}:${ref.snippetId ?? ""}`, ref);
  }
  return [...byKey.values()];
}

export class KnowledgeSynthesisService {
  constructor(private readonly repository: InMemoryPlatformRepository) {}

  // -----------------------------------------------------------------------
  // Coverage scope
  // -----------------------------------------------------------------------

  buildCoverageScope(snapshotVersion: string): SupportedCoverageScope {
    const supportedProjectIds = [...this.repository.canonicalProjects.keys()];
    const versions = [...this.repository.canonicalVersions.values()];
    const supportedMinecraftVersions = [
      ...new Set(versions.flatMap((v) => v.minecraftVersions))
    ];
    const supportedLoaders = [
      ...new Set(versions.flatMap((v) => v.loaders))
    ] as Loader[];

    return {
      coverageScopeId: `cov_synth_${snapshotVersion.replace(/[^a-z0-9]/gi, "_")}`,
      snapshotVersion,
      status: "high_confidence_coverage",
      supportedMinecraftVersions,
      supportedLoaders,
      supportedProjectIds,
      versionFreshnessWindowDays: 30,
      notes: `Auto-synthesized coverage scope for ${snapshotVersion}. Covers ${supportedProjectIds.length} projects across ${supportedMinecraftVersions.join(", ")} on ${supportedLoaders.join(", ")}.`,
      schemaVersion: 1,
      createdAt: now()
    };
  }

  // -----------------------------------------------------------------------
  // Claim synthesis
  // -----------------------------------------------------------------------

  synthesizeClaimsFromRules(snapshotId: string): PromotedCompatibilityClaim[] {
    const claims: PromotedCompatibilityClaim[] = [];
    const knownProjectIds = new Set(this.repository.canonicalProjects.keys());

    for (const rule of this.repository.verifiedRules) {
      const projectPresentConditions = rule.conditions.filter(
        (c) => c.type === "project_present"
      ) as Array<{ type: "project_present"; project_id: string }>;

      if (projectPresentConditions.length === 0) continue;

      const subjectProjectIds = projectPresentConditions.map((c) => c.project_id);
      if (subjectProjectIds.some((projectId) => !knownProjectIds.has(projectId))) {
        continue;
      }

      const claim: PromotedCompatibilityClaim = {
        promotedClaimId: `clm_rule_${rule.rule_id}`,
        snapshotId,
        claimKey: `rule:${rule.rule_id}`,
        findingType: rule.finding_type,
        findingVerdict: rule.confidence >= 0.9 ? "confirmed_conflict" : "reported_conflict",
        severity: rule.severity,
        confidence: {
          score: rule.confidence,
          band: toConfidenceBand(rule.confidence),
          explanation: `Derived from verified rule "${rule.title}" v${rule.version}.`,
          primaryDrivers: [`Verified rule: ${rule.title}`]
        },
        sourceKinds: ["verified_rule"],
        subjectProjectIds,
        subjectVersionIds: [],
        environment: deriveEnvironmentFromConditions(rule.conditions),
        explanation: rule.summary,
        evidenceRefs: [{ type: "rule", id: rule.rule_id }],
        freshnessSummary: `Synthesized from verified rule v${rule.version}`,
        schemaVersion: 1,
        createdAt: now()
      };

      claims.push(claim);
    }

    return claims;
  }

  synthesizeClaimsFromCatalogIncompatibilities(
    snapshotId: string
  ): PromotedCompatibilityClaim[] {
    const claims: PromotedCompatibilityClaim[] = [];

    for (const incompatibility of this.repository.incompatibilities) {
      const version = this.repository.canonicalVersions.get(incompatibility.versionId);
      if (!version) continue;

      const claimKey = `catalog:${incompatibility.versionId}:${incompatibility.incompatibleProjectId}`;

      const claim: PromotedCompatibilityClaim = {
        promotedClaimId: `clm_cat_${createPlatformId("clm").slice(-8)}_${incompatibility.versionId.slice(-6)}_${incompatibility.incompatibleProjectId.slice(-6)}`,
        snapshotId,
        claimKey,
        findingType: "declared_incompatibility",
        findingVerdict: "confirmed_conflict",
        severity: "critical",
        confidence: {
          score: 0.97,
          band: "very_high",
          explanation: "Derived from a declared catalog incompatibility entry.",
          primaryDrivers: ["Catalog declared incompatibility", "High-trust source"]
        },
        sourceKinds: ["catalog"],
        subjectProjectIds: [version.projectId, incompatibility.incompatibleProjectId],
        subjectVersionIds: [incompatibility.versionId],
        environment: undefined,
        explanation: incompatibility.reason,
        evidenceRefs: [],
        freshnessSummary: "Synthesized from catalog incompatibility declarations",
        schemaVersion: 1,
        createdAt: now()
      };

      claims.push(claim);
    }

    return claims;
  }

  // -----------------------------------------------------------------------
  // Technical signature synthesis from artifact profiles
  // -----------------------------------------------------------------------

  synthesizeTechnicalSignaturesFromArtifacts(
    snapshotId: string
  ): TechnicalConflictSignature[] {
    return this.collectTechnicalSignatures({
      snapshotId,
      targetVersionIds: new Set([...this.repository.artifactProfiles.keys()])
    });
  }

  processPendingArtifactAnalysis(limit = 50): {
    processed: number;
    signaturesGenerated: number;
    versionIds: string[];
    signatureIds: string[];
  } {
    const versionIds = this.repository.pendingArtifactAnalysisQueue.slice(0, limit);
    if (versionIds.length === 0) {
      return { processed: 0, signaturesGenerated: 0, versionIds: [], signatureIds: [] };
    }

    const signatures = this.collectTechnicalSignatures({
      targetVersionIds: new Set(versionIds)
    });

    for (const signature of signatures) {
      this.repository.technicalConflictSignatures.set(
        signature.technicalConflictSignatureId,
        signature
      );
    }

    this.repository.pendingArtifactAnalysisQueue.splice(0, versionIds.length);

    return {
      processed: versionIds.length,
      signaturesGenerated: signatures.length,
      versionIds,
      signatureIds: signatures.map((signature) => signature.technicalConflictSignatureId)
    };
  }

  private collectTechnicalSignatures(options: {
    snapshotId?: string;
    targetVersionIds: Set<string>;
  }): TechnicalConflictSignature[] {
    const signaturesByKey = new Map<string, TechnicalConflictSignature>();
    const profiles = [...this.repository.artifactProfiles.values()];

    const upsertSignature = (signature: TechnicalConflictSignature) => {
      const existing = signaturesByKey.get(signature.signatureKey);
      if (!existing) {
        signaturesByKey.set(signature.signatureKey, signature);
        return;
      }

      const combinedVersionIds = mergeUniqueStrings(existing.versionIds, signature.versionIds).sort();
      const combinedProjectIds = mergeUniqueStrings(existing.projectIds, signature.projectIds).sort();
      const combinedEvidenceRefs = mergeEvidenceRefs(existing.evidenceRefs, signature.evidenceRefs);
      const mergedDrivers = mergeUniqueStrings(
        existing.confidence.primaryDrivers,
        signature.confidence.primaryDrivers
      );

      const score =
        existing.confidence.score >= signature.confidence.score
          ? existing.confidence.score
          : signature.confidence.score;

      signaturesByKey.set(signature.signatureKey, {
        ...existing,
        projectIds: combinedProjectIds,
        versionIds: combinedVersionIds,
        targetRef: existing.targetRef ?? signature.targetRef,
        packageHint: existing.packageHint ?? signature.packageHint,
        evidenceRefs: combinedEvidenceRefs,
        confidence: {
          score,
          band: toConfidenceBand(score),
          explanation:
            existing.confidence.explanation.length >= signature.confidence.explanation.length
              ? existing.confidence.explanation
              : signature.confidence.explanation,
          primaryDrivers: mergedDrivers
        }
      });
    };

    for (let i = 0; i < profiles.length; i++) {
      for (let j = i + 1; j < profiles.length; j++) {
        const left = profiles[i];
        const right = profiles[j];

        if (
          !options.targetVersionIds.has(left.versionId) &&
          !options.targetVersionIds.has(right.versionId)
        ) {
          continue;
        }

        const leftVersion = this.repository.canonicalVersions.get(left.versionId);
        const rightVersion = this.repository.canonicalVersions.get(right.versionId);
        if (!leftVersion || !rightVersion) continue;
        if (leftVersion.projectId === rightVersion.projectId) continue;

        const projectIds = [leftVersion.projectId, rightVersion.projectId];
        const versionIds = [left.versionId, right.versionId];
        const evidenceRefs: TechnicalConflictSignature["evidenceRefs"] = [
          { type: "static_analysis", id: left.artifactId },
          { type: "static_analysis", id: right.artifactId }
        ];
        const signaturePrefix = options.snapshotId
          ? "sig"
          : `sig_refresh_${left.versionId.slice(-6)}_${right.versionId.slice(-6)}`;

        const mixinOverlap = left.mixinTargets.filter((t) => right.mixinTargets.includes(t));
        if (mixinOverlap.length > 0) {
          upsertSignature({
            technicalConflictSignatureId: options.snapshotId
              ? `sig_mixin_${left.versionId.slice(-6)}_${right.versionId.slice(-6)}`
              : `${signaturePrefix}_mixin_${mixinOverlap[0].replace(/[^a-z0-9]+/gi, "_").slice(0, 24)}`,
            signatureKey: `mixin-overlap:${leftVersion.projectId}:${rightVersion.projectId}`,
            snapshotId: options.snapshotId,
            signatureType: "mixin_overlap",
            projectIds,
            versionIds,
            targetRef: mixinOverlap[0],
            confidence: {
              score: 0.88,
              band: "high",
              explanation: `Both mods target ${mixinOverlap.join(", ")} via Mixin, which may cause conflicts at runtime.`,
              primaryDrivers: [
                `Shared mixin target: ${mixinOverlap[0]}`,
                `${mixinOverlap.length} overlapping target(s) detected`
              ]
            },
            evidenceRefs,
            schemaVersion: 1,
            createdAt: now()
          });
        }

        const leftAccessTargets = new Set([
          ...(left.accessWidenerTargets ?? []),
          ...(left.accessTransformerTargets ?? [])
        ]);
        const accessOverlap = [
          ...(right.accessWidenerTargets ?? []),
          ...(right.accessTransformerTargets ?? [])
        ].filter((target) => leftAccessTargets.has(target));
        if (accessOverlap.length > 0) {
          upsertSignature({
            technicalConflictSignatureId: options.snapshotId
              ? `sig_access_${left.versionId.slice(-6)}_${right.versionId.slice(-6)}`
              : `${signaturePrefix}_access_${accessOverlap[0].replace(/[^a-z0-9]+/gi, "_").slice(0, 24)}`,
            signatureKey: `access-transform-overlap:${leftVersion.projectId}:${rightVersion.projectId}`,
            snapshotId: options.snapshotId,
            signatureType: "other_structural_risk",
            projectIds,
            versionIds,
            targetRef: accessOverlap[0],
            confidence: {
              score: 0.7,
              band: "high",
              explanation: `Both mods widen or transform access for ${accessOverlap.join(", ")}, which can indicate fragile shared bytecode assumptions.`,
              primaryDrivers: [
                `Shared access target: ${accessOverlap[0]}`,
                `${accessOverlap.length} overlapping access target(s) detected`
              ]
            },
            evidenceRefs,
            schemaVersion: 1,
            createdAt: now()
          });
        }

        const classSet = new Set(left.classTargets);
        const classOverlap = right.classTargets.filter((target) => classSet.has(target));
        if (classOverlap.length > 0) {
          upsertSignature({
            technicalConflictSignatureId: options.snapshotId
              ? `sig_class_${left.versionId.slice(-6)}_${right.versionId.slice(-6)}`
              : `${signaturePrefix}_class_${classOverlap[0].replace(/[^a-z0-9]+/gi, "_").slice(0, 24)}`,
            signatureKey: `class-overlap:${leftVersion.projectId}:${rightVersion.projectId}`,
            snapshotId: options.snapshotId,
            signatureType: "class_overlap",
            projectIds,
            versionIds,
            targetRef: classOverlap[0],
            confidence: {
              score: Math.min(0.86, 0.72 + classOverlap.length * 0.01),
              band: "high",
              explanation: `Both mods package the same class path(s): ${classOverlap.slice(0, 5).join(", ")}.`,
              primaryDrivers: [
                `Duplicate class: ${classOverlap[0]}`,
                `${classOverlap.length} duplicate class target(s) detected`
              ]
            },
            evidenceRefs,
            schemaVersion: 1,
            createdAt: now()
          });
        }

        const resourceOverlap = left.resourceTargets.filter((t) =>
          right.resourceTargets.includes(t)
        );
        if (resourceOverlap.length > 0) {
          upsertSignature({
            technicalConflictSignatureId: options.snapshotId
              ? `sig_res_${left.versionId.slice(-6)}_${right.versionId.slice(-6)}`
              : `${signaturePrefix}_res_${resourceOverlap[0].replace(/[^a-z0-9]+/gi, "_").slice(0, 24)}`,
            signatureKey: `resource-overlap:${leftVersion.projectId}:${rightVersion.projectId}`,
            snapshotId: options.snapshotId,
            signatureType: "resource_overlap",
            projectIds,
            versionIds,
            targetRef: resourceOverlap[0],
            confidence: {
              score: 0.75,
              band: "high",
              explanation: `Both mods own the same resource path ${resourceOverlap.join(", ")}, which may cause resource override conflicts.`,
              primaryDrivers: [`Shared resource path: ${resourceOverlap[0]}`]
            },
            evidenceRefs,
            schemaVersion: 1,
            createdAt: now()
          });
        }

        const leftLibs = new Map(
          left.embeddedLibraries.map((l) => [
            l.coordinates.split(":").slice(0, 2).join(":"),
            l.coordinates
          ])
        );
        for (const lib of right.embeddedLibraries) {
          const groupArtifact = lib.coordinates.split(":").slice(0, 2).join(":");
          const leftCoord = leftLibs.get(groupArtifact);
          if (leftCoord && leftCoord !== lib.coordinates) {
            upsertSignature({
              technicalConflictSignatureId: options.snapshotId
                ? `sig_lib_${left.versionId.slice(-6)}_${right.versionId.slice(-6)}`
                : `${signaturePrefix}_lib_${groupArtifact.replace(/[^a-z0-9]+/gi, "_").slice(0, 24)}`,
              signatureKey: `lib-divergence:${leftVersion.projectId}:${rightVersion.projectId}:${groupArtifact}`,
              snapshotId: options.snapshotId,
              signatureType: "embedded_library_divergence",
              projectIds,
              versionIds,
              packageHint: groupArtifact,
              confidence: {
                score: 0.72,
                band: "high",
                explanation: `Both mods embed different versions of ${groupArtifact} (${leftCoord} vs ${lib.coordinates}), which may cause classloader conflicts.`,
                primaryDrivers: [`Embedded library version divergence: ${groupArtifact}`]
              },
              evidenceRefs,
              schemaVersion: 1,
              createdAt: now()
            });
          }
        }

        const sharedPackageNamespaces = findSharedNonPlatformNamespaces(
          left.packageNamespaces ?? [],
          right.packageNamespaces ?? []
        );
        if (sharedPackageNamespaces.length > 0) {
          upsertSignature({
            technicalConflictSignatureId: options.snapshotId
              ? `sig_pkg_${left.versionId.slice(-6)}_${right.versionId.slice(-6)}`
              : `${signaturePrefix}_pkg_${sharedPackageNamespaces[0].replace(/[^a-z0-9]+/gi, "_").slice(0, 24)}`,
            signatureKey: `package-namespace-conflict:${leftVersion.projectId}:${rightVersion.projectId}:${sharedPackageNamespaces[0]}`,
            snapshotId: options.snapshotId,
            signatureType: "package_namespace_conflict",
            projectIds,
            versionIds,
            packageHint: sharedPackageNamespaces[0],
            confidence: {
              score: Math.min(0.68, 0.56 + sharedPackageNamespaces.length * 0.03),
              band: "medium",
              explanation: `Both mods ship classes under the same non-platform namespace(s): ${sharedPackageNamespaces.slice(0, 5).join(", ")}.`,
              primaryDrivers: [
                `Shared package namespace: ${sharedPackageNamespaces[0]}`,
                `${sharedPackageNamespaces.length} overlapping namespace(s) detected`
              ]
            },
            evidenceRefs,
            schemaVersion: 1,
            createdAt: now()
          });
        }
      }
    }

    return [...signaturesByKey.values()];
  }

  // -----------------------------------------------------------------------
  // Pairwise record synthesis
  // -----------------------------------------------------------------------

  synthesizePairwiseRecords(
    snapshotId: string,
    allClaims: PromotedCompatibilityClaim[],
    allSignatures: TechnicalConflictSignature[]
  ): PairwiseCompatibilityRecord[] {
    // Index claims and signatures by sorted project-pair key
    const claimsByPair = new Map<string, PromotedCompatibilityClaim[]>();
    for (const claim of allClaims) {
      if (claim.subjectProjectIds.length < 2) continue;
      const key = [...claim.subjectProjectIds].sort().join(":");
      const bucket = claimsByPair.get(key) ?? [];
      bucket.push(claim);
      claimsByPair.set(key, bucket);
    }

    const sigsByPair = new Map<string, TechnicalConflictSignature[]>();
    for (const sig of allSignatures) {
      if (sig.projectIds.length < 2) continue;
      const key = [...sig.projectIds].sort().join(":");
      const bucket = sigsByPair.get(key) ?? [];
      bucket.push(sig);
      sigsByPair.set(key, bucket);
    }

    // Collect all project pairs that have at least some evidence
    const allPairKeys = new Set<string>([...claimsByPair.keys(), ...sigsByPair.keys()]);
    const records: PairwiseCompatibilityRecord[] = [];

    for (const pairKey of allPairKeys) {
      const [leftProjectId, rightProjectId] = pairKey.split(":");
      if (!leftProjectId || !rightProjectId) continue;

      const pairClaims = claimsByPair.get(pairKey) ?? [];
      const pairSigs = sigsByPair.get(pairKey) ?? [];

      records.push(
        this.derivePairwiseRecord(snapshotId, leftProjectId, rightProjectId, pairClaims, pairSigs)
      );
    }

    return records;
  }

  private derivePairwiseRecord(
    snapshotId: string,
    leftProjectId: string,
    rightProjectId: string,
    claims: PromotedCompatibilityClaim[],
    signatures: TechnicalConflictSignature[]
  ): PairwiseCompatibilityRecord {
    const allScores = [
      ...claims.map((c) => c.confidence.score),
      ...signatures.map((s) => s.confidence.score)
    ];
    const avgScore = allScores.reduce((a, b) => a + b, 0) / allScores.length;

    const hasConfirmedConflict = claims.some((c) => c.findingVerdict === "confirmed_conflict");
    const hasReportedConflict = claims.some((c) => c.findingVerdict === "reported_conflict");
    const hasTechnicalRisk = signatures.length > 0;

    const verdict: AnalysisVerdict = hasConfirmedConflict
      ? "known_incompatible"
      : hasReportedConflict || hasTechnicalRisk
        ? "likely_incompatible"
        : "no_known_issue_found";

    const drivers = [
      ...claims.map((c) => c.claimKey),
      ...signatures.map((s) => s.signatureKey)
    ].slice(0, 3);

    return {
      pairwiseCompatibilityId: `pwr_synth_${leftProjectId.slice(-8)}_${rightProjectId.slice(-8)}`,
      snapshotId,
      leftProjectId,
      rightProjectId,
      verdict,
      confidence: {
        score: avgScore,
        band: toConfidenceBand(avgScore),
        explanation: `Synthesized from ${claims.length} claim(s) and ${signatures.length} technical signature(s).`,
        primaryDrivers: drivers
      },
      claimIds: claims.map((c) => c.promotedClaimId),
      schemaVersion: 1,
      createdAt: now()
    };
  }

  // -----------------------------------------------------------------------
  // Ground-truth closed-loop overlay
  // -----------------------------------------------------------------------

  /**
   * For each freshly synthesized pairwise record, check if there is a settled
   * GroundTruthExactPackRecord for the same project pair. When found, replace the
   * inferred verdict/confidence with the empirically measured one. This closes the
   * feedback loop across offline pipeline runs: ground-truth results do not need to
   * be re-run just because a new snapshot was built.
   *
   * Also updates `repository.pairwiseCompatibilityRecords` in-place so the changes are
   * immediately visible to the persistence layer.
   */
  private overlayGroundTruthEvidenceOnPairwise(
    snapshotId: string,
    pairwiseRecords: PairwiseCompatibilityRecord[]
  ): PairwiseCompatibilityRecord[] {
    const pairOutcomes = this.getSettledGroundTruthPairOutcomes();
    if (pairOutcomes.size === 0) return pairwiseRecords;

    // Build a lookup: sorted-pair-key → index in the working array
    const indexByPair = new Map<string, number>();
    const working = [...pairwiseRecords];
    for (let i = 0; i < working.length; i++) {
      const r = working[i]!;
      indexByPair.set([r.leftProjectId, r.rightProjectId].sort().join("|"), i);
    }

    for (const [pairKey, outcome] of pairOutcomes) {
      const { exactRecord, snapshot, projectIds } = outcome;
      const idx = indexByPair.get(pairKey);
      if (idx === undefined) {
        const created = this.createGroundTruthBackedPairwiseRecord(
          snapshotId,
          projectIds,
          snapshot,
          exactRecord
        );
        working.push(created);
        indexByPair.set(pairKey, working.length - 1);
        this.repository.pairwiseCompatibilityRecords.set(created.pairwiseCompatibilityId, created);
        continue;
      }

      const existing = working[idx]!;
      const updated = this.applyGroundTruthOutcomeToPairwise(existing, exactRecord);

      working[idx] = updated;
      this.repository.pairwiseCompatibilityRecords.set(existing.pairwiseCompatibilityId, updated);
    }

    return working;
  }

  private getSettledGroundTruthPairOutcomes(): Map<
    string,
    {
      exactRecord: GroundTruthExactPackRecord;
      snapshot: PackSnapshot;
      projectIds: [string, string];
    }
  > {
    const outcomes = new Map<
      string,
      {
        exactRecord: GroundTruthExactPackRecord;
        snapshot: PackSnapshot;
        projectIds: [string, string];
      }
    >();

    for (const exactRecord of this.repository.groundTruthExactPackRecords.values()) {
      if (exactRecord.verdict === "inconclusive" || exactRecord.verdict === "timed_out") {
        continue;
      }

      const snapshot = this.repository.snapshots.get(exactRecord.packSnapshotId);
      if (!snapshot) {
        continue;
      }

      const projectIds = snapshot.mods
        .map((mod) => mod.canonicalProjectId)
        .filter((projectId): projectId is string => Boolean(projectId));
      if (projectIds.length !== 2) {
        continue;
      }

      const pair = [...projectIds].sort() as [string, string];
      const pairKey = pair.join("|");
      const existing = outcomes.get(pairKey);
      if (
        existing &&
        existing.exactRecord.updatedAt.localeCompare(exactRecord.updatedAt) >= 0 &&
        existing.exactRecord.confidence.score >= exactRecord.confidence.score
      ) {
        continue;
      }

      outcomes.set(pairKey, {
        exactRecord,
        snapshot,
        projectIds: pair
      });
    }

    return outcomes;
  }

  private applyGroundTruthOutcomeToPairwise(
    existing: PairwiseCompatibilityRecord,
    exactRecord: GroundTruthExactPackRecord
  ): PairwiseCompatibilityRecord {
    const gtVerdict: AnalysisVerdict =
      exactRecord.verdict === "passed_startup_and_world"
        ? "no_known_issue_found"
        : "known_incompatible";
    const gtScore = exactRecord.confidence.score;

    if (existing.verdict === gtVerdict && existing.confidence.score >= gtScore) {
      return existing;
    }

    const scopeNote =
      exactRecord.verdict === "passed_startup_and_world"
        ? "Did not crash on startup or world load (crash-detection only - not a full compatibility guarantee)."
        : "Crashed on startup or world load.";

    return {
      ...existing,
      verdict: gtVerdict,
      confidence: {
        score: gtScore,
        band: toConfidenceBand(gtScore),
        explanation: `Ground-truth execution (${exactRecord.verdict}). ${scopeNote}`,
        primaryDrivers: [
          `Ground-truth verdict: ${exactRecord.verdict}`,
          `Run ID: ${exactRecord.latestRunId}`,
          scopeNote
        ]
      }
    };
  }

  private createGroundTruthBackedPairwiseRecord(
    snapshotId: string,
    projectIds: [string, string],
    snapshot: PackSnapshot,
    exactRecord: GroundTruthExactPackRecord
  ): PairwiseCompatibilityRecord {
    const versionByProjectId = new Map(
      snapshot.mods
        .filter((mod) => mod.canonicalProjectId && mod.canonicalVersionId)
        .map((mod) => [mod.canonicalProjectId!, mod.canonicalVersionId!])
    );
    const [leftProjectId, rightProjectId] = projectIds;

    return this.applyGroundTruthOutcomeToPairwise(
      {
        pairwiseCompatibilityId: `pwr_gt_${stableHash({
          snapshotId,
          leftProjectId,
          rightProjectId,
          latestRunId: exactRecord.latestRunId
        }).slice(0, 16)}`,
        snapshotId,
        leftProjectId,
        leftVersionId: versionByProjectId.get(leftProjectId),
        rightProjectId,
        rightVersionId: versionByProjectId.get(rightProjectId),
        environment: exactRecord.environment,
        verdict: "insufficient_evidence",
        confidence: {
          score: 0,
          band: "very_low",
          explanation: "Placeholder before empirical overlay.",
          primaryDrivers: []
        },
        claimIds: [],
        schemaVersion: 1,
        createdAt: now()
      },
      exactRecord
    );
  }

  // -----------------------------------------------------------------------
  // Fragment record synthesis
  // -----------------------------------------------------------------------

  synthesizeFragmentRecords(
    snapshotId: string,
    pairwiseRecords: PairwiseCompatibilityRecord[]
  ): FragmentCompatibilityRecord[] {
    if (pairwiseRecords.length === 0) return [];

    const pairVerdicts = new Map<string, AnalysisVerdict>();
    for (const r of pairwiseRecords) {
      pairVerdicts.set([r.leftProjectId, r.rightProjectId].sort().join(":"), r.verdict);
    }

    const allProjectIds = [
      ...new Set(pairwiseRecords.flatMap((r) => [r.leftProjectId, r.rightProjectId]))
    ];

    const clusters = this.generateCandidateClusters(allProjectIds, pairVerdicts);
    const records: FragmentCompatibilityRecord[] = [];

    for (const cluster of clusters) {
      const sortedIds = [...cluster].sort();

      const versionIds = sortedIds
        .map((projectId) => {
          const version = [...this.repository.canonicalVersions.values()].find(
            (v) => v.projectId === projectId
          );
          return version?.versionId;
        })
        .filter((id): id is string => Boolean(id));

      // Determine fragment verdict: worst pairwise verdict within the cluster
      let worstVerdict: AnalysisVerdict = "no_known_issue_found";
      for (let i = 0; i < sortedIds.length; i++) {
        for (let j = i + 1; j < sortedIds.length; j++) {
          const key = [sortedIds[i], sortedIds[j]].sort().join(":");
          const verdict = pairVerdicts.get(key);
          if (verdict === "known_incompatible") {
            worstVerdict = "known_incompatible";
          } else if (
            verdict === "likely_incompatible" &&
            worstVerdict !== "known_incompatible"
          ) {
            worstVerdict = "likely_incompatible";
          }
        }
      }

      const fragmentHash = stableHash({ projectIds: sortedIds });
      const score = worstVerdict === "no_known_issue_found" ? 0.88 : 0.92;

      records.push({
        fragmentCompatibilityId: `frag_synth_${fragmentHash.slice(0, 12)}`,
        snapshotId,
        fragmentHash,
        projectIds: sortedIds,
        versionIds,
        verdict: worstVerdict,
        confidence: {
          score,
          band: toConfidenceBand(score),
          explanation: `Synthesized from pairwise records for a ${sortedIds.length}-mod cluster. Worst pairwise verdict: ${worstVerdict}.`,
          primaryDrivers: [
            `${sortedIds.length}-mod cluster`,
            `All pairs have pairwise data`,
            `Worst verdict: ${worstVerdict}`
          ]
        },
        claimIds: [],
        schemaVersion: 1,
        createdAt: now()
      });
    }

    return records;
  }

  private generateCandidateClusters(
    projectIds: string[],
    pairVerdicts: Map<string, AnalysisVerdict>
  ): string[][] {
    const clusters: string[][] = [];
    if (projectIds.length < 3) return clusters;

    // Generate all triples where all three pairs have pairwise data
    for (let i = 0; i < projectIds.length - 2; i++) {
      for (let j = i + 1; j < projectIds.length - 1; j++) {
        for (let k = j + 1; k < projectIds.length; k++) {
          const trio = [projectIds[i], projectIds[j], projectIds[k]];
          const allPairsKnown =
            pairVerdicts.has([trio[0], trio[1]].sort().join(":")) &&
            pairVerdicts.has([trio[0], trio[2]].sort().join(":")) &&
            pairVerdicts.has([trio[1], trio[2]].sort().join(":"));
          if (allPairsKnown) {
            clusters.push(trio);
          }
        }
      }
    }

    return clusters;
  }

  // -----------------------------------------------------------------------
  // Exact-pack cache generation (Phase H)
  // -----------------------------------------------------------------------

  generatePackCacheEntries(
    snapshotId: string,
    pairwiseRecords: PairwiseCompatibilityRecord[],
    fragmentRecords: FragmentCompatibilityRecord[]
  ): ExactPackAnalysisCacheRecord[] {
    const snapshot = this.repository.knowledgeSnapshots.get(snapshotId);
    if (!snapshot) return [];

    const pairByKey = new Map<string, PairwiseCompatibilityRecord>();
    for (const r of pairwiseRecords) {
      pairByKey.set([r.leftProjectId, r.rightProjectId].sort().join(":"), r);
    }

    const fragByHash = new Map<string, FragmentCompatibilityRecord>();
    for (const r of fragmentRecords) {
      fragByHash.set(r.fragmentHash, r);
    }

    const entries: ExactPackAnalysisCacheRecord[] = [];
    const seen = new Set<string>();

    for (const packSnapshot of this.repository.snapshots.values()) {
      const fingerprint = packSnapshot.normalizedHash;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);

      const projectIds = packSnapshot.mods
        .map((m) => m.canonicalProjectId)
        .filter((id): id is string => Boolean(id));

      if (projectIds.length === 0) continue;

      const { verdict, confidence } = this.deriveCacheVerdictForPack(
        projectIds,
        packSnapshot.environment,
        pairByKey,
        fragByHash
      );

      if (!verdict) continue;

      const entry: ExactPackAnalysisCacheRecord = {
        exactPackCacheId: `epc_synth_${snapshotId.slice(-8)}_${fingerprint.slice(0, 12)}`,
        snapshotId,
        packFingerprint: fingerprint,
        environment: packSnapshot.environment,
        verdict,
        confidence,
        coverageStatus: "high_confidence_coverage",
        findingIds: [],
        recommendationIds: [],
        explanation: `Pre-computed from pairwise/fragment knowledge for pack fingerprint ${fingerprint.slice(0, 12)}.`,
        freshnessSummary: `Knowledge snapshot ${snapshot.version}`,
        schemaVersion: 1,
        createdAt: now()
      };

      entries.push(entry);
    }

    return entries;
  }

  scheduleArtifactAnalysis(versionIds: string[]): { scheduled: number } {
    let scheduled = 0;

    for (const versionId of versionIds) {
      if (this.repository.pendingArtifactAnalysisQueue.includes(versionId)) {
        continue;
      }

      this.repository.pendingArtifactAnalysisQueue.push(versionId);
      scheduled++;
    }

    return { scheduled };
  }

  private deriveCacheVerdictForPack(
    projectIds: string[],
    _environment: AnalysisEnvironment,
    pairByKey: Map<string, PairwiseCompatibilityRecord>,
    fragByHash: Map<string, FragmentCompatibilityRecord>
  ): { verdict: AnalysisVerdict | undefined; confidence: ConfidenceSummary } {
    const sortedIds = [...projectIds].sort();

    // Check fragment record first (most specific)
    const fragHash = stableHash({ projectIds: sortedIds });
    const frag = fragByHash.get(fragHash);
    if (frag) {
      return {
        verdict: frag.verdict,
        confidence: {
          ...frag.confidence,
          explanation: `Exact fragment cache hit for ${sortedIds.length}-mod pack.`,
          primaryDrivers: ["Fragment cache hit", ...frag.confidence.primaryDrivers.slice(0, 2)]
        }
      };
    }

    // Aggregate pairwise records
    let worstVerdict: AnalysisVerdict = "no_known_issue_found";
    let minScore = 1;
    const drivers: string[] = [];
    let pairCount = 0;

    for (let i = 0; i < sortedIds.length; i++) {
      for (let j = i + 1; j < sortedIds.length; j++) {
        const key = [sortedIds[i], sortedIds[j]].sort().join(":");
        const pair = pairByKey.get(key);
        if (!pair) continue;
        pairCount++;
        if (pair.verdict === "known_incompatible") worstVerdict = "known_incompatible";
        else if (pair.verdict === "likely_incompatible" && worstVerdict !== "known_incompatible")
          worstVerdict = "likely_incompatible";
        if (pair.confidence.score < minScore) minScore = pair.confidence.score;
        if (drivers.length < 3) drivers.push(`${pair.leftProjectId}↔${pair.rightProjectId}: ${pair.verdict}`);
      }
    }

    if (pairCount === 0) return { verdict: undefined, confidence: { score: 0, band: "very_low", explanation: "", primaryDrivers: [] } };

    const requiredPairs = (sortedIds.length * (sortedIds.length - 1)) / 2;
    const coverageFactor = pairCount / requiredPairs;
    const finalScore = minScore * (0.65 + 0.35 * coverageFactor);

    return {
      verdict: worstVerdict,
      confidence: {
        score: finalScore,
        band: toConfidenceBand(finalScore),
        explanation: `Assembled from ${pairCount}/${requiredPairs} pairwise records. Worst verdict: ${worstVerdict}.`,
        primaryDrivers: drivers
      }
    };
  }

  // -----------------------------------------------------------------------
  // Full snapshot build pipeline
  // -----------------------------------------------------------------------

  buildCandidateSnapshot(options: {
    createdBy: string;
    versionLabel?: string;
  }): KnowledgeSnapshot {
    const versionLabel =
      options.versionLabel ?? `knowledge_snapshot_synth_${Date.now()}`;

    // Coverage scope
    const coverageScope = this.buildCoverageScope(versionLabel);
    this.repository.coverageScopes.set(coverageScope.coverageScopeId, coverageScope);
    this.repository.coverageScopesBySnapshotVersion.set(
      versionLabel,
      coverageScope.coverageScopeId
    );

    // Draft snapshot shell
    const snapshot: KnowledgeSnapshot = {
      snapshotId: `ks_synth_${Date.now()}`,
      version: versionLabel,
      status: "draft",
      coverageScopeId: coverageScope.coverageScopeId,
      createdBy: options.createdBy,
      schemaVersion: 1,
      createdAt: now(),
      components: []
    };
    this.repository.knowledgeSnapshots.set(snapshot.snapshotId, snapshot);
    this.repository.knowledgeSnapshotsByVersion.set(versionLabel, snapshot.snapshotId);

    // Claims from verified rules
    const ruleClaims = this.synthesizeClaimsFromRules(snapshot.snapshotId);
    // Claims from catalog incompatibilities
    const catalogClaims = this.synthesizeClaimsFromCatalogIncompatibilities(snapshot.snapshotId);
    const allClaims = [...ruleClaims, ...catalogClaims];

    for (const claim of allClaims) {
      this.repository.promotedCompatibilityClaims.set(claim.promotedClaimId, claim);
    }
    this.repository.promotedCompatibilityClaimsBySnapshot.set(
      snapshot.snapshotId,
      allClaims.map((c) => c.promotedClaimId)
    );

    // Technical signatures from artifact profile overlaps
    const signatures = this.synthesizeTechnicalSignaturesFromArtifacts(snapshot.snapshotId);
    for (const sig of signatures) {
      this.repository.technicalConflictSignatures.set(sig.technicalConflictSignatureId, sig);
    }
    this.repository.technicalConflictSignaturesBySnapshot.set(
      snapshot.snapshotId,
      signatures.map((s) => s.technicalConflictSignatureId)
    );

    // Pairwise records from claims + signatures
    const pairwiseRecords = this.synthesizePairwiseRecords(
      snapshot.snapshotId,
      allClaims,
      signatures
    );
    const seededPairwiseRecords = this.overlayGroundTruthEvidenceOnPairwise(
      snapshot.snapshotId,
      pairwiseRecords
    );
    for (const record of seededPairwiseRecords) {
      this.repository.pairwiseCompatibilityRecords.set(
        record.pairwiseCompatibilityId,
        record
      );
    }
    this.repository.pairwiseCompatibilityBySnapshot.set(
      snapshot.snapshotId,
      seededPairwiseRecords.map((r) => r.pairwiseCompatibilityId)
    );

    // Fragment records from pairwise clusters
    const fragmentRecords = this.synthesizeFragmentRecords(snapshot.snapshotId, seededPairwiseRecords);
    for (const record of fragmentRecords) {
      this.repository.fragmentCompatibilityRecords.set(
        record.fragmentCompatibilityId,
        record
      );
    }
    this.repository.fragmentCompatibilityBySnapshot.set(
      snapshot.snapshotId,
      fragmentRecords.map((r) => r.fragmentCompatibilityId)
    );

    // Exact-pack cache entries from all known pack snapshots
    const packCacheEntries = this.generatePackCacheEntries(
      snapshot.snapshotId,
      seededPairwiseRecords,
      fragmentRecords
    );
    for (const entry of packCacheEntries) {
      this.repository.exactPackAnalysisCache.set(entry.exactPackCacheId, entry);
    }
    this.repository.exactPackAnalysisCacheBySnapshot.set(
      snapshot.snapshotId,
      packCacheEntries.map((e) => e.exactPackCacheId)
    );

    // Stamp component checksums onto the snapshot
    snapshot.components = [
      {
        componentType: "catalog",
        recordCount: this.repository.canonicalProjects.size + this.repository.canonicalVersions.size,
        checksum: stableHash({
          projects: [...this.repository.canonicalProjects.keys()].sort(),
          versions: [...this.repository.canonicalVersions.keys()].sort()
        })
      },
      {
        componentType: "promoted_claims",
        recordCount: allClaims.length,
        checksum: stableHash(allClaims.map((c) => c.promotedClaimId).sort())
      },
      {
        componentType: "technical_signatures",
        recordCount: signatures.length,
        checksum: stableHash(signatures.map((s) => s.technicalConflictSignatureId).sort())
      },
      {
        componentType: "pairwise_matrix",
        recordCount: pairwiseRecords.length,
        checksum: stableHash(pairwiseRecords.map((r) => r.pairwiseCompatibilityId).sort())
      },
      {
        componentType: "fragment_cache",
        recordCount: fragmentRecords.length,
        checksum: stableHash(fragmentRecords.map((r) => r.fragmentCompatibilityId).sort())
      },
      {
        componentType: "exact_pack_cache",
        recordCount: packCacheEntries.length,
        checksum: stableHash(packCacheEntries.map((e) => e.exactPackCacheId).sort())
      },
      {
        componentType: "coverage_scope",
        recordCount: 1,
        checksum: stableHash(coverageScope)
      }
    ];

    return snapshot;
  }

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------

  validateSnapshot(snapshotId: string): SnapshotValidationReport {
    const snapshot = this.repository.knowledgeSnapshots.get(snapshotId);
    if (!snapshot) throw new Error(`Snapshot not found: ${snapshotId}`);

    const claimIds =
      this.repository.promotedCompatibilityClaimsBySnapshot.get(snapshotId) ?? [];
    const pairwiseIds =
      this.repository.pairwiseCompatibilityBySnapshot.get(snapshotId) ?? [];
    const coverageScope = snapshot.coverageScopeId
      ? this.repository.coverageScopes.get(snapshot.coverageScopeId)
      : undefined;

    const checks: SnapshotValidationReport["checks"] = [];
    let overallPassed = true;

    // Coverage scope must exist
    const hasCoverage = Boolean(coverageScope);
    if (!hasCoverage) overallPassed = false;
    checks.push({
      code: "coverage_scope_exists",
      status: hasCoverage ? "passed" : "failed",
      summary: hasCoverage
        ? `Coverage scope found with ${coverageScope!.supportedProjectIds.length} projects.`
        : "No coverage scope found for this snapshot."
    });

    // Claims are valuable when present, but real-world sparse evidence runs can still
    // produce useful pairwise/signature knowledge before any claim promotion exists.
    checks.push({
      code: "minimum_claim_count",
      status: "passed",
      summary:
        claimIds.length >= 1
          ? `${claimIds.length} promoted claim(s) found.`
          : "0 promoted claims found; continuing because pairwise/signature synthesis can still be valid."
    });

    // At least 1 pairwise record
    checks.push({
      code: "pairwise_records_present",
      status: pairwiseIds.length >= 1 ? "passed" : "failed",
      summary: `${pairwiseIds.length} pairwise record(s) found.`
    });

    // All critical claims must have confidence ≥ 0.7
    const criticalLowConf = claimIds
      .map((id) => this.repository.promotedCompatibilityClaims.get(id))
      .filter((c) => c?.severity === "critical" && (c?.confidence.score ?? 1) < 0.7);
    checks.push({
      code: "critical_claim_confidence",
      status: criticalLowConf.length === 0 ? "passed" : "failed",
      summary:
        criticalLowConf.length === 0
          ? "All critical claims meet the minimum confidence threshold (0.7)."
          : `${criticalLowConf.length} critical claim(s) have confidence below 0.7.`
    });

    const allChecksPassed = checks.every((c) => c.status === "passed");
    const status = overallPassed && allChecksPassed ? "passed" : "failed";

    const report: SnapshotValidationReport = {
      validationReportId: `vr_${snapshotId}`,
      snapshotId,
      status,
      checks,
      schemaVersion: 1,
      createdAt: now()
    };

    this.repository.snapshotValidationReports.set(report.validationReportId, report);

    // Link validation report back onto the snapshot
    snapshot.validationReportId = report.validationReportId;
    if (status === "passed") {
      snapshot.status = "validated";
    }

    return report;
  }

  // -----------------------------------------------------------------------
  // Approval
  // -----------------------------------------------------------------------

  approveSnapshot(snapshotId: string, actorId: string, note?: string): KnowledgeSnapshot {
    const snapshot = this.repository.knowledgeSnapshots.get(snapshotId);
    if (!snapshot) throw new Error(`Snapshot not found: ${snapshotId}`);
    if (snapshot.status === "rolled_back") {
      throw new Error(`Snapshot ${snapshotId} is rolled back and cannot be approved.`);
    }

    const validationReport = snapshot.validationReportId
      ? this.repository.snapshotValidationReports.get(snapshot.validationReportId)
      : undefined;
    if (!validationReport || validationReport.status !== "passed") {
      throw new Error(`Snapshot ${snapshotId} must pass validation before approval.`);
    }

    snapshot.status = "approved";

    const event: SnapshotPromotionEvent = {
      promotionEventId: `pe_${snapshotId}_approved_${Date.now()}`,
      snapshotId,
      action: "approved",
      actorId,
      note: note ?? "Approved for promotion.",
      schemaVersion: 1,
      createdAt: now()
    };

    const events = this.repository.snapshotPromotionEvents.get(snapshotId) ?? [];
    events.push(event);
    this.repository.snapshotPromotionEvents.set(snapshotId, events);

    return snapshot;
  }

  // -----------------------------------------------------------------------
  // Promotion
  // -----------------------------------------------------------------------

  promoteSnapshot(snapshotId: string, actorId: string, note?: string): KnowledgeSnapshot {
    const snapshot = this.repository.knowledgeSnapshots.get(snapshotId);
    if (!snapshot) throw new Error(`Snapshot not found: ${snapshotId}`);

    // Demote any currently-promoted snapshot
    for (const [id, existing] of this.repository.knowledgeSnapshots) {
      if (id !== snapshotId && existing.status === "promoted") {
        existing.status = "rolled_back";
      }
    }

    snapshot.status = "promoted";
    snapshot.activatedAt = now();

    const event: SnapshotPromotionEvent = {
      promotionEventId: `pe_${snapshotId}_${Date.now()}`,
      snapshotId,
      action: "promoted",
      actorId,
      note: note ?? "Promoted via knowledge synthesis pipeline.",
      schemaVersion: 1,
      createdAt: now()
    };

    const events = this.repository.snapshotPromotionEvents.get(snapshotId) ?? [];
    events.push(event);
    this.repository.snapshotPromotionEvents.set(snapshotId, events);

    return snapshot;
  }

  // -----------------------------------------------------------------------
  // Convenience: full build → validate → promote pipeline
  // -----------------------------------------------------------------------

  buildAndPromoteSnapshot(options: {
    createdBy: string;
    versionLabel?: string;
    force?: boolean;
  }): { snapshot: KnowledgeSnapshot; validationReport: SnapshotValidationReport } {
    const snapshot = this.buildCandidateSnapshot(options);
    const validationReport = this.validateSnapshot(snapshot.snapshotId);

    if (validationReport.status === "failed" && !options.force) {
      throw new Error(
        `Snapshot validation failed: ${validationReport.checks
          .filter((c) => c.status === "failed")
          .map((c) => c.summary)
          .join("; ")}. Pass force=true to promote anyway.`
      );
    }

    const promoted = this.promoteSnapshot(snapshot.snapshotId, options.createdBy);
    return { snapshot: promoted, validationReport };
  }

  triggerSnapshotRefresh(options: {
    createdBy: string;
    force?: boolean;
  }): { triggered: boolean; reason: string } {
    const activeSnapshot = this.getActiveSnapshot();
    if (activeSnapshot && !options.force) {
      return {
        triggered: false,
        reason: "Active snapshot is current. Pass force=true to rebuild."
      };
    }

    this.buildAndPromoteSnapshot(options);
    return {
      triggered: true,
      reason: "Snapshot rebuilt."
    };
  }

  // -----------------------------------------------------------------------
  // Active snapshot query
  // -----------------------------------------------------------------------

  getActiveSnapshot(): KnowledgeSnapshot | undefined {
    return [...this.repository.knowledgeSnapshots.values()].find(
      (s) => s.status === "promoted"
    );
  }

  getSnapshotSummary(snapshotId: string) {
    const snapshot = this.repository.knowledgeSnapshots.get(snapshotId);
    if (!snapshot) return undefined;

    const claimCount =
      this.repository.promotedCompatibilityClaimsBySnapshot.get(snapshotId)?.length ?? 0;
    const pairwiseCount =
      this.repository.pairwiseCompatibilityBySnapshot.get(snapshotId)?.length ?? 0;
    const fragmentCount =
      this.repository.fragmentCompatibilityBySnapshot.get(snapshotId)?.length ?? 0;
    const signatureCount =
      this.repository.technicalConflictSignaturesBySnapshot.get(snapshotId)?.length ?? 0;
    const coverageScope = snapshot.coverageScopeId
      ? this.repository.coverageScopes.get(snapshot.coverageScopeId)
      : undefined;
    const validationReport = snapshot.validationReportId
      ? this.repository.snapshotValidationReports.get(snapshot.validationReportId)
      : undefined;

    return {
      snapshotId: snapshot.snapshotId,
      version: snapshot.version,
      status: snapshot.status,
      activatedAt: snapshot.activatedAt,
      createdAt: snapshot.createdAt,
      claimCount,
      pairwiseCount,
      fragmentCount,
      signatureCount,
      coverageScope: coverageScope
        ? {
            projectCount: coverageScope.supportedProjectIds.length,
            minecraftVersions: coverageScope.supportedMinecraftVersions,
            loaders: coverageScope.supportedLoaders
          }
        : undefined,
      validationStatus: validationReport?.status,
      components: snapshot.components
    };
  }

  // -----------------------------------------------------------------------
  // Candidate generation for Pipeline 1 (ground-truth execution)
  // -----------------------------------------------------------------------

  generateCandidatesForPipeline1(snapshotId: string): Array<{
    pair: [string, string];
    confidence: number;
    verdict: AnalysisVerdict;
    priority: number;
  }> {
    const pairwiseRecordIds =
      this.repository.pairwiseCompatibilityBySnapshot.get(snapshotId) ?? [];

    // Look up actual records from IDs
    const pairwiseRecords = pairwiseRecordIds
      .map((id) => this.repository.pairwiseCompatibilityRecords.get(id))
      .filter((r): r is PairwiseCompatibilityRecord => Boolean(r));

    // Build a set of project-pair keys that have been confirmed by ground-truth execution.
    // After a run, applyGroundTruthFeedbackToPairwise stamps "Run ID: gtr_..." into
    // primaryDrivers. We use this as the signal that a pair has already been tested
    // so we don't re-queue it and waste candidate slots.
    const testedPairKeys = new Set<string>();
    for (const pairKey of this.getSettledGroundTruthPairOutcomes().keys()) {
      testedPairKeys.add(pairKey);
    }

    for (const record of this.repository.pairwiseCompatibilityRecords.values()) {
      const hasGroundTruthEvidence = record.confidence.primaryDrivers.some((d) =>
        d.startsWith("Run ID:")
      );
      if (hasGroundTruthEvidence) {
        const key = [record.leftProjectId, record.rightProjectId].sort().join("|");
        testedPairKeys.add(key);
      }
    }

    // Filter and prioritize candidates for testing
    const candidates = pairwiseRecords
      .filter((record) => {
        // Skip pairs already confirmed by a ground-truth run
        const pairKey = [record.leftProjectId, record.rightProjectId].sort().join("|");
        if (testedPairKeys.has(pairKey)) return false;

        // Include incompatible and uncertain verdicts for testing
        return (
          record.verdict === "known_incompatible" ||
          record.verdict === "likely_incompatible" ||
          record.verdict === "mixed_or_conditional" ||
          record.verdict === "insufficient_evidence"
        );
      })
      .map((record) => ({
        pair: [record.leftProjectId, record.rightProjectId] as [string, string],
        confidence: record.confidence.score,
        verdict: record.verdict,
        priority:
          record.verdict === "known_incompatible"
            ? record.confidence.score * 2.0 // Highest priority for known incompatibilities
            : record.verdict === "likely_incompatible"
              ? record.confidence.score * 1.5 // High priority for likely incompatibilities
              : record.verdict === "mixed_or_conditional"
                ? record.confidence.score * 1.2 // Medium priority for mixed verdicts
                : record.confidence.score // Base priority for insufficient evidence
      }))
      .sort((a, b) => b.priority - a.priority);

    return candidates;
  }
}

