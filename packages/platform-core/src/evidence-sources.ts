import type { VerifiedRuleDefinition } from "./types.js";
import type { InMemoryPlatformRepository } from "./repository.js";
import { stableHash } from "./helpers.js";
import type { EvidenceFetchCache } from "./evidence-fetch-cache.js";

/**
 * Evidence sources for compatibility analysis.
 *
 * ## Source priority (highest signal first)
 *   1. Author/project-owned text: Modrinth/CurseForge descriptions, changelogs, GitHub releases, READMEs
 *   2. Maintainer channels: GitHub issues, linked official wiki/docs
 *   3. Community reports: GitHub issue bodies, discussions
 *   4. Manually curated rules: high-precision, maintained in rules/ folder
 *   5. JAR artifact analysis: mixin/library/resource overlaps (jar-analysis.ts)
 *
 * ## Source registry
 *   Each source kind can be independently enabled/disabled via `EvidenceSourceConfig`.
 *   The `DEFAULT_SOURCE_CONFIG` enables all API-backed sources; web-scraping sources
 *   (linked_wiki, linked_homepage) are disabled by default to avoid scraping risk.
 *
 * ## Fetch state
 *   Pass an `EvidenceFetchCache` instance in `EvidenceIngestionOptions.fetchCache` to
 *   skip re-processing documents whose content hash has not changed since the last run.
 *   The cache is serialized/loaded by the pipeline runner; this module is cache-agnostic.
 *
 * ## Semantic extraction
 *   Claims are enriched with constraint fields (Minecraft version, loader, environment,
 *   fixedInVersion, requiresPatch, isDisputed, claimAuthorKind) when detectable in text.
 *   Conflicting claims for the same pair are resolved by trust-tier priority; the losing
 *   side is flagged isDisputed=true with a confidence penalty.
 */

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type EvidenceVerdict = "incompatible" | "compatible" | "uncertain";

export type EvidenceSourceKind =
  | "modrinth_description"
  | "modrinth_changelog"
  | "curseforge_description"
  | "curseforge_changelog"
  | "github_issue"
  | "github_release"    // GitHub release body / release notes (author-written)
  | "github_readme"     // GitHub README.md (author-written)
  | "github_wiki"       // GitHub wiki page (maintainer; disabled by default)
  | "linked_wiki"       // Official wiki/docs URL from project metadata (maintainer)
  | "linked_homepage";  // Official homepage from project metadata (author)

// ---------------------------------------------------------------------------
// Source registry and trust configuration
// ---------------------------------------------------------------------------

/**
 * Per-source enable/disable flags.  Pass a partial override via
 * `EvidenceIngestionOptions.sourceConfig` to turn sources on or off for a run.
 */
export interface EvidenceSourceConfig {
  modrinth_description: boolean;
  modrinth_changelog: boolean;
  curseforge_description: boolean;
  curseforge_changelog: boolean;
  github_issue: boolean;
  github_release: boolean;
  github_readme: boolean;
  /** Requires GitHub token and extra API calls — disabled by default. */
  github_wiki: boolean;
  /**
   * Fetches the `wiki_url` page from Modrinth project metadata as HTML.
   * Disabled by default: web scraping is fragile and may violate ToS.
   */
  linked_wiki: boolean;
  /**
   * Fetches the `issues_url` / homepage_url as HTML when no GitHub repo is found.
   * Disabled by default: low signal-to-noise ratio.
   */
  linked_homepage: boolean;
}

export const DEFAULT_SOURCE_CONFIG: EvidenceSourceConfig = {
  modrinth_description: true,
  modrinth_changelog: true,
  curseforge_description: true,
  curseforge_changelog: true,
  github_issue: true,
  github_release: true,
  github_readme: true,
  github_wiki: false,
  linked_wiki: false,
  linked_homepage: false
};

/**
 * Trust tier per source kind.  Used for conflict resolution: when two sources disagree
 * on a pair verdict, the higher-tier source wins.  Equal-tier ties are broken by confidence.
 * Fail-safe default: incompatible wins on a complete tie.
 *
 * Priority: author > maintainer > community > inferred
 */
export const SOURCE_TRUST_TIER: Record<
  EvidenceSourceKind,
  "author" | "maintainer" | "community" | "inferred"
> = {
  modrinth_description: "author",
  modrinth_changelog: "author",
  curseforge_description: "author",
  curseforge_changelog: "author",
  github_issue: "community",
  github_release: "author",
  github_readme: "author",
  github_wiki: "maintainer",
  linked_wiki: "maintainer",
  linked_homepage: "author"
};

// ---------------------------------------------------------------------------
// Structured evidence types
// ---------------------------------------------------------------------------

interface KnownProject {
  projectId: string;
  displayName: string;
  aliases?: string[];
}

/**
 * A pairwise compatibility claim extracted from a single evidence document.
 * All constraint fields are optional and populated only when detectable in text.
 */
export interface ExtractedCompatibilityClaim {
  sourceProjectId: string;
  targetProjectId: string;
  verdict: EvidenceVerdict;
  confidence: number;
  sourceKind: EvidenceSourceKind;
  evidenceTitle: string;
  sourceUrl?: string;
  snippet: string;
  matchedPattern: string;

  // --- Semantic constraint fields -------------------------------------------

  /** Minecraft version string if the claim is scoped to a specific version, e.g. "1.20.1". */
  minecraftVersionConstraint?: string;
  /** Mod loader if the claim is loader-specific, e.g. "forge", "fabric". */
  loaderConstraint?: string;
  /** Side constraint when only client or server is affected. */
  environmentConstraint?: "client" | "server" | "both";
  /** Version string if the incompatibility was fixed ("fixed in vX"). */
  fixedInVersion?: string;
  /** True when the text says a compatibility patch is required. */
  requiresPatch?: boolean;
  /**
   * True when this claim conflicts with a higher-trust claim for the same pair.
   * The confidence is also penalised by 30% in that case.
   */
  isDisputed?: boolean;
  /**
   * Who authored the claim text.
   * "author"      = mod author stated it in their own description/changelog
   * "maintainer"  = maintainer wrote it in a release note / wiki
   * "user"        = community member reported it in an issue/comment
   * "bot"         = automated CI/bot comment
   * "inferred"    = derived by pattern matching with no stated author
   */
  claimAuthorKind?: "author" | "maintainer" | "user" | "bot" | "inferred";

  // --- Provenance fields ----------------------------------------------------

  /** ISO-8601 timestamp when this document was fetched. */
  fetchedAt?: string;
  /** Stable hash of the raw document body — matches EvidenceFetchCache records. */
  contentHash?: string;
}

export interface GitHubEvidence {
  issueUrl: string;
  repository: string;
  title: string;
  body: string;
  labels: string[];
  createdAt: string;
  linkedProjects: string[];
  verdict?: EvidenceVerdict;
  confidence?: number;
  claims?: ExtractedCompatibilityClaim[];
}

export interface ModDescriptionEvidence {
  projectId: string;
  source: Exclude<EvidenceSourceKind, "github_issue">;
  title: string;
  content: string;
  linkedProjects: string[];
  verdict?: EvidenceVerdict;
  confidence?: number;
  claims?: ExtractedCompatibilityClaim[];
  sourceUrl?: string;
}

export interface EvidentSourcesResult {
  githubIssuesFound: number;
  githubIssuesProcessed: number;
  githubIssueSearchQueriesAttempted: number;
  githubIssueSearchQueriesSkipped: number;
  descriptionsFound: number;
  descriptionsProcessed: number;
  changelogsFound: number;
  changelogsProcessed: number;
  claimsExtracted: number;
  rulesGenerated: number;
  total: number;
  // New source counters
  githubReleasesFound: number;
  githubReadmesFound: number;
  linkedDocsFound: number;
  /** Number of documents skipped due to unchanged content hash (cache hits). */
  fetchCacheHits: number;
}

export interface EvidenceIngestionOptions {
  useFixtureFallback?: boolean;
  /** Per-source enable/disable overrides.  Defaults to DEFAULT_SOURCE_CONFIG. */
  sourceConfig?: Partial<EvidenceSourceConfig>;
  /**
   * When provided, documents whose content hash has not changed since the last
   * run are skipped.  The cache is mutated in-place (new entries recorded).
   */
  fetchCache?: EvidenceFetchCache;
}

export interface TextClaim {
  sentence: string;
  verdict: "incompatible" | "compatible";
  confidence: number;
  matchedPattern: string;
  // Semantic fields populated when detectable in the sentence
  minecraftVersionConstraint?: string;
  loaderConstraint?: string;
  environmentConstraint?: "client" | "server" | "both";
  fixedInVersion?: string;
  requiresPatch?: boolean;
}

export interface SourceDocument {
  sourceProjectId: string;
  sourceKind: EvidenceSourceKind;
  title: string;
  text: string;
  url?: string;
  /** Author kind override (e.g. "author" for mod-owned docs, "user" for issue comments). */
  claimAuthorKind?: ExtractedCompatibilityClaim["claimAuthorKind"];
  fetchedAt?: string;
  contentHash?: string;
}

interface ProjectMatch {
  projectId: string;
  canonicalName: string;
  matchedName: string;
}

// ---------------------------------------------------------------------------
// Extraction pattern constants
// ---------------------------------------------------------------------------

const SENTENCE_SPLIT = /(?<=[.!?])\s+|[\n\r]+|[;•]/;

const STRONG_INCOMPATIBILITY_PATTERNS: Array<[RegExp, string]> = [
  [/\bnot\s+compatible\s+with\b/i, "not_compatible_with"],
  [/\bincompatible\s+with\b/i, "incompatible_with"],
  [/\bconflicts?\s+with\b/i, "conflicts_with"],
  [/\bknown\s+(?:conflict|incompatibility)\s+(?:with|between)\b/i, "known_conflict"],
  [/\bcannot\s+(?:be\s+)?used\s+(?:together|with)\b/i, "cannot_be_used_with"],
  [/\b(?:does|do|did)n'?t\s+work\s+(?:with|alongside|together)\b/i, "does_not_work_with"],
  [/\bwon'?t\s+work\s+(?:with|alongside|together)\b/i, "wont_work_with"],
  [/\bbreaks?\s+(?:when\s+)?(?:used\s+)?with\b/i, "breaks_with"],
  [/\bcrash(?:es|ed|ing)?\s+(?:when\s+)?(?:used\s+)?with\b/i, "crashes_with"],
  [/\bavoid\s+(?:using|installing)\s+(?:it\s+)?with\b/i, "avoid_using_with"]
];

const CONDITIONAL_INCOMPATIBILITY_PATTERNS: Array<[RegExp, string]> = [
  [/\bmay\s+(?:conflict|crash|break)\s+with\b/i, "may_conflict_with"],
  [/\bcan\s+(?:conflict|crash|break)\s+with\b/i, "can_conflict_with"],
  [/\bcompatibility\s+(?:issue|problem)s?\s+with\b/i, "compatibility_issue_with"],
  [/\brequires?\s+(?:a\s+)?compat(?:ibility)?\s+patch\s+(?:for|with)\b/i, "requires_compat_patch"],
  [/\bpartially\s+compatible\s+with\b/i, "partially_compatible_with"],
  [/\bonly\s+compatible\s+with\b/i, "only_compatible_with"]
];

const STRONG_COMPATIBILITY_PATTERNS: Array<[RegExp, string]> = [
  [/\bfully\s+compatible\s+with\b/i, "fully_compatible_with"],
  [/\bsafe\s+to\s+use\s+(?:with|together|alongside)\b/i, "safe_to_use_with"],
  [/\bno\s+(?:known\s+)?conflicts?\s+(?:with|between)\b/i, "no_conflicts_with"],
  [/\bworks?\s+(?:great|well|fine|perfectly)\s+(?:with|alongside|together)\b/i, "works_well_with"],
  [/\bdesigned\s+to\s+(?:work\s+)?(?:with|alongside)\b/i, "designed_to_work_with"]
];

const COMPATIBILITY_PATTERNS: Array<[RegExp, string]> = [
  [/\bcompatible\s+with\b/i, "compatible_with"],
  [/\bworks?\s+(?:with|alongside|together)\b/i, "works_with"],
  [/\bsupports?\s+(?:using\s+)?(?:it\s+)?with\b/i, "supports_with"],
  [/\bno\s+issues?\s+(?:with|between)\b/i, "no_issues_with"]
];

// New semantic-constraint patterns -------------------------------------------

/**
 * "Fixed in version X" / "resolved since vX" — signals a past incompatibility that
 * may now be resolved.  Emits an incompatible claim with reduced confidence and
 * fixedInVersion set so downstream consumers can version-gate the verdict.
 */
const FIXED_IN_VERSION_PATTERNS: Array<[RegExp, string]> = [
  [/\bfixed?\s+in\s+(?:version\s+)?v?[\d.]+\b/i, "fixed_in_version"],
  [/\bresolved?\s+(?:in\s+|as\s+of\s+|since\s+)(?:version\s+)?v?[\d.]+\b/i, "resolved_in_version"],
  [/\bno\s+longer\s+(?:incompatible|crashes?|broken|conflicting)\s+(?:as\s+of|since|from)\s+v?[\d.]+\b/i, "no_longer_incompatible_since"]
];

/**
 * Loader-specific incompatibility/compatibility patterns.
 * e.g. "works on Fabric but crashes on Forge"
 */
const LOADER_SPECIFIC_PATTERNS: Array<[RegExp, string]> = [
  [/\bworks?\s+on\s+fabric\b.*\bbut\b.*\b(?:not|crashes?|broken)\b.*\b(?:on\s+)?forge\b/i, "fabric_ok_forge_broken"],
  [/\bworks?\s+on\s+forge\b.*\bbut\b.*\b(?:not|crashes?|broken)\b.*\b(?:on\s+)?fabric\b/i, "forge_ok_fabric_broken"],
  [/\bincompatible\s+(?:only\s+)?(?:on|with|for)\s+(?:forge|fabric|quilt|neoforge)\b/i, "loader_specific_incompatible"],
  [/\bonly\s+(?:works?|compatible)\s+(?:on|with|for)\s+(?:forge|fabric|quilt|neoforge)\b/i, "loader_only_compatible"]
];

/**
 * Environment / side constraint patterns.
 * e.g. "server-side only issue", "only affects the client"
 */
const ENV_SPECIFIC_PATTERNS: Array<[RegExp, string]> = [
  [/\bserver[\s-](?:side|only)\s*(?:issue|bug|conflict|crash|problem)\b/i, "server_side_only"],
  [/\bclient[\s-](?:side|only)\s*(?:issue|bug|conflict|crash|problem)\b/i, "client_side_only"],
  [/\bonly\s+(?:affects?|(?:occurs?|present)\s+on)\s+(?:the\s+)?server\b/i, "server_side_only"],
  [/\bonly\s+(?:affects?|(?:occurs?|present)\s+on)\s+(?:the\s+)?client\b/i, "client_side_only"]
];

// ---------------------------------------------------------------------------
// Per-source confidence weights
// ---------------------------------------------------------------------------

const SOURCE_CONFIDENCE: Record<EvidenceSourceKind, number> = {
  modrinth_description: 0.95,
  modrinth_changelog: 0.90,
  curseforge_description: 0.95,
  curseforge_changelog: 0.88,
  github_issue: 0.78,
  github_release: 0.88,   // author-written release notes
  github_readme: 0.85,    // author-written README (may lag behind releases)
  github_wiki: 0.82,      // maintainer-maintained wiki
  linked_wiki: 0.75,      // official docs (may be outdated)
  linked_homepage: 0.70   // homepage (lower signal density for compat claims)
};

// Trust tier numeric priority for conflict resolution (higher = wins)
const TRUST_TIER_PRIORITY: Record<string, number> = {
  author: 4,
  maintainer: 3,
  community: 2,
  inferred: 1
};

// ---------------------------------------------------------------------------
// Fetch limits
// ---------------------------------------------------------------------------

const MAX_MODRINTH_CHANGELOGS_PER_PROJECT = 8;
const MAX_CURSEFORGE_FILES_PER_PROJECT = 8;
const MAX_GITHUB_ISSUES_PER_QUERY = 8;
const MAX_GITHUB_RELEASES_PER_REPO = 8;
const GITHUB_SEARCH_QUERY_BUDGET_WITH_TOKEN = 4_500;
const GITHUB_SEARCH_QUERY_BUDGET_WITHOUT_TOKEN = 45;
const GITHUB_RELEASE_REQUEST_BUDGET_WITHOUT_TOKEN = 8;
const GITHUB_README_REQUEST_BUDGET_WITHOUT_TOKEN = 7;

// ---------------------------------------------------------------------------
// Semantic constraint extraction helpers
// ---------------------------------------------------------------------------

function matchFixedInVersion(sentence: string): string | undefined {
  const strip = (v: string) => v.replace(/\.+$/, "");

  const match = sentence.match(
    /(?:fixed?|resolved?)\s+in\s+(?:version\s+)?v?([\d.]+)/i
  );
  if (match) return strip(match[1]!);

  // "resolved as of vX", "no longer incompatible since X", etc.
  const asOfMatch = sentence.match(
    /(?:resolved?|fixed?)\b[^.]*?(?:as\s+of|since|from)\s+v?([\d.]+)/i
  );
  if (asOfMatch) return strip(asOfMatch[1]!);

  const noLongerMatch = sentence.match(
    /(?:as\s+of|since|from)\s+v?([\d.]+)/i
  );
  return noLongerMatch ? strip(noLongerMatch[1]!) : undefined;
}

function extractSemanticConstraints(sentence: string): {
  minecraftVersionConstraint?: string;
  loaderConstraint?: string;
  environmentConstraint?: "client" | "server" | "both";
  requiresPatch?: boolean;
} {
  const result: {
    minecraftVersionConstraint?: string;
    loaderConstraint?: string;
    environmentConstraint?: "client" | "server" | "both";
    requiresPatch?: boolean;
  } = {};

  // Minecraft version — look for patterns like "before 1.20.1", "since 1.19", "on 1.20"
  const mcMatch = sentence.match(
    /\b(?:before|since|after|on|for)\s+(?:mc\s*|minecraft\s+)?(?:version\s+)?(1\.\d+(?:\.\d+)?)\b/i
  );
  if (mcMatch) result.minecraftVersionConstraint = mcMatch[1];

  // Loader — Forge / Fabric / Quilt / NeoForge
  const loaderMatch = sentence.match(/\b(forge|fabric|quilt|neoforge)\b/i);
  if (loaderMatch) result.loaderConstraint = loaderMatch[1].toLowerCase();

  // Environment
  if (/\bserver[\s-](?:side|only)\b/i.test(sentence)) {
    result.environmentConstraint = "server";
  } else if (/\bclient[\s-](?:side|only)\b/i.test(sentence)) {
    result.environmentConstraint = "client";
  }

  // Requires compat patch
  if (/\brequires?\s+(?:a\s+)?compat(?:ibility)?\s+patch\b/i.test(sentence)) {
    result.requiresPatch = true;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Core extraction functions (public API)
// ---------------------------------------------------------------------------

/**
 * Split text into sentences and extract individual compatibility claims with confidence scores.
 * Each claim is anchored to the sentence it came from (provenance).
 *
 * New in this version: claims are enriched with semantic constraint fields
 * (loaderConstraint, environmentConstraint, fixedInVersion, requiresPatch,
 * minecraftVersionConstraint) when detectable from the sentence text.
 */
export function extractClaimsFromText(text: string): TextClaim[] {
  const claims: TextClaim[] = [];

  for (const sentence of splitEvidenceText(text)) {
    const semantics = extractSemanticConstraints(sentence);

    // ---- "fixed in version X" (historical incompatibility, may be resolved) ----
    const fixedIn = matchFixedInVersion(sentence);
    if (fixedIn) {
      const hasIncompatSignal =
        /\bcrash(?:es|ed|ing)?\b|\bincompatib(?:le|ility)\b|\bconflict\b|\bbroken?\b/i.test(sentence);
      if (hasIncompatSignal) {
        claims.push({
          sentence,
          verdict: "incompatible",
          // Reduced confidence: the incompatibility may already be resolved.
          confidence: 0.50,
          matchedPattern: matchFixedInVersionPattern(sentence),
          fixedInVersion: fixedIn,
          ...semantics
        });
        continue;
      }
    }

    // ---- Loader-specific patterns ----
    const loaderSpecific = firstPatternMatch(sentence, LOADER_SPECIFIC_PATTERNS);
    if (loaderSpecific) {
      const isIncompat =
        loaderSpecific === "fabric_ok_forge_broken" ||
        loaderSpecific === "forge_ok_fabric_broken" ||
        loaderSpecific === "loader_specific_incompatible";
      // Use explicit broken-loader rather than the first loader word in the sentence.
      let loaderConstraint = semantics.loaderConstraint;
      if (loaderSpecific === "fabric_ok_forge_broken") loaderConstraint = "forge";
      else if (loaderSpecific === "forge_ok_fabric_broken") loaderConstraint = "fabric";
      claims.push({
        sentence,
        verdict: isIncompat ? "incompatible" : "compatible",
        confidence: isIncompat ? 0.82 : 0.72,
        matchedPattern: loaderSpecific,
        ...semantics,
        loaderConstraint
      });
      continue;
    }

    // ---- Environment-specific patterns ----
    const envSpecific = firstPatternMatch(sentence, ENV_SPECIFIC_PATTERNS);
    if (envSpecific) {
      // Environment-specific issues are incompatibilities scoped to one side.
      const envConstraint: "client" | "server" =
        envSpecific === "client_side_only" ? "client" : "server";
      claims.push({
        sentence,
        verdict: "incompatible",
        confidence: 0.70,
        matchedPattern: envSpecific,
        environmentConstraint: envConstraint,
        ...semantics
      });
      continue;
    }

    // ---- Conditional incompatibility ----
    const conditional = firstPatternMatch(sentence, CONDITIONAL_INCOMPATIBILITY_PATTERNS);
    if (conditional) {
      claims.push({
        sentence,
        verdict: "incompatible",
        confidence: 0.68,
        matchedPattern: conditional,
        requiresPatch: semantics.requiresPatch,
        ...semantics
      });
      continue;
    }

    // ---- Strong incompatibility ----
    const incompatible = firstPatternMatch(sentence, STRONG_INCOMPATIBILITY_PATTERNS);
    if (incompatible) {
      claims.push({
        sentence,
        verdict: "incompatible",
        confidence: 0.90,
        matchedPattern: incompatible,
        ...semantics
      });
      continue;
    }

    // ---- Unresolved crash mention ----
    if (
      /\bcrash(?:es|ed|ing)?\b/i.test(sentence) &&
      !/\bfix(?:ed|es)?\b|\bresolved?\b/i.test(sentence)
    ) {
      claims.push({
        sentence,
        verdict: "incompatible",
        confidence: 0.62,
        matchedPattern: "unresolved_crash_mention",
        ...semantics
      });
      continue;
    }

    // ---- Strong compatibility ----
    const strongCompatible = firstPatternMatch(sentence, STRONG_COMPATIBILITY_PATTERNS);
    if (strongCompatible) {
      claims.push({
        sentence,
        verdict: "compatible",
        confidence: 0.88,
        matchedPattern: strongCompatible,
        ...semantics
      });
      continue;
    }

    // ---- Regular compatibility ----
    const compatible = firstPatternMatch(sentence, COMPATIBILITY_PATTERNS);
    if (compatible && !/\bnot\s+compatible\b|\bincompatible\b/i.test(sentence)) {
      claims.push({
        sentence,
        verdict: "compatible",
        confidence: 0.72,
        matchedPattern: compatible,
        ...semantics
      });
    }
  }

  return claims;
}

/**
 * Extract relation-level claims: a verdict is only emitted when the evidence sentence can be
 * attached to a target canonical project.  For source-owned documents, mentioning the target mod
 * is enough; for broad GitHub search results, the source mod plus target mod are both required.
 *
 * Claims are additionally enriched with semantic constraint fields and claimAuthorKind.
 */
export function extractCompatibilityClaimsFromText(
  document: SourceDocument,
  allProjects: KnownProject[]
): ExtractedCompatibilityClaim[] {
  const claims: ExtractedCompatibilityClaim[] = [];

  const claimAuthorKind = document.claimAuthorKind ?? inferClaimAuthorKind(document.sourceKind);

  for (const textClaim of extractClaimsFromText(document.text)) {
    const matchedProjects = findProjectMentions(textClaim.sentence, allProjects);
    const sourceMentioned = matchedProjects.some((p) => p.projectId === document.sourceProjectId);
    const targetMatches = matchedProjects.filter((p) => p.projectId !== document.sourceProjectId);

    if (document.sourceKind === "github_issue" && !sourceMentioned && targetMatches.length < 2) {
      continue;
    }

    for (const target of targetMatches) {
      claims.push({
        sourceProjectId: document.sourceProjectId,
        targetProjectId: target.projectId,
        verdict: textClaim.verdict,
        confidence: scoreClaimConfidence(textClaim, document.sourceKind, sourceMentioned),
        sourceKind: document.sourceKind,
        evidenceTitle: document.title,
        sourceUrl: document.url,
        snippet: textClaim.sentence,
        matchedPattern: textClaim.matchedPattern,
        // Semantic constraint fields
        minecraftVersionConstraint: textClaim.minecraftVersionConstraint,
        loaderConstraint: textClaim.loaderConstraint,
        environmentConstraint: textClaim.environmentConstraint,
        fixedInVersion: textClaim.fixedInVersion,
        requiresPatch: textClaim.requiresPatch,
        claimAuthorKind,
        fetchedAt: document.fetchedAt,
        contentHash: document.contentHash
      });
    }
  }

  return dedupeClaims(claims);
}

/**
 * Aggregate claims into a verdict + confidence + best supporting sentence.
 * Incompatible claims beat compatible when scores are equal (fail-safe default).
 */
export function analyzeTextEvidence(text: string): {
  verdict: EvidenceVerdict;
  confidence: number;
  supportingClaim?: string;
} {
  const claims = extractClaimsFromText(text);
  if (claims.length === 0) return { verdict: "uncertain", confidence: 0.5 };

  const incompatibleClaims = claims.filter((c) => c.verdict === "incompatible");
  const compatibleClaims = claims.filter((c) => c.verdict === "compatible");

  const incompatibleScore = incompatibleClaims.reduce((sum, c) => sum + c.confidence, 0);
  const compatibleScore = compatibleClaims.reduce((sum, c) => sum + c.confidence, 0);

  const SIGNAL_THRESHOLD = 0.58;

  if (incompatibleScore > compatibleScore && incompatibleScore >= SIGNAL_THRESHOLD) {
    const best = incompatibleClaims.reduce((a, b) => (a.confidence >= b.confidence ? a : b));
    return {
      verdict: "incompatible",
      confidence: Math.min(0.95, incompatibleScore / (incompatibleScore + compatibleScore + 0.1)),
      supportingClaim: best.sentence
    };
  }

  if (compatibleScore > incompatibleScore && compatibleScore >= SIGNAL_THRESHOLD) {
    const best = compatibleClaims.reduce((a, b) => (a.confidence >= b.confidence ? a : b));
    return {
      verdict: "compatible",
      confidence: Math.min(0.95, compatibleScore / (incompatibleScore + compatibleScore + 0.1)),
      supportingClaim: best.sentence
    };
  }

  return { verdict: "uncertain", confidence: 0.5 };
}

// ---------------------------------------------------------------------------
// Main service class
// ---------------------------------------------------------------------------

// Number of parallel workers for Modrinth API calls (generous rate limit).
const MODRINTH_CONCURRENCY = 10;
// Number of parallel workers for GitHub API calls (stricter rate limit, especially search).
const GITHUB_CONCURRENCY = 5;

export class EvidenceSourcesService {
  constructor(private readonly repository: InMemoryPlatformRepository) {}

  /** Cached result of GitHub repo discovery — populated once, reused across all GitHub methods. */
  private _repoCache: Map<string, string[]> | undefined;
  private _repoCachePromise: Promise<Map<string, string[]>> | undefined;
  private _curseForgeProjectIdCache = new Map<string, string | null>();
  private _lastGitHubIssueSearchStats = { attempted: 0, skipped: 0 };

  /**
   * Scan registry-owned descriptions and release notes for author-stated compatibility claims.
   * Covers Modrinth project bodies, Modrinth version changelogs, CurseForge descriptions,
   * and CurseForge file changelogs when a CurseForge API key and project IDs or resolvable
   * slug/name mappings are available.
   */
  async ingestModDescriptionEvidence(
    options?: EvidenceIngestionOptions
  ): Promise<ModDescriptionEvidence[]> {
    const config: EvidenceSourceConfig = {
      ...DEFAULT_SOURCE_CONFIG,
      ...(options?.sourceConfig ?? {})
    };
    const mods = [...this.repository.canonicalProjects.values()];
    const evidence: ModDescriptionEvidence[] = [];

    // Process mods concurrently — push is safe because JS is single-threaded
    // between awaits, so Array.push never races with itself.
    await runConcurrently(mods, MODRINTH_CONCURRENCY, async (mod) => {
      const mappings = [...this.repository.sourceMappings.values()].filter(
        (m) => m.canonicalProjectId === mod.projectId
      );
      const seenCurseForgeProjectIds = new Set<string>();
      for (const mapping of mappings) {
        if (
          mapping.sourceName === "modrinth" &&
          (config.modrinth_description || config.modrinth_changelog)
        ) {
          const docs = await this.ingestModrinthDocuments(
            mod.projectId, mapping.sourceProjectId, mods, options?.fetchCache
          );
          for (const doc of docs) evidence.push(doc);
        }

        if (
          (mapping.sourceName === "curseforge" || mapping.sourceName === "modrinth") &&
          (config.curseforge_description || config.curseforge_changelog)
        ) {
          const curseForgeProjectId = /^\d+$/.test(mapping.sourceProjectId)
            ? mapping.sourceProjectId
            : await this.resolveCurseForgeProjectId(mod, mapping.sourceProjectId);
          if (!curseForgeProjectId || seenCurseForgeProjectIds.has(curseForgeProjectId)) {
            continue;
          }
          seenCurseForgeProjectIds.add(curseForgeProjectId);
          const docs = await this.ingestCurseForgeDocuments(
            mod.projectId, curseForgeProjectId, mods, options?.fetchCache
          );
          for (const doc of docs) evidence.push(doc);
        }
      }
    });

    const deduped = dedupeDescriptionEvidence(evidence);
    if (deduped.length > 0 || options?.useFixtureFallback === false) {
      return deduped;
    }

    // Demo fixtures used when running against seeded catalog data without network/API access.
    return [
      {
        projectId: "cp_sodium",
        source: "modrinth_description",
        title: "Sodium - mod description",
        content: "This mod is not compatible with OptiFine. Use Iris Shaders instead for shader support.",
        linkedProjects: ["cp_sodium", "cp_optifine"],
        verdict: "incompatible",
        confidence: 0.9,
        claims: [
          {
            sourceProjectId: "cp_sodium",
            targetProjectId: "cp_optifine",
            verdict: "incompatible",
            confidence: 0.9,
            sourceKind: "modrinth_description",
            evidenceTitle: "Sodium - mod description",
            snippet: "This mod is not compatible with OptiFine.",
            matchedPattern: "not_compatible_with",
            claimAuthorKind: "author"
          }
        ]
      },
      {
        projectId: "cp_optifine",
        source: "modrinth_description",
        title: "OptiFine - mod description",
        content: "Known conflict with Sodium rendering engine. These two mods modify the same rendering systems.",
        linkedProjects: ["cp_optifine", "cp_sodium"],
        verdict: "incompatible",
        confidence: 0.9,
        claims: [
          {
            sourceProjectId: "cp_optifine",
            targetProjectId: "cp_sodium",
            verdict: "incompatible",
            confidence: 0.9,
            sourceKind: "modrinth_description",
            evidenceTitle: "OptiFine - mod description",
            snippet: "Known conflict with Sodium rendering engine.",
            matchedPattern: "known_conflict",
            claimAuthorKind: "author"
          }
        ]
      }
    ];
  }

  /**
   * Scan GitHub for mod incompatibility reports and discussions.
   * Repo-linked searches are preferred when registry metadata exposes source/issues URLs; broad
   * search remains as a fallback so popular mods without source mappings still contribute evidence.
   */
  async ingestGitHubEvidence(options?: EvidenceIngestionOptions): Promise<GitHubEvidence[]> {
    const githubToken = process.env.GITHUB_TOKEN;
    const mods = [...this.repository.canonicalProjects.values()];
    const evidence: GitHubEvidence[] = [];
    let remainingSearchQueries = githubSearchQueryBudget(githubToken);
    let attemptedSearchQueries = 0;
    let skippedSearchQueries = 0;
    // Repo cache is guaranteed to be populated by ingestFromAllSources pre-step,
    // but guard here too so the method works when called in isolation.
    const projectRepositories = await this.discoverProjectGitHubRepositories();

    await runConcurrently(mods, GITHUB_CONCURRENCY, async (mod) => {
      const repos = projectRepositories.get(mod.projectId) ?? [];

      // Strategy: prefer repo-specific searches — they are targeted, use less
      // GitHub search quota, and produce higher-quality results than broad
      // display-name searches. Fall back to a broad search only when no repo
      // is known (new mods, mods without source_url/issues_url on Modrinth).
      const queries: string[] = repos.length > 0
        ? repos.map((repo) => `repo:${repo} (incompatible OR compatibility OR conflict OR crash) is:issue`)
        : [`"${mod.displayName}" (incompatible OR compatibility OR conflict OR crash) is:issue`];

      for (let queryIndex = 0; queryIndex < queries.length; queryIndex++) {
        const query = queries[queryIndex]!;
        if (remainingSearchQueries <= 0) {
          skippedSearchQueries += queries.length - queryIndex;
          break;
        }
        remainingSearchQueries--;
        attemptedSearchQueries++;
        try {
          const data = await fetchGitHubIssues(query, githubToken);
          for (const issue of data.items) {
            const repository = issue.repository_url.replace("https://api.github.com/repos/", "");
            const text = `${issue.title}\n${issue.body ?? ""}\n${issue.labels.map((l) => l.name).join(" ")}`;
            const document: SourceDocument = {
              sourceProjectId: mod.projectId,
              sourceKind: "github_issue",
              title: issue.title,
              text,
              url: issue.html_url,
              claimAuthorKind: "user"
            };
            const claims = extractCompatibilityClaimsFromText(document, mods);
            const analysis = summarizeClaims(claims);
            evidence.push({
              issueUrl: issue.html_url,
              repository,
              title: issue.title,
              body: issue.body || "",
              labels: issue.labels.map((l) => l.name),
              createdAt: issue.created_at,
              linkedProjects: linkedProjectsFromClaims(mod.projectId, claims),
              verdict: analysis.verdict,
              confidence: analysis.confidence,
              claims
            });
          }
        } catch {
          // GitHub API unavailable or rate limited for this query — move on.
        }
      }
    });
    this._lastGitHubIssueSearchStats = {
      attempted: attemptedSearchQueries,
      skipped: skippedSearchQueries
    };

    const deduped = dedupeGitHubEvidence(evidence);
    if (deduped.length > 0) {
      return deduped;
    }

    if (options?.useFixtureFallback === false) {
      return [];
    }

    return [
      {
        issueUrl: "https://github.com/sp614x/optifine/issues/5891",
        repository: "sp614x/optifine",
        title: "OptiFine incompatible with Sodium - both modify rendering",
        body: "When using OptiFine with Sodium, the game crashes on world load. Root cause: both mods use mixins to modify ChunkRenderDispatcher and other rendering systems.",
        labels: ["incompatibility", "sodium", "rendering"],
        createdAt: "2023-08-15T10:30:00Z",
        linkedProjects: ["cp_optifine", "cp_sodium"],
        verdict: "incompatible",
        confidence: 0.86,
        claims: [
          {
            sourceProjectId: "cp_optifine",
            targetProjectId: "cp_sodium",
            verdict: "incompatible",
            confidence: 0.86,
            sourceKind: "github_issue",
            evidenceTitle: "OptiFine incompatible with Sodium - both modify rendering",
            sourceUrl: "https://github.com/sp614x/optifine/issues/5891",
            snippet: "When using OptiFine with Sodium, the game crashes on world load.",
            matchedPattern: "crashes_with",
            claimAuthorKind: "user"
          }
        ]
      },
      {
        issueUrl: "https://github.com/CaffeineMC/lithium-fabric/discussions/128",
        repository: "CaffeineMC/lithium-fabric",
        title: "Lithium + Sodium compatibility confirmed",
        body: "Extensive testing shows Lithium and Sodium work well together. Both optimize different systems without conflicts.",
        labels: ["compatibility", "sodium", "performance"],
        createdAt: "2023-06-20T14:22:00Z",
        linkedProjects: ["cp_lithium", "cp_sodium"],
        verdict: "compatible",
        confidence: 0.82,
        claims: [
          {
            sourceProjectId: "cp_lithium",
            targetProjectId: "cp_sodium",
            verdict: "compatible",
            confidence: 0.82,
            sourceKind: "github_issue",
            evidenceTitle: "Lithium + Sodium compatibility confirmed",
            sourceUrl: "https://github.com/CaffeineMC/lithium-fabric/discussions/128",
            snippet: "Extensive testing shows Lithium and Sodium work well together.",
            matchedPattern: "works_well_with",
            claimAuthorKind: "user"
          }
        ]
      }
    ];
  }

  /**
   * Fetch GitHub release bodies for discovered project repositories.
   * Release notes are author-written and have the same trust tier as changelogs.
   * Respects the fetch cache: releases whose body hash is unchanged are skipped.
   */
  async ingestGitHubReleaseEvidence(
    options?: EvidenceIngestionOptions
  ): Promise<ModDescriptionEvidence[]> {
    const githubToken = process.env.GITHUB_TOKEN;
    const mods = [...this.repository.canonicalProjects.values()];
    const evidence: ModDescriptionEvidence[] = [];
    const projectRepositories = await this.discoverProjectGitHubRepositories();
    const fetchCache = options?.fetchCache;
    let remainingRequests = githubRepositoryRequestBudget(
      githubToken,
      GITHUB_RELEASE_REQUEST_BUDGET_WITHOUT_TOKEN
    );

    for (const [projectId, repos] of projectRepositories) {
      for (const repo of repos) {
        if (remainingRequests <= 0) return dedupeDescriptionEvidence(evidence);
        remainingRequests--;
        try {
          const releases = await fetchGitHubReleases(repo, githubToken, MAX_GITHUB_RELEASES_PER_REPO);

          for (const release of releases) {
            if (!release.body) continue;

            const contentHash = stableHash({ repo, tag: release.tag_name, body: release.body }).slice(0, 16);

            if (fetchCache?.isUnchanged(release.html_url, contentHash)) {
              fetchCache.record(release.html_url, contentHash, "skipped");
              continue;
            }

            const doc: SourceDocument = {
              sourceProjectId: projectId,
              sourceKind: "github_release",
              title: `${release.name ?? release.tag_name} - GitHub release`,
              text: release.body,
              url: release.html_url,
              claimAuthorKind: "author",
              fetchedAt: new Date().toISOString(),
              contentHash
            };

            const entry = buildDescriptionEvidence(doc, mods);
            if ((entry.claims?.length ?? 0) > 0) {
              evidence.push(entry);
            }

            fetchCache?.record(release.html_url, contentHash, "success");
          }
        } catch {
          // Release API unavailable/rate limited for this repo.
        }
      }
    }

    return dedupeDescriptionEvidence(evidence);
  }

  /**
   * Fetch the README.md for each discovered project repository.
   * READMEs are author-written and often contain compatibility notes and known issues sections.
   */
  async ingestGitHubReadmeEvidence(
    options?: EvidenceIngestionOptions
  ): Promise<ModDescriptionEvidence[]> {
    const githubToken = process.env.GITHUB_TOKEN;
    const mods = [...this.repository.canonicalProjects.values()];
    const evidence: ModDescriptionEvidence[] = [];
    const projectRepositories = await this.discoverProjectGitHubRepositories();
    const fetchCache = options?.fetchCache;
    let remainingRequests = githubRepositoryRequestBudget(
      githubToken,
      GITHUB_README_REQUEST_BUDGET_WITHOUT_TOKEN
    );

    for (const [projectId, repos] of projectRepositories) {
      for (const repo of repos.slice(0, 1)) {
        // Only fetch the primary repo README to keep latency reasonable.
        if (remainingRequests <= 0) return dedupeDescriptionEvidence(evidence);
        remainingRequests--;
        try {
          const readmeText = await fetchGitHubReadme(repo, githubToken);
          if (!readmeText) continue;

          const readmeUrl = `https://github.com/${repo}#readme`;
          const contentHash = stableHash(readmeText).slice(0, 16);

          if (fetchCache?.isUnchanged(readmeUrl, contentHash)) {
            fetchCache.record(readmeUrl, contentHash, "skipped");
            continue;
          }

          const doc: SourceDocument = {
            sourceProjectId: projectId,
            sourceKind: "github_readme",
            title: `${repo} - README`,
            text: readmeText,
            url: readmeUrl,
            claimAuthorKind: "author",
            fetchedAt: new Date().toISOString(),
            contentHash
          };

          const entry = buildDescriptionEvidence(doc, mods);
          if ((entry.claims?.length ?? 0) > 0) {
            evidence.push(entry);
          }

          fetchCache?.record(readmeUrl, contentHash, "success");
        } catch {
          // README unavailable/rate limited.
        }
      }
    }

    return dedupeDescriptionEvidence(evidence);
  }

  /**
   * Fetch official wiki/docs pages discovered from Modrinth project metadata
   * (`wiki_url` field).  Only enabled when `sourceConfig.linked_wiki` is true.
   *
   * These pages are scraped as HTML and stripped to text.  Trust tier is "maintainer".
   * Disabled by default; enable explicitly via EvidenceSourceConfig.
   */
  async ingestLinkedDocEvidence(
    options?: EvidenceIngestionOptions
  ): Promise<ModDescriptionEvidence[]> {
    const mods = [...this.repository.canonicalProjects.values()];
    const evidence: ModDescriptionEvidence[] = [];
    const fetchCache = options?.fetchCache;

    for (const mod of mods) {
      const mappings = [...this.repository.sourceMappings.values()].filter(
        (m) => m.canonicalProjectId === mod.projectId && m.sourceName === "modrinth"
      );

      for (const mapping of mappings) {
        try {
          const project = await fetchJson<{
            wiki_url?: string;
            issues_url?: string;
            title?: string;
          }>(`https://api.modrinth.com/v2/project/${mapping.sourceProjectId}`);

          const wikiUrl = project.wiki_url;
          if (!wikiUrl) continue;

          // Skip GitHub URLs — those are handled by ingestGitHubReadmeEvidence.
          if (wikiUrl.includes("github.com")) continue;

          const contentHash = await fetchHtmlPageHash(wikiUrl);
          if (!contentHash) continue;

          if (fetchCache?.isUnchanged(wikiUrl, contentHash)) {
            fetchCache.record(wikiUrl, contentHash, "skipped");
            continue;
          }

          const pageText = await fetchHtmlPageText(wikiUrl);
          if (!pageText || pageText.length < 50) continue;

          const doc: SourceDocument = {
            sourceProjectId: mod.projectId,
            sourceKind: "linked_wiki",
            title: `${project.title ?? mapping.sourceProjectId} - Official Wiki`,
            text: pageText,
            url: wikiUrl,
            claimAuthorKind: "maintainer",
            fetchedAt: new Date().toISOString(),
            contentHash
          };

          const entry = buildDescriptionEvidence(doc, mods);
          if ((entry.claims?.length ?? 0) > 0) {
            evidence.push(entry);
          }

          fetchCache?.record(wikiUrl, contentHash, "success");
        } catch {
          // Project metadata or wiki page unavailable.
        }
      }
    }

    return dedupeDescriptionEvidence(evidence);
  }

  /**
   * Convert extracted evidence claims into VerifiedRuleDefinitions.
   * Claim-level extraction means a single source document can generate multiple pairwise rules
   * while preserving the exact snippet/provenance that justified each rule.
   */
  generateRulesFromEvidence(
    githubEvidence: GitHubEvidence[],
    descriptionEvidence: ModDescriptionEvidence[]
  ): VerifiedRuleDefinition[] {
    const rules: VerifiedRuleDefinition[] = [];
    let ruleId = 1;
    const knownProjectIds = new Set(this.repository.canonicalProjects.keys());
    const allRawClaims = [
      ...githubEvidence.flatMap((e) => e.claims ?? evidenceToLegacyClaims(e, "github_issue")),
      ...descriptionEvidence.flatMap((e) => e.claims ?? evidenceToLegacyClaims(e, e.source))
    ];

    // Apply cross-source conflict resolution before rule generation.
    const allClaims = flagDisputedClaims(dedupeClaims(allRawClaims));

    for (const claim of allClaims) {
      if (!knownProjectIds.has(claim.sourceProjectId) || !knownProjectIds.has(claim.targetProjectId)) {
        continue;
      }

      if (claim.verdict === "uncertain") continue;

      const sourceLabel = sourceKindLabel(claim.sourceKind);
      const isIncompatible = claim.verdict === "incompatible";

      // Build the summary, noting constraints when present.
      let summaryExtra = "";
      if (claim.fixedInVersion) summaryExtra += ` (fixed in v${claim.fixedInVersion})`;
      if (claim.loaderConstraint) summaryExtra += ` [${claim.loaderConstraint} only]`;
      if (claim.environmentConstraint) summaryExtra += ` [${claim.environmentConstraint}-side]`;
      if (claim.isDisputed) summaryExtra += " [disputed by other source]";

      rules.push({
        rule_id: `evidence_rule_${ruleId++}`,
        version: 1,
        title: claim.evidenceTitle,
        finding_type: isIncompatible
          ? `${claim.sourceKind}_incompatibility`
          : `${claim.sourceKind}_compatibility`,
        severity: isIncompatible ? severityForConfidence(claim.confidence) : "low",
        confidence: claim.confidence,
        reproducibility: claim.confidence >= 0.82 ? "confirmed" : "likely",
        summary: `${claim.sourceProjectId} ${isIncompatible ? "incompatible with" : "compatible with"} ${claim.targetProjectId} (${sourceLabel}: ${claim.snippet})${summaryExtra}`,
        recommended_actions: isIncompatible
          ? ["Avoid using together until empirically tested", "Prioritize this pair for ground-truth validation"]
          : ["Treat as lower-priority for incompatibility testing unless other signals disagree"],
        conditions: [
          { type: "project_present", project_id: claim.sourceProjectId },
          { type: "project_present", project_id: claim.targetProjectId }
        ]
      });
    }

    return rules;
  }

  /**
   * Run full evidence ingestion from all active sources.
   * Active sources are determined by merging DEFAULT_SOURCE_CONFIG with options.sourceConfig.
   *
   * Source execution order:
   *   1. Registry descriptions + changelogs (Modrinth / CurseForge)  — always parallel
   *   2. GitHub issues/discussions                                     — always parallel
   *   3. GitHub releases (if enabled)                                 — sequential after above
   *   4. GitHub READMEs (if enabled)                                  — sequential after above
   *   5. Linked wiki/docs pages (if enabled, opt-in only)             — sequential after above
   */
  async ingestFromAllSources(options?: EvidenceIngestionOptions): Promise<EvidentSourcesResult> {
    const config: EvidenceSourceConfig = {
      ...DEFAULT_SOURCE_CONFIG,
      ...(options?.sourceConfig ?? {})
    };

    const initialFetchCacheHits = options?.fetchCache?.hits ?? 0;

    // Phase 1: parallel core sources
    const [descriptionEvidence, githubEvidence] = await Promise.all([
      config.modrinth_description || config.modrinth_changelog ||
      config.curseforge_description || config.curseforge_changelog
        ? this.ingestModDescriptionEvidence(options)
        : Promise.resolve([] as ModDescriptionEvidence[]),
      config.github_issue
        ? this.ingestGitHubEvidence(options)
        : Promise.resolve([] as GitHubEvidence[])
    ]);

    // Phase 2: additional GitHub-backed sources (sequential to respect rate limits)
    const releaseEvidence: ModDescriptionEvidence[] = config.github_release
      ? await this.ingestGitHubReleaseEvidence(options)
      : [];

    const readmeEvidence: ModDescriptionEvidence[] = config.github_readme
      ? await this.ingestGitHubReadmeEvidence(options)
      : [];

    // Phase 3: opt-in web sources
    const linkedDocEvidence: ModDescriptionEvidence[] = config.linked_wiki
      ? await this.ingestLinkedDocEvidence(options)
      : [];

    // Combine all description-style evidence
    const allDescriptionEvidence = [
      ...descriptionEvidence,
      ...releaseEvidence,
      ...readmeEvidence,
      ...linkedDocEvidence
    ];

    const rules = this.generateRulesFromEvidence(githubEvidence, allDescriptionEvidence);

    let rulesGenerated = 0;
    for (const rule of rules) {
      const existing = this.repository.verifiedRules.find((r) => r.rule_id === rule.rule_id);
      if (!existing) {
        this.repository.verifiedRules.push(rule);
        rulesGenerated++;
      }
    }

    const changelogEvidence = descriptionEvidence.filter((e) => e.source.includes("changelog"));
    const descriptionOnlyEvidence = descriptionEvidence.filter((e) => e.source.includes("description"));
    const claimsExtracted =
      githubEvidence.reduce((sum, e) => sum + (e.claims?.length ?? 0), 0) +
      allDescriptionEvidence.reduce((sum, e) => sum + (e.claims?.length ?? 0), 0);

    const currentFetchCacheHits = options?.fetchCache?.hits ?? 0;

    return {
      githubIssuesFound: githubEvidence.length,
      githubIssuesProcessed: githubEvidence.filter((e) => e.claims?.length || e.verdict).length,
      githubIssueSearchQueriesAttempted: this._lastGitHubIssueSearchStats.attempted,
      githubIssueSearchQueriesSkipped: this._lastGitHubIssueSearchStats.skipped,
      descriptionsFound: descriptionOnlyEvidence.length,
      descriptionsProcessed: descriptionOnlyEvidence.filter((e) => e.claims?.length || e.verdict).length,
      changelogsFound: changelogEvidence.length,
      changelogsProcessed: changelogEvidence.filter((e) => e.claims?.length || e.verdict).length,
      claimsExtracted,
      rulesGenerated,
      total: githubEvidence.length + allDescriptionEvidence.length,
      githubReleasesFound: releaseEvidence.length,
      githubReadmesFound: readmeEvidence.length,
      linkedDocsFound: linkedDocEvidence.length,
      fetchCacheHits: currentFetchCacheHits - initialFetchCacheHits
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async ingestModrinthDocuments(
    projectId: string,
    sourceProjectId: string,
    mods: KnownProject[],
    fetchCache?: EvidenceFetchCache
  ): Promise<ModDescriptionEvidence[]> {
    const evidence: ModDescriptionEvidence[] = [];

    try {
      const project = await fetchJson<{
        title?: string;
        slug?: string;
        description?: string;
        body?: string;
        issues_url?: string;
        source_url?: string;
        wiki_url?: string;
      }>(`https://api.modrinth.com/v2/project/${sourceProjectId}`);

      const title = project.title ?? sourceProjectId;
      const projectUrl = `https://modrinth.com/mod/${project.slug ?? sourceProjectId}`;
      const text = [
        project.description,
        project.body,
        project.issues_url,
        project.source_url,
        project.wiki_url
      ]
        .filter(Boolean)
        .join("\n");

      const contentHash = stableHash(text).slice(0, 16);

      if (!fetchCache?.isUnchanged(projectUrl, contentHash)) {
        evidence.push(
          buildDescriptionEvidence({
            sourceProjectId: projectId,
            sourceKind: "modrinth_description",
            title: `${title} - Modrinth description`,
            text,
            url: projectUrl,
            claimAuthorKind: "author",
            fetchedAt: new Date().toISOString(),
            contentHash
          }, mods)
        );
        fetchCache?.record(projectUrl, contentHash, "success");
      } else {
        fetchCache?.record(projectUrl, contentHash, "skipped");
      }
    } catch {
      // Modrinth project unavailable/rate limited.
    }

    try {
      const versions = await fetchJson<
        Array<{ version_number?: string; name?: string; changelog?: string; date_published?: string }>
      >(`https://api.modrinth.com/v2/project/${sourceProjectId}/version`);

      for (const version of versions.slice(0, MAX_MODRINTH_CHANGELOGS_PER_PROJECT)) {
        if (!version.changelog) continue;
        const clUrl = `https://modrinth.com/mod/${sourceProjectId}/versions#${version.version_number ?? ""}`;
        const contentHash = stableHash(version.changelog).slice(0, 16);

        if (fetchCache?.isUnchanged(clUrl, contentHash)) {
          fetchCache.record(clUrl, contentHash, "skipped");
          continue;
        }

        evidence.push(
          buildDescriptionEvidence({
            sourceProjectId: projectId,
            sourceKind: "modrinth_changelog",
            title: `${version.name ?? version.version_number ?? sourceProjectId} - Modrinth changelog`,
            text: version.changelog,
            url: `https://modrinth.com/mod/${sourceProjectId}/versions`,
            claimAuthorKind: "author",
            fetchedAt: new Date().toISOString(),
            contentHash
          }, mods)
        );
        fetchCache?.record(clUrl, contentHash, "success");
      }
    } catch {
      // Modrinth versions unavailable/rate limited.
    }

    return evidence.filter((entry) => (entry.claims?.length ?? 0) > 0);
  }

  private async ingestCurseForgeDocuments(
    projectId: string,
    sourceProjectId: string,
    mods: KnownProject[],
    fetchCache?: EvidenceFetchCache
  ): Promise<ModDescriptionEvidence[]> {
    const apiKey = process.env.CURSEFORGE_API_KEY;
    if (!apiKey || !/^\d+$/.test(sourceProjectId)) return [];

    const evidence: ModDescriptionEvidence[] = [];
    const headers = { Accept: "application/json", "x-api-key": apiKey };

    try {
      const description = await fetchJson<{ data?: string }>(
        `https://api.curseforge.com/v1/mods/${sourceProjectId}/description`,
        headers
      );
      const text = stripHtml(description.data ?? "");
      const cfUrl = `https://www.curseforge.com/minecraft/mc-mods/${sourceProjectId}`;
      const contentHash = stableHash(text).slice(0, 16);

      if (!fetchCache?.isUnchanged(cfUrl, contentHash)) {
        evidence.push(
          buildDescriptionEvidence({
            sourceProjectId: projectId,
            sourceKind: "curseforge_description",
            title: `${sourceProjectId} - CurseForge description`,
            text,
            url: cfUrl,
            claimAuthorKind: "author",
            fetchedAt: new Date().toISOString(),
            contentHash
          }, mods)
        );
        fetchCache?.record(cfUrl, contentHash, "success");
      } else {
        fetchCache?.record(cfUrl, contentHash, "skipped");
      }
    } catch {
      // CurseForge description unavailable/rate limited.
    }

    try {
      const files = await fetchJson<{
        data?: Array<{ displayName?: string; fileName?: string; changelog?: string }>;
      }>(
        `https://api.curseforge.com/v1/mods/${sourceProjectId}/files?pageSize=${MAX_CURSEFORGE_FILES_PER_PROJECT}`,
        headers
      );

      for (const file of files.data ?? []) {
        if (!file.changelog) continue;
        const text = stripHtml(file.changelog);
        const fileUrl = `https://www.curseforge.com/minecraft/mc-mods/${sourceProjectId}/files`;
        const contentHash = stableHash(text).slice(0, 16);

        if (fetchCache?.isUnchanged(fileUrl + (file.displayName ?? ""), contentHash)) {
          fetchCache.record(fileUrl + (file.displayName ?? ""), contentHash, "skipped");
          continue;
        }

        evidence.push(
          buildDescriptionEvidence({
            sourceProjectId: projectId,
            sourceKind: "curseforge_changelog",
            title: `${file.displayName ?? file.fileName ?? sourceProjectId} - CurseForge changelog`,
            text,
            url: fileUrl,
            claimAuthorKind: "author",
            fetchedAt: new Date().toISOString(),
            contentHash
          }, mods)
        );
        fetchCache?.record(fileUrl + (file.displayName ?? ""), contentHash, "success");
      }
    } catch {
      // CurseForge files unavailable/rate limited.
    }

    return evidence.filter((entry) => (entry.claims?.length ?? 0) > 0);
  }

  private async discoverProjectGitHubRepositories(): Promise<Map<string, string[]>> {
    if (this._repoCache) return this._repoCache;
    this._repoCachePromise ??= this.fetchProjectGitHubRepositories();
    this._repoCache = await this._repoCachePromise;
    return this._repoCache;
  }

  private async fetchProjectGitHubRepositories(): Promise<Map<string, string[]>> {
    const reposByProject = new Map<string, string[]>();
    const mods = [...this.repository.canonicalProjects.values()];

    for (const mod of mods) {
      const mappings = [...this.repository.sourceMappings.values()].filter(
        (m) => m.canonicalProjectId === mod.projectId && m.sourceName === "modrinth"
      );

      for (const mapping of mappings) {
        try {
          const project = await fetchJson<{ issues_url?: string; source_url?: string }>(
            `https://api.modrinth.com/v2/project/${mapping.sourceProjectId}`
          );
          const repos = [project.issues_url, project.source_url]
            .map((url) => githubRepositoryFromUrl(url))
            .filter((repo): repo is string => Boolean(repo));
          if (repos.length > 0) {
            reposByProject.set(mod.projectId, [
              ...new Set([...(reposByProject.get(mod.projectId) ?? []), ...repos])
            ]);
          }
        } catch {
          // Repo discovery is opportunistic.
        }
      }
    }

    return reposByProject;
  }

  private async resolveCurseForgeProjectId(
    mod: KnownProject,
    sourceProjectId: string
  ): Promise<string | undefined> {
    const apiKey = process.env.CURSEFORGE_API_KEY;
    if (!apiKey) return undefined;
    if (/^\d+$/.test(sourceProjectId)) return sourceProjectId;

    const cacheKey = `${mod.projectId}:${sourceProjectId}`;
    if (this._curseForgeProjectIdCache.has(cacheKey)) {
      return this._curseForgeProjectIdCache.get(cacheKey) ?? undefined;
    }

    const headers = { Accept: "application/json", "x-api-key": apiKey };
    const names = [sourceProjectId, mod.displayName, ...(mod.aliases ?? [])]
      .map((name) => name.trim())
      .filter((name, index, all) => name.length > 0 && all.indexOf(name) === index);
    const normalizedNames = new Set(names.map(normalizeLookupName));

    for (const name of names) {
      const params = new URLSearchParams({
        gameId: "432",
        classId: "6",
        searchFilter: name,
        pageSize: "5"
      });

      try {
        const result = await fetchJson<{
          data?: Array<{ id: number; name?: string; slug?: string }>;
        }>(`https://api.curseforge.com/v1/mods/search?${params}`, headers);

        const candidates = result.data ?? [];
        const exact = candidates.find((candidate) =>
          normalizedNames.has(normalizeLookupName(candidate.slug ?? "")) ||
          normalizedNames.has(normalizeLookupName(candidate.name ?? ""))
        );
        const selected = exact ?? (candidates.length === 1 ? candidates[0] : undefined);
        if (selected?.id) {
          const resolved = String(selected.id);
          this._curseForgeProjectIdCache.set(cacheKey, resolved);
          return resolved;
        }
      } catch {
        // Resolution is opportunistic; try the next alias.
      }
    }

    this._curseForgeProjectIdCache.set(cacheKey, null);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Private helpers (module-level)
// ---------------------------------------------------------------------------

function buildDescriptionEvidence(document: SourceDocument, mods: KnownProject[]): ModDescriptionEvidence {
  const claims = extractCompatibilityClaimsFromText(document, mods);
  const summary = summarizeClaims(claims);
  return {
    projectId: document.sourceProjectId,
    source: document.sourceKind as ModDescriptionEvidence["source"],
    title: document.title,
    content: summary.supportingClaim ?? document.text.slice(0, 2000),
    linkedProjects: linkedProjectsFromClaims(document.sourceProjectId, claims),
    verdict: summary.verdict,
    confidence: summary.confidence,
    claims,
    sourceUrl: document.url
  };
}

function splitEvidenceText(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(SENTENCE_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length > 8);
}

function firstPatternMatch(sentence: string, patterns: Array<[RegExp, string]>): string | undefined {
  return patterns.find(([pattern]) => pattern.test(sentence))?.[1];
}

function matchFixedInVersionPattern(sentence: string): string {
  return firstPatternMatch(sentence, FIXED_IN_VERSION_PATTERNS) ?? "fixed_in_version";
}

function findProjectMentions(text: string, allProjects: KnownProject[]): ProjectMatch[] {
  const matches: ProjectMatch[] = [];

  for (const project of allProjects) {
    const names = [project.displayName, ...(project.aliases ?? [])]
      .map((name) => name.trim())
      .filter((name) => name.length >= 3);

    const matchedName = names.find((name) => containsName(text, name));
    if (matchedName) {
      matches.push({
        projectId: project.projectId,
        canonicalName: project.displayName,
        matchedName
      });
    }
  }

  return matches;
}

function containsName(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text);
}

function scoreClaimConfidence(
  claim: TextClaim,
  sourceKind: EvidenceSourceKind,
  sourceMentioned: boolean
): number {
  const sourceWeight = SOURCE_CONFIDENCE[sourceKind];
  const relationWeight = sourceMentioned ? 1 : 0.96;
  const score = claim.confidence * sourceWeight * relationWeight;
  return Math.max(0.45, Math.min(0.96, Number(score.toFixed(2))));
}

function inferClaimAuthorKind(sourceKind: EvidenceSourceKind): ExtractedCompatibilityClaim["claimAuthorKind"] {
  const tier = SOURCE_TRUST_TIER[sourceKind];
  if (tier === "author") return "author";
  if (tier === "maintainer") return "maintainer";
  if (tier === "community") return "user";
  return "inferred";
}

function summarizeClaims(claims: ExtractedCompatibilityClaim[]): {
  verdict: EvidenceVerdict;
  confidence: number;
  supportingClaim?: string;
} {
  if (claims.length === 0) return { verdict: "uncertain", confidence: 0.5 };

  const incompatibleClaims = claims.filter((c) => c.verdict === "incompatible");
  const compatibleClaims = claims.filter((c) => c.verdict === "compatible");
  const incompatibleScore = incompatibleClaims.reduce((sum, c) => sum + c.confidence, 0);
  const compatibleScore = compatibleClaims.reduce((sum, c) => sum + c.confidence, 0);

  if (incompatibleScore >= compatibleScore && incompatibleClaims.length > 0) {
    const best = incompatibleClaims.reduce((a, b) => (a.confidence >= b.confidence ? a : b));
    return { verdict: "incompatible", confidence: best.confidence, supportingClaim: best.snippet };
  }

  const best = compatibleClaims.reduce((a, b) => (a.confidence >= b.confidence ? a : b));
  return { verdict: "compatible", confidence: best.confidence, supportingClaim: best.snippet };
}

function linkedProjectsFromClaims(sourceProjectId: string, claims: ExtractedCompatibilityClaim[]): string[] {
  const linked = new Set<string>([sourceProjectId]);
  for (const claim of claims) {
    linked.add(claim.sourceProjectId);
    linked.add(claim.targetProjectId);
  }
  return [...linked];
}

function dedupeClaims(claims: ExtractedCompatibilityClaim[]): ExtractedCompatibilityClaim[] {
  const byKey = new Map<string, ExtractedCompatibilityClaim>();
  for (const claim of claims) {
    const pair = [claim.sourceProjectId, claim.targetProjectId].sort().join(":");
    const key = `${claim.sourceKind}:${pair}:${claim.verdict}:${claim.matchedPattern}:${claim.snippet.toLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing || claim.confidence > existing.confidence) {
      byKey.set(key, claim);
    }
  }
  return [...byKey.values()];
}

/**
 * Resolve conflicting claims for the same project pair from different sources.
 *
 * When two claims for the same (source, target) pair have opposite verdicts, the
 * higher-trust-tier source wins.  Equal-tier ties are broken by confidence.
 * Fail-safe: incompatible wins on a complete tie.
 *
 * The losing side is flagged `isDisputed=true` and its confidence is reduced by 30%.
 */
export function flagDisputedClaims(claims: ExtractedCompatibilityClaim[]): ExtractedCompatibilityClaim[] {
  // Group by canonical sorted pair key (direction-agnostic)
  const byPair = new Map<string, ExtractedCompatibilityClaim[]>();
  for (const claim of claims) {
    const key = [claim.sourceProjectId, claim.targetProjectId].sort().join(":");
    const bucket = byPair.get(key) ?? [];
    bucket.push(claim);
    byPair.set(key, bucket);
  }

  const result: ExtractedCompatibilityClaim[] = [];

  for (const pairClaims of byPair.values()) {
    const incompatible = pairClaims.filter((c) => c.verdict === "incompatible");
    const compatible = pairClaims.filter((c) => c.verdict === "compatible");

    // No conflict → pass through unchanged
    if (incompatible.length === 0 || compatible.length === 0) {
      result.push(...pairClaims);
      continue;
    }

    // Determine best claim from each camp
    const bestOf = (group: ExtractedCompatibilityClaim[]): ExtractedCompatibilityClaim =>
      group.reduce((a, b) => {
        const ap = TRUST_TIER_PRIORITY[SOURCE_TRUST_TIER[a.sourceKind]] ?? 1;
        const bp = TRUST_TIER_PRIORITY[SOURCE_TRUST_TIER[b.sourceKind]] ?? 1;
        return ap > bp || (ap === bp && a.confidence >= b.confidence) ? a : b;
      });

    const bestIncompat = bestOf(incompatible);
    const bestCompat = bestOf(compatible);

    const incompatPriority = TRUST_TIER_PRIORITY[SOURCE_TRUST_TIER[bestIncompat.sourceKind]] ?? 1;
    const compatPriority = TRUST_TIER_PRIORITY[SOURCE_TRUST_TIER[bestCompat.sourceKind]] ?? 1;

    // Incompatible wins on ties (fail-safe)
    const incompatWins =
      incompatPriority > compatPriority ||
      (incompatPriority === compatPriority && bestIncompat.confidence >= bestCompat.confidence);

    result.push(
      ...incompatible.map((c) => ({
        ...c,
        isDisputed: !incompatWins,
        confidence: !incompatWins
          ? Number((c.confidence * 0.7).toFixed(2))
          : c.confidence
      })),
      ...compatible.map((c) => ({
        ...c,
        isDisputed: incompatWins,
        confidence: incompatWins
          ? Number((c.confidence * 0.7).toFixed(2))
          : c.confidence
      }))
    );
  }

  return result;
}

function dedupeDescriptionEvidence(evidence: ModDescriptionEvidence[]): ModDescriptionEvidence[] {
  const byKey = new Map<string, ModDescriptionEvidence>();
  for (const entry of evidence) {
    const key = `${entry.projectId}:${entry.source}:${entry.title}:${entry.content}`;
    if (!byKey.has(key)) {
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()];
}

function dedupeGitHubEvidence(evidence: GitHubEvidence[]): GitHubEvidence[] {
  const byUrl = new Map<string, GitHubEvidence>();
  for (const entry of evidence) {
    const existing = byUrl.get(entry.issueUrl);
    if (!existing || (entry.claims?.length ?? 0) > (existing.claims?.length ?? 0)) {
      byUrl.set(entry.issueUrl, entry);
    }
  }
  return [...byUrl.values()];
}

function evidenceToLegacyClaims(
  evidence: GitHubEvidence | ModDescriptionEvidence,
  sourceKind: EvidenceSourceKind
): ExtractedCompatibilityClaim[] {
  if (!evidence.verdict || evidence.linkedProjects.length < 2) return [];
  const [sourceProjectId, targetProjectId] = evidence.linkedProjects;
  if (!sourceProjectId || !targetProjectId) return [];

  return [
    {
      sourceProjectId,
      targetProjectId,
      verdict: evidence.verdict,
      confidence: evidence.confidence ?? 0.72,
      sourceKind,
      evidenceTitle: evidence.title,
      sourceUrl: "issueUrl" in evidence ? evidence.issueUrl : evidence.sourceUrl,
      snippet: "body" in evidence ? evidence.body.slice(0, 240) : evidence.content.slice(0, 240),
      matchedPattern: "legacy_evidence",
      claimAuthorKind: inferClaimAuthorKind(sourceKind)
    }
  ];
}

function severityForConfidence(confidence: number): VerifiedRuleDefinition["severity"] {
  if (confidence >= 0.9) return "high";
  if (confidence >= 0.65) return "medium";
  return "low";
}

function sourceKindLabel(sourceKind: EvidenceSourceKind): string {
  return sourceKind.replace(/_/g, " ");
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch JSON with automatic retry on network errors and 429 rate-limit responses.
 *
 * On 429: respects Retry-After header; otherwise uses exponential backoff with
 * full jitter so concurrent callers don't all retry at the same instant.
 * On network error: retries with exponential backoff.
 */
async function fetchJson<T>(url: string, headers?: HeadersInit, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, headers ? { headers } : undefined);
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await delay(1000 * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5));
      continue;
    }

    if (res.status === 429) {
      if (attempt === maxRetries) throw new Error(`Rate limited after ${maxRetries + 1} attempts: ${url}`);
      const retryAfterSec = Number.parseInt(res.headers.get("Retry-After") ?? "0", 10);
      const base = retryAfterSec > 0 ? retryAfterSec * 1000 : Math.min(30_000, 2000 * Math.pow(2, attempt));
      await delay(base * (0.5 + Math.random() * 0.5));
      continue;
    }

    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return (await res.json()) as T;
  }
  throw new Error(`All retries exhausted for ${url}`);
}

/**
 * Run `fn` over `items` with at most `concurrency` tasks active at once.
 * Results are returned in input order; errors leave the slot undefined.
 * Safe for shared mutable state — JS cooperative multitasking means only one
 * microtask runs at a time, so synchronous operations between awaits are atomic.
 */
async function runConcurrently<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = new Array(items.length).fill(undefined);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try { results[i] = await fn(items[i]!, i); } catch { /* slot stays undefined */ }
    }
  }
  const count = Math.min(concurrency, items.length);
  if (count > 0) await Promise.all(Array.from({ length: count }, worker));
  return results;
}

async function fetchGitHubIssues(
  query: string,
  githubToken?: string
): Promise<{
  items: Array<{
    html_url: string;
    title: string;
    body: string | null;
    labels: Array<{ name: string }>;
    created_at: string;
    repository_url: string;
  }>;
}> {
  const headers: HeadersInit = {
    Accept: "application/vnd.github.v3+json"
  };
  if (githubToken) {
    headers.Authorization = `token ${githubToken}`;
  }

  return fetchJson(
    `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=${MAX_GITHUB_ISSUES_PER_QUERY}`,
    headers
  );
}

async function fetchGitHubReleases(
  repo: string,
  githubToken?: string,
  perPage = MAX_GITHUB_RELEASES_PER_REPO
): Promise<
  Array<{ tag_name: string; name: string | null; body: string | null; html_url: string }>
> {
  const headers: HeadersInit = { Accept: "application/vnd.github.v3+json" };
  if (githubToken) headers.Authorization = `token ${githubToken}`;
  return fetchJson(
    `https://api.github.com/repos/${repo}/releases?per_page=${perPage}`,
    headers
  );
}

async function fetchGitHubReadme(repo: string, githubToken?: string): Promise<string | null> {
  const headers: HeadersInit = { Accept: "application/vnd.github.v3+json" };
  if (githubToken) headers.Authorization = `token ${githubToken}`;

  const data = await fetchJson<{ content?: string; encoding?: string }>(
    `https://api.github.com/repos/${repo}/readme`,
    headers
  );

  if (!data.content || data.encoding !== "base64") return null;

  // Decode base64 → utf-8 text (Node.js 18+)
  const decoded = Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf-8");
  // Strip markdown image/link syntax to reduce noise
  return decoded
    .replace(/!\[.*?\]\(.*?\)/g, " ")   // images
    .replace(/\[.*?\]\(.*?\)/g, " ")    // links — keep anchor text only
    .replace(/```[\s\S]*?```/g, " ")    // code blocks
    .replace(/`[^`]+`/g, " ")           // inline code
    .trim();
}

/**
 * Fetch a web page and return its text hash without fully processing it.
 * Used to quickly check if cached content is still current before full fetch.
 */
async function fetchHtmlPageHash(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "ModCompatibilityBot/1.0 (offline evidence indexer)" }
    });
    if (!response.ok) return null;
    const text = await response.text();
    return stableHash(text).slice(0, 16);
  } catch {
    return null;
  }
}

async function fetchHtmlPageText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "ModCompatibilityBot/1.0 (offline evidence indexer)" }
    });
    if (!response.ok) return null;
    return stripHtml(await response.text());
  } catch {
    return null;
  }
}

function githubRepositoryFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const match = url.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+)/i);
  if (!match) return undefined;
  return `${match[1]}/${match[2].replace(/\.git$/i, "")}`;
}

function normalizeLookupName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function githubSearchQueryBudget(githubToken?: string): number {
  const configured = Number.parseInt(process.env.GITHUB_SEARCH_QUERY_BUDGET ?? "", 10);
  if (Number.isFinite(configured) && configured >= 0) {
    return configured;
  }
  return githubToken
    ? GITHUB_SEARCH_QUERY_BUDGET_WITH_TOKEN
    : GITHUB_SEARCH_QUERY_BUDGET_WITHOUT_TOKEN;
}

function githubRepositoryRequestBudget(githubToken: string | undefined, unauthenticatedBudget: number): number {
  if (!githubToken) return unauthenticatedBudget;
  const configured = Number.parseInt(process.env.GITHUB_REPOSITORY_REQUEST_BUDGET ?? "", 10);
  if (Number.isFinite(configured) && configured >= 0) {
    return configured;
  }
  return GITHUB_SEARCH_QUERY_BUDGET_WITH_TOKEN;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}
