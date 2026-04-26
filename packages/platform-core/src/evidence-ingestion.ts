import { InMemoryPlatformRepository } from "./repository.js";
import type { ArtifactProfileRecord, VerifiedRuleDefinition } from "./types.js";

export interface BulkEvidenceIngestPayload {
  rules?: VerifiedRuleDefinition[];
  artifactProfiles?: ArtifactProfileRecord[];
}

export interface BulkEvidenceIngestResult {
  rulesUpserted: number;
  artifactProfilesUpserted: number;
}

export class EvidenceIngestionService {
  constructor(private readonly repository: InMemoryPlatformRepository) {}

  ingestRuleDefinition(rule: VerifiedRuleDefinition): VerifiedRuleDefinition {
    const existingIndex = this.repository.verifiedRules.findIndex(
      (candidate) => candidate.rule_id === rule.rule_id
    );

    if (existingIndex === -1) {
      this.repository.verifiedRules.push(rule);
      return rule;
    }

    const existingRule = this.repository.verifiedRules[existingIndex];
    if (existingRule && existingRule.version < rule.version) {
      this.repository.verifiedRules[existingIndex] = rule;
      return rule;
    }

    return existingRule;
  }

  ingestArtifactProfile(profile: ArtifactProfileRecord): ArtifactProfileRecord {
    this.repository.artifactProfiles.set(profile.versionId, profile);
    return profile;
  }

  bulkIngestEvidence(payload: BulkEvidenceIngestPayload): BulkEvidenceIngestResult {
    let rulesUpserted = 0;
    let artifactProfilesUpserted = 0;

    for (const rule of payload.rules ?? []) {
      this.ingestRuleDefinition(rule);
      rulesUpserted++;
    }

    for (const profile of payload.artifactProfiles ?? []) {
      this.ingestArtifactProfile(profile);
      artifactProfilesUpserted++;
    }

    return { rulesUpserted, artifactProfilesUpserted };
  }
}
