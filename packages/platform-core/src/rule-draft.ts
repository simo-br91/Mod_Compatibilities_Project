/**
 * Phase 10 — Rule DSL versioning, validation, and promotion workflow.
 *
 * Covers:
 *  - RuleDraftService: create drafts, validate them, bump versions, promote to verified rules
 *  - Rule validation: required fields, valid condition types, confidence range, non-empty conditions
 *  - Version history tracking per rule
 */

import { randomUUID } from "node:crypto";

import type {
  RuleDraftCondition,
  RuleDraftRecord,
  RuleDraftStatus,
  RuleVersionHistoryEntry,
  Reproducibility,
  Severity
} from "@modcompat/domain-models";
import { compareLooseVersions, now } from "./helpers.js";
import { InMemoryPlatformRepository } from "./repository.js";
import type { VerifiedRuleDefinition } from "./types.js";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreateRuleDraftInput {
  /** Provide an existing ruleId to create a new version of an existing rule. */
  ruleId?: string;
  title: string;
  findingType: string;
  severity: Severity;
  confidence: number;
  reproducibility: Reproducibility;
  summary: string;
  recommendedActions: string[];
  conditions: RuleDraftCondition[];
  createdBy: string;
}

export interface PromoteRuleDraftInput {
  draftId: string;
  promotedBy: string;
  changeNote?: string;
}

export class RuleValidationError extends Error {
  readonly code = "rule_validation_error" as const;
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`Rule validation failed: ${errors.join("; ")}`);
    this.name = "RuleValidationError";
    this.errors = errors;
  }
}

// ---------------------------------------------------------------------------
// RuleDraftService
// ---------------------------------------------------------------------------

const VALID_SEVERITIES: Severity[] = ["info", "low", "medium", "high", "critical"];
const VALID_REPRODUCIBILITIES: Reproducibility[] = [
  "confirmed",
  "likely",
  "intermittent",
  "not_tested"
];
const VALID_CONDITION_TYPES = [
  "project_present",
  "loader_is",
  "minecraft_version_is",
  "version_range"
];

export class RuleDraftService {
  constructor(private readonly repository: InMemoryPlatformRepository) {}

  /**
   * Create a new rule draft.
   * If `ruleId` is omitted a new stable rule ID is generated.
   * The version is automatically set to `latestVersion + 1` (or 1 for new rules).
   */
  createDraft(input: CreateRuleDraftInput): RuleDraftRecord {
    const ruleId = input.ruleId ?? `vr_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const version = this.nextVersionForRule(ruleId);

    const draftId = `rdr_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

    const draft: RuleDraftRecord = {
      schemaVersion: 1,
      draftId,
      ruleId,
      version,
      title: input.title,
      findingType: input.findingType,
      severity: input.severity,
      confidence: input.confidence,
      reproducibility: input.reproducibility,
      summary: input.summary,
      recommendedActions: input.recommendedActions,
      conditions: input.conditions,
      status: "draft",
      createdBy: input.createdBy,
      createdAt: now()
    };

    this.repository.ruleDrafts.set(draftId, draft);
    return draft;
  }

  /**
   * Validate a draft and update its status to "validated" or "rejected".
   * Returns the updated draft.
   * Throws `RuleValidationError` if strict mode is requested (default: false — only marks the draft).
   */
  validateDraft(draftId: string, strict = false): RuleDraftRecord {
    const draft = this.requireDraft(draftId);

    if (draft.status === "promoted") {
      throw new Error(`Draft ${draftId} is already promoted and cannot be re-validated.`);
    }

    const errors = this.collectValidationErrors(draft);
    const newStatus: RuleDraftStatus = errors.length === 0 ? "validated" : "rejected";

    const updated: RuleDraftRecord = {
      ...draft,
      status: newStatus,
      validationErrors: errors.length > 0 ? errors : undefined
    };
    this.repository.ruleDrafts.set(draftId, updated);

    if (strict && errors.length > 0) {
      throw new RuleValidationError(errors);
    }

    return updated;
  }

  /**
   * Promote a validated draft to a live VerifiedRuleDefinition.
   * Bumps the rule into the repository's verified rules list, records version history.
   * Throws if the draft is not in "validated" status.
   */
  promoteDraft(input: PromoteRuleDraftInput): {
    draft: RuleDraftRecord;
    rule: VerifiedRuleDefinition;
    historyEntry: RuleVersionHistoryEntry;
  } {
    const draft = this.requireDraft(input.draftId);

    if (draft.status !== "validated") {
      if (draft.status === "draft") {
        // Auto-validate before promotion
        const validated = this.validateDraft(input.draftId, true);
        return this.promoteDraft({ ...input, draftId: validated.draftId });
      }
      throw new Error(
        `Cannot promote draft ${input.draftId}: status is "${draft.status}", expected "validated".`
      );
    }

    // Build the VerifiedRuleDefinition to inject into the rule engine
    const rule: VerifiedRuleDefinition = {
      rule_id: draft.ruleId,
      version: draft.version,
      title: draft.title,
      finding_type: draft.findingType,
      severity: draft.severity,
      confidence: draft.confidence,
      reproducibility: draft.reproducibility,
      summary: draft.summary,
      recommended_actions: draft.recommendedActions,
      conditions: draft.conditions as VerifiedRuleDefinition["conditions"]
    };

    // Remove any older version of this rule from the live set, then add the new one
    const idx = this.repository.verifiedRules.findIndex((r) => r.rule_id === draft.ruleId);
    if (idx >= 0) {
      this.repository.verifiedRules.splice(idx, 1);
    }
    this.repository.verifiedRules.push(rule);

    // Record version history
    const historyEntry: RuleVersionHistoryEntry = {
      ruleId: draft.ruleId,
      version: draft.version,
      draftId: draft.draftId,
      promotedBy: input.promotedBy,
      promotedAt: now(),
      changeNote: input.changeNote
    };
    const history = this.repository.ruleVersionHistory.get(draft.ruleId) ?? [];
    history.push(historyEntry);
    this.repository.ruleVersionHistory.set(draft.ruleId, history);

    // Mark draft as promoted
    const promoted: RuleDraftRecord = {
      ...draft,
      status: "promoted",
      promotedAt: historyEntry.promotedAt
    };
    this.repository.ruleDrafts.set(input.draftId, promoted);

    return { draft: promoted, rule, historyEntry };
  }

  getDraft(draftId: string): RuleDraftRecord | undefined {
    return this.repository.ruleDrafts.get(draftId);
  }

  listDrafts(status?: RuleDraftStatus): RuleDraftRecord[] {
    const all = [...this.repository.ruleDrafts.values()];
    return (status ? all.filter((d) => d.status === status) : all)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRuleHistory(ruleId: string): RuleVersionHistoryEntry[] {
    return (this.repository.ruleVersionHistory.get(ruleId) ?? [])
      .slice()
      .sort((left, right) => left.version - right.version);
  }

  getActiveRule(ruleId: string): VerifiedRuleDefinition | undefined {
    return this.repository.verifiedRules.find((r) => r.rule_id === ruleId);
  }

  // ---------------------------------------------------------------------------
  // Validation helpers
  // ---------------------------------------------------------------------------

  private requireDraft(draftId: string): RuleDraftRecord {
    const draft = this.repository.ruleDrafts.get(draftId);
    if (!draft) throw new Error(`Rule draft not found: ${draftId}`);
    return draft;
  }

  private nextVersionForRule(ruleId: string): number {
    const versions: number[] = [];
    const existingHistory = this.repository.ruleVersionHistory.get(ruleId) ?? [];
    versions.push(...existingHistory.map((entry) => entry.version));

    const activeRule = this.repository.verifiedRules.find((rule) => rule.rule_id === ruleId);
    if (activeRule) {
      versions.push(activeRule.version);
    }

    for (const draft of this.repository.ruleDrafts.values()) {
      if (draft.ruleId === ruleId) {
        versions.push(draft.version);
      }
    }

    return versions.length > 0 ? Math.max(...versions) + 1 : 1;
  }

  private collectValidationErrors(draft: RuleDraftRecord): string[] {
    const errors: string[] = [];

    if (!draft.title.trim()) errors.push("title is required");
    if (!draft.findingType.trim()) errors.push("findingType is required");
    if (!draft.summary.trim()) errors.push("summary is required");
    if (draft.recommendedActions.length === 0)
      errors.push("at least one recommendedAction is required");
    if (draft.recommendedActions.some((action) => !action.trim()))
      errors.push("recommendedActions cannot contain blank entries");
    if (draft.conditions.length === 0) errors.push("at least one condition is required");

    if (draft.confidence < 0 || draft.confidence > 1)
      errors.push(`confidence must be in [0, 1] — got ${draft.confidence}`);

    if (!VALID_SEVERITIES.includes(draft.severity))
      errors.push(`invalid severity "${draft.severity}"`);

    if (!VALID_REPRODUCIBILITIES.includes(draft.reproducibility))
      errors.push(`invalid reproducibility "${draft.reproducibility}"`);

    for (const [i, condition] of draft.conditions.entries()) {
      if (!VALID_CONDITION_TYPES.includes(condition.type)) {
        errors.push(`condition[${i}]: unknown type "${condition.type}"`);
      }
      if (condition.type === "project_present" && !condition.project_id?.trim()) {
        errors.push(`condition[${i}]: project_present requires project_id`);
      }
      if (condition.type === "loader_is" && !condition.loader?.trim()) {
        errors.push(`condition[${i}]: loader_is requires loader`);
      }
      if (
        condition.type === "minecraft_version_is" &&
        !condition.minecraft_version?.trim()
      ) {
        errors.push(`condition[${i}]: minecraft_version_is requires minecraft_version`);
      }
      if (condition.type === "version_range") {
        if (!condition.project_id?.trim()) {
          errors.push(`condition[${i}]: version_range requires project_id`);
        }
        if (!condition.min_version?.trim() && !condition.max_version?.trim()) {
          errors.push(`condition[${i}]: version_range requires min_version or max_version`);
        }
        if (
          condition.min_version?.trim() &&
          condition.max_version?.trim() &&
          compareLooseVersions(condition.min_version, condition.max_version) > 0
        ) {
          errors.push(`condition[${i}]: version_range min_version must be <= max_version`);
        }
      }
    }

    return errors;
  }
}
