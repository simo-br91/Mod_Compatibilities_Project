import assert from "node:assert/strict";
import test from "node:test";

import { createPhase1Platform } from "./index.js";
import {
  extractCompatibilityClaimsFromText,
  extractClaimsFromText,
  flagDisputedClaims,
  DEFAULT_SOURCE_CONFIG,
  type SourceDocument,
  type ExtractedCompatibilityClaim
} from "./evidence-sources.js";
import { EvidenceFetchCache } from "./evidence-fetch-cache.js";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const projects = [
  { projectId: "cp_sodium", displayName: "Sodium", aliases: ["sodium"] },
  { projectId: "cp_optifine", displayName: "OptiFine", aliases: ["optifine"] },
  { projectId: "cp_lithium", displayName: "Lithium", aliases: ["lithium"] }
];

// ---------------------------------------------------------------------------
// Original tests (must remain passing)
// ---------------------------------------------------------------------------

test("extractCompatibilityClaimsFromText emits pair-level incompatibility claims from author text", () => {
  const document: SourceDocument = {
    sourceProjectId: "cp_sodium",
    sourceKind: "modrinth_description",
    title: "Sodium - Modrinth description",
    text: "This mod is not compatible with OptiFine. Use Iris Shaders instead.",
    url: "https://modrinth.com/mod/sodium"
  };

  const claims = extractCompatibilityClaimsFromText(document, projects);

  assert.equal(claims.length, 1);
  assert.equal(claims[0]!.sourceProjectId, "cp_sodium");
  assert.equal(claims[0]!.targetProjectId, "cp_optifine");
  assert.equal(claims[0]!.verdict, "incompatible");
  assert.ok(claims[0]!.confidence >= 0.8);
  assert.equal(claims[0]!.matchedPattern, "not_compatible_with");
});

test("extractCompatibilityClaimsFromText distinguishes compatible and conditional claims", () => {
  const document: SourceDocument = {
    sourceProjectId: "cp_sodium",
    sourceKind: "modrinth_changelog",
    title: "Sodium changelog",
    text: "Works well with Lithium. May conflict with OptiFine without a compatibility patch."
  };

  const claims = extractCompatibilityClaimsFromText(document, projects);

  const lithium = claims.find((claim) => claim.targetProjectId === "cp_lithium");
  const optifine = claims.find((claim) => claim.targetProjectId === "cp_optifine");

  assert.equal(lithium?.verdict, "compatible");
  assert.equal(optifine?.verdict, "incompatible");
  assert.equal(optifine?.matchedPattern, "may_conflict_with");
});

test("extractCompatibilityClaimsFromText ignores unanchored generic compatibility language", () => {
  const document: SourceDocument = {
    sourceProjectId: "cp_sodium",
    sourceKind: "modrinth_description",
    title: "Sodium - Modrinth description",
    text: "This release improves compatibility and fixes several crashes."
  };

  const claims = extractCompatibilityClaimsFromText(document, projects);

  assert.equal(claims.length, 0);
});

test("generateRulesFromEvidence creates pairwise rules from extracted claims", () => {
  const platform = createPhase1Platform();

  const rules = platform.evidenceSources.generateRulesFromEvidence([], [
    {
      projectId: "cp_sodium",
      source: "modrinth_description",
      title: "Sodium - Modrinth description",
      content: "This mod is not compatible with OptiFine.",
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
          evidenceTitle: "Sodium - Modrinth description",
          snippet: "This mod is not compatible with OptiFine.",
          matchedPattern: "not_compatible_with"
        }
      ]
    }
  ]);

  assert.equal(rules.length, 1);
  assert.equal(rules[0]!.finding_type, "modrinth_description_incompatibility");
  assert.equal(rules[0]!.conditions.length, 2);
  assert.ok(rules[0]!.recommended_actions.some((action) => action.includes("ground-truth")));
});

// ---------------------------------------------------------------------------
// Semantic extraction: fixed-in-version
// ---------------------------------------------------------------------------

test("extractClaimsFromText detects 'fixed in version X' and emits reduced-confidence incompatible claim", () => {
  const claims = extractClaimsFromText(
    "The crash when loading with OptiFine was fixed in version 2.0."
  );

  assert.ok(claims.length >= 1, "Expected at least one claim");
  const fixedClaim = claims.find((c) => c.fixedInVersion);
  assert.ok(fixedClaim, "Expected a claim with fixedInVersion set");
  assert.equal(fixedClaim!.verdict, "incompatible");
  assert.ok(fixedClaim!.confidence <= 0.55, "Fixed-in-version claim should have reduced confidence");
  assert.equal(fixedClaim!.fixedInVersion, "2.0");
});

test("extractClaimsFromText detects 'resolved as of vX'", () => {
  const claims = extractClaimsFromText(
    "The incompatibility with Sodium was resolved as of v1.19.4."
  );

  const fixedClaim = claims.find((c) => c.fixedInVersion);
  assert.ok(fixedClaim, "Expected fixedInVersion to be set");
  assert.equal(fixedClaim!.verdict, "incompatible");
  assert.ok(["1.19.4", "19.4"].includes(fixedClaim!.fixedInVersion ?? ""));
});

test("extractCompatibilityClaimsFromText propagates fixedInVersion to pair-level claim", () => {
  const document: SourceDocument = {
    sourceProjectId: "cp_sodium",
    sourceKind: "modrinth_changelog",
    title: "Sodium 2.0 changelog",
    text: "The crash when loading with OptiFine was fixed in version 2.0."
  };

  const claims = extractCompatibilityClaimsFromText(document, projects);
  const claim = claims.find((c) => c.targetProjectId === "cp_optifine");

  assert.ok(claim, "Expected a claim targeting OptiFine");
  assert.equal(claim!.fixedInVersion, "2.0");
  assert.equal(claim!.verdict, "incompatible");
  assert.ok(claim!.confidence <= 0.55);
});

// ---------------------------------------------------------------------------
// Semantic extraction: loader-specific
// ---------------------------------------------------------------------------

test("extractClaimsFromText detects Fabric-ok/Forge-broken pattern", () => {
  const claims = extractClaimsFromText(
    "This mod works on Fabric but crashes on Forge when loaded with OptiFine."
  );

  const loaderClaim = claims.find((c) => c.matchedPattern === "fabric_ok_forge_broken");
  assert.ok(loaderClaim, "Expected a loader-specific claim");
  assert.equal(loaderClaim!.verdict, "incompatible");
  assert.equal(loaderClaim!.loaderConstraint, "forge");
});

test("extractClaimsFromText emits loaderConstraint for loader-specific incompatibility", () => {
  const claims = extractClaimsFromText(
    "This mod is incompatible only on Forge due to rendering differences."
  );

  const loaderClaim = claims.find((c) => c.loaderConstraint === "forge");
  assert.ok(loaderClaim, "Expected loaderConstraint to be 'forge'");
  assert.equal(loaderClaim!.verdict, "incompatible");
});

test("extractCompatibilityClaimsFromText propagates loaderConstraint to pair-level claim", () => {
  const document: SourceDocument = {
    sourceProjectId: "cp_sodium",
    sourceKind: "github_readme",
    title: "Sodium README",
    text: "This mod works on Fabric but crashes on Forge when loaded with OptiFine.",
    claimAuthorKind: "author"
  };

  const claims = extractCompatibilityClaimsFromText(document, projects);
  const claim = claims.find((c) => c.targetProjectId === "cp_optifine");

  assert.ok(claim, "Expected a claim targeting OptiFine");
  assert.equal(claim!.loaderConstraint, "forge");
  assert.equal(claim!.verdict, "incompatible");
  assert.equal(claim!.claimAuthorKind, "author");
});

// ---------------------------------------------------------------------------
// Semantic extraction: environment-specific
// ---------------------------------------------------------------------------

test("extractClaimsFromText detects server-side-only issue", () => {
  const claims = extractClaimsFromText(
    "There is a known server-side only crash when Sodium and OptiFine are both installed."
  );

  const envClaim = claims.find((c) => c.environmentConstraint === "server");
  assert.ok(envClaim, "Expected environmentConstraint = 'server'");
  assert.equal(envClaim!.verdict, "incompatible");
});

test("extractClaimsFromText detects client-side-only issue", () => {
  const claims = extractClaimsFromText(
    "This is a client-side only conflict with the rendering pipeline."
  );

  const envClaim = claims.find((c) => c.environmentConstraint === "client");
  assert.ok(envClaim, "Expected environmentConstraint = 'client'");
  assert.equal(envClaim!.verdict, "incompatible");
});

test("extractCompatibilityClaimsFromText propagates environmentConstraint to pair-level claim", () => {
  const document: SourceDocument = {
    sourceProjectId: "cp_lithium",
    sourceKind: "github_issue",
    title: "Server crash report",
    text: "Lithium and Sodium cause a server-side only crash when loaded together."
  };

  const claims = extractCompatibilityClaimsFromText(document, projects);
  // GitHub issues require both mods to be mentioned — both are in text here
  const claim = claims.find(
    (c) => c.environmentConstraint === "server"
  );
  assert.ok(claim, "Expected server-side claim");
  assert.equal(claim!.verdict, "incompatible");
});

// ---------------------------------------------------------------------------
// Semantic extraction: requiresPatch
// ---------------------------------------------------------------------------

test("extractClaimsFromText sets requiresPatch for compat-patch language", () => {
  const claims = extractClaimsFromText(
    "Using these two mods together requires a compatibility patch for OptiFine."
  );

  const patchClaim = claims.find((c) => c.requiresPatch);
  assert.ok(patchClaim, "Expected requiresPatch=true");
  assert.equal(patchClaim!.verdict, "incompatible");
});

// ---------------------------------------------------------------------------
// Conflict resolution: disputed claims
// ---------------------------------------------------------------------------

test("flagDisputedClaims marks losing side as isDisputed and reduces its confidence", () => {
  const authorClaim: ExtractedCompatibilityClaim = {
    sourceProjectId: "cp_sodium",
    targetProjectId: "cp_optifine",
    verdict: "incompatible",
    confidence: 0.9,
    sourceKind: "modrinth_description",   // trust tier: "author" (priority 4)
    evidenceTitle: "Author description",
    snippet: "Not compatible with OptiFine.",
    matchedPattern: "not_compatible_with",
    claimAuthorKind: "author"
  };

  const userClaim: ExtractedCompatibilityClaim = {
    sourceProjectId: "cp_sodium",
    targetProjectId: "cp_optifine",
    verdict: "compatible",
    confidence: 0.75,
    sourceKind: "github_issue",           // trust tier: "community" (priority 2)
    evidenceTitle: "User report",
    snippet: "Works fine together in my setup.",
    matchedPattern: "works_with",
    claimAuthorKind: "user"
  };

  const resolved = flagDisputedClaims([authorClaim, userClaim]);

  const incompat = resolved.find((c) => c.verdict === "incompatible");
  const compat = resolved.find((c) => c.verdict === "compatible");

  // Author (tier 4) beats community (tier 2)
  assert.equal(incompat?.isDisputed, false, "Author claim should NOT be disputed");
  assert.equal(compat?.isDisputed, true, "User claim SHOULD be disputed");
  assert.ok((compat?.confidence ?? 1) < 0.75, "Disputed claim confidence should be reduced");
});

test("flagDisputedClaims: incompatible wins on equal trust tier tie-break", () => {
  const compatClaim: ExtractedCompatibilityClaim = {
    sourceProjectId: "cp_sodium",
    targetProjectId: "cp_optifine",
    verdict: "compatible",
    confidence: 0.80,
    sourceKind: "modrinth_description",
    evidenceTitle: "A",
    snippet: "Works with OptiFine.",
    matchedPattern: "works_with"
  };

  const incompatClaim: ExtractedCompatibilityClaim = {
    sourceProjectId: "cp_sodium",
    targetProjectId: "cp_optifine",
    verdict: "incompatible",
    confidence: 0.80,
    sourceKind: "modrinth_changelog",
    evidenceTitle: "B",
    snippet: "Not compatible with OptiFine.",
    matchedPattern: "not_compatible_with"
  };

  const resolved = flagDisputedClaims([compatClaim, incompatClaim]);

  // Same tier (both "author"), same confidence → incompatible wins
  const compat = resolved.find((c) => c.verdict === "compatible");
  assert.equal(compat?.isDisputed, true, "compatible should be disputed when tied");
});

test("flagDisputedClaims does not flag claims when there is no conflict", () => {
  const claim1: ExtractedCompatibilityClaim = {
    sourceProjectId: "cp_sodium",
    targetProjectId: "cp_optifine",
    verdict: "incompatible",
    confidence: 0.9,
    sourceKind: "modrinth_description",
    evidenceTitle: "A",
    snippet: "Not compatible with OptiFine.",
    matchedPattern: "not_compatible_with"
  };

  const claim2: ExtractedCompatibilityClaim = {
    sourceProjectId: "cp_lithium",
    targetProjectId: "cp_sodium",
    verdict: "compatible",
    confidence: 0.88,
    sourceKind: "github_issue",
    evidenceTitle: "B",
    snippet: "Lithium and Sodium work well together.",
    matchedPattern: "works_well_with"
  };

  const resolved = flagDisputedClaims([claim1, claim2]);

  assert.ok(resolved.every((c) => !c.isDisputed), "No claims should be disputed when no conflict");
});

// ---------------------------------------------------------------------------
// Source config / registry
// ---------------------------------------------------------------------------

test("DEFAULT_SOURCE_CONFIG enables API sources and disables scraping sources", () => {
  assert.equal(DEFAULT_SOURCE_CONFIG.modrinth_description, true);
  assert.equal(DEFAULT_SOURCE_CONFIG.modrinth_changelog, true);
  assert.equal(DEFAULT_SOURCE_CONFIG.github_issue, true);
  assert.equal(DEFAULT_SOURCE_CONFIG.github_release, true);
  assert.equal(DEFAULT_SOURCE_CONFIG.github_readme, true);
  // Scraping sources should be off by default
  assert.equal(DEFAULT_SOURCE_CONFIG.linked_wiki, false);
  assert.equal(DEFAULT_SOURCE_CONFIG.linked_homepage, false);
});

test("ingestFromAllSources respects source config disabling github_issue", async () => {
  const platform = createPhase1Platform();

  // Run with github_issue disabled and fixture fallback disabled
  const result = await platform.evidenceSources.ingestFromAllSources({
    useFixtureFallback: false,
    sourceConfig: {
      modrinth_description: false,
      modrinth_changelog: false,
      curseforge_description: false,
      curseforge_changelog: false,
      github_issue: false,
      github_release: false,
      github_readme: false,
      github_wiki: false,
      linked_wiki: false,
      linked_homepage: false
    }
  });

  // With all sources disabled and no fixture fallback, no evidence should be produced
  assert.equal(result.githubIssuesFound, 0);
  assert.equal(result.total, 0);
});

// ---------------------------------------------------------------------------
// Fetch cache
// ---------------------------------------------------------------------------

test("EvidenceFetchCache.isUnchanged returns true for matching hash and increments hits", () => {
  const cache = new EvidenceFetchCache();
  const url = "https://modrinth.com/mod/sodium";
  const hash = "abc123";

  cache.record(url, hash, "success");

  assert.equal(cache.isUnchanged(url, hash), true);
  assert.equal(cache.hits, 1);
  assert.equal(cache.isUnchanged(url, "different_hash"), false);
});

test("EvidenceFetchCache round-trips through JSON serialization", () => {
  const original = new EvidenceFetchCache();
  original.record("https://example.com/a", "hash1", "success");
  original.record("https://example.com/b", "hash2", "skipped");

  const restored = EvidenceFetchCache.fromJSON(original.toJSON());

  assert.equal(restored.size, 2);
  assert.equal(restored.get("https://example.com/a")?.contentHash, "hash1");
  assert.equal(restored.get("https://example.com/b")?.extractionStatus, "skipped");
});

// ---------------------------------------------------------------------------
// claimAuthorKind propagation
// ---------------------------------------------------------------------------

test("extractCompatibilityClaimsFromText inherits claimAuthorKind from SourceDocument", () => {
  const document: SourceDocument = {
    sourceProjectId: "cp_sodium",
    sourceKind: "github_release",
    title: "Sodium v2.1 release",
    text: "This version is not compatible with OptiFine.",
    claimAuthorKind: "author"
  };

  const claims = extractCompatibilityClaimsFromText(document, projects);
  assert.ok(claims.length > 0);
  assert.equal(claims[0]!.claimAuthorKind, "author");
});

test("extractCompatibilityClaimsFromText infers claimAuthorKind from sourceKind when not provided", () => {
  const document: SourceDocument = {
    sourceProjectId: "cp_sodium",
    sourceKind: "github_issue",
    title: "User bug report",
    text: "Sodium and OptiFine crash on world load. OptiFine is incompatible with Sodium."
  };

  const claims = extractCompatibilityClaimsFromText(document, projects);
  // github_issue → community trust tier → "user"
  assert.ok(claims.every((c) => c.claimAuthorKind === "user"));
});

// ---------------------------------------------------------------------------
// generateRulesFromEvidence: constraints appear in rule summary
// ---------------------------------------------------------------------------

test("generateRulesFromEvidence includes fixedInVersion in rule summary", () => {
  const platform = createPhase1Platform();

  const rules = platform.evidenceSources.generateRulesFromEvidence([], [
    {
      projectId: "cp_sodium",
      source: "modrinth_changelog",
      title: "Sodium 2.0 changelog",
      content: "Fixed OptiFine incompatibility.",
      linkedProjects: ["cp_sodium", "cp_optifine"],
      verdict: "incompatible",
      confidence: 0.50,
      claims: [
        {
          sourceProjectId: "cp_sodium",
          targetProjectId: "cp_optifine",
          verdict: "incompatible",
          confidence: 0.50,
          sourceKind: "modrinth_changelog",
          evidenceTitle: "Sodium 2.0 changelog",
          snippet: "The crash was fixed in version 2.0.",
          matchedPattern: "fixed_in_version",
          fixedInVersion: "2.0"
        }
      ]
    }
  ]);

  assert.equal(rules.length, 1);
  assert.ok(rules[0]!.summary.includes("2.0"), "Rule summary should mention fixedInVersion");
});

test("generateRulesFromEvidence includes loaderConstraint in rule summary", () => {
  const platform = createPhase1Platform();

  const rules = platform.evidenceSources.generateRulesFromEvidence([], [
    {
      projectId: "cp_sodium",
      source: "github_readme",
      title: "Sodium README",
      content: "Incompatible on Forge.",
      linkedProjects: ["cp_sodium", "cp_optifine"],
      verdict: "incompatible",
      confidence: 0.82,
      claims: [
        {
          sourceProjectId: "cp_sodium",
          targetProjectId: "cp_optifine",
          verdict: "incompatible",
          confidence: 0.82,
          sourceKind: "github_readme",
          evidenceTitle: "Sodium README",
          snippet: "Incompatible only on Forge.",
          matchedPattern: "loader_specific_incompatible",
          loaderConstraint: "forge"
        }
      ]
    }
  ]);

  assert.equal(rules.length, 1);
  assert.ok(rules[0]!.summary.includes("forge"), "Rule summary should mention loader");
});

test("ingestFromAllSources reuses GitHub repository discovery across GitHub sources", async () => {
  const platform = createPhase1Platform();
  const originalFetch = globalThis.fetch;
  const originalBudget = process.env.GITHUB_SEARCH_QUERY_BUDGET;
  let modrinthProjectFetches = 0;

  process.env.GITHUB_SEARCH_QUERY_BUDGET = "100";
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.includes("api.modrinth.com/v2/project/")) {
      modrinthProjectFetches++;
      return new Response(JSON.stringify({
        issues_url: "https://github.com/example/mod/issues",
        source_url: "https://github.com/example/mod"
      }), { status: 200 });
    }
    if (url.includes("api.github.com/search/issues")) {
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }
    if (url.includes("api.github.com/repos/example/mod/releases")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (url.includes("api.github.com/repos/example/mod/readme")) {
      return new Response(JSON.stringify({}), { status: 404 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }) as typeof fetch;

  try {
    const result = await platform.evidenceSources.ingestFromAllSources({
      useFixtureFallback: false,
      sourceConfig: {
        modrinth_description: false,
        modrinth_changelog: false,
        curseforge_description: false,
        curseforge_changelog: false,
        github_issue: true,
        github_release: true,
        github_readme: true,
        linked_wiki: false
      }
    });

    assert.equal(modrinthProjectFetches, 2);
    assert.ok(result.githubIssueSearchQueriesAttempted > 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBudget === undefined) delete process.env.GITHUB_SEARCH_QUERY_BUDGET;
    else process.env.GITHUB_SEARCH_QUERY_BUDGET = originalBudget;
  }
});

test("ingestModDescriptionEvidence resolves CurseForge IDs from Modrinth mappings", async () => {
  const platform = createPhase1Platform();
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.CURSEFORGE_API_KEY;

  platform.repository.canonicalProjects.clear();
  platform.repository.sourceMappings.clear();
  platform.repository.canonicalProjects.set("cp_sodium", {
    projectId: "cp_sodium",
    slug: "sodium",
    displayName: "Sodium",
    aliases: ["sodium"]
  });
  platform.repository.canonicalProjects.set("cp_optifine", {
    projectId: "cp_optifine",
    slug: "optifine",
    displayName: "OptiFine",
    aliases: ["optifine"]
  });
  platform.repository.sourceMappings.set("modrinth:AbcSodium", {
    sourceName: "modrinth",
    sourceProjectId: "AbcSodium",
    canonicalProjectId: "cp_sodium"
  });

  process.env.CURSEFORGE_API_KEY = "test-key";
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.includes("api.modrinth.com/v2/project/AbcSodium/version")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (url.includes("api.modrinth.com/v2/project/AbcSodium")) {
      return new Response(JSON.stringify({
        title: "Sodium",
        slug: "sodium",
        description: "",
        body: ""
      }), { status: 200 });
    }
    if (url.includes("api.curseforge.com/v1/mods/search")) {
      return new Response(JSON.stringify({
        data: [{ id: 123, name: "Sodium", slug: "sodium" }]
      }), { status: 200 });
    }
    if (url.includes("api.curseforge.com/v1/mods/123/description")) {
      return new Response(JSON.stringify({
        data: "<p>Sodium is incompatible with OptiFine.</p>"
      }), { status: 200 });
    }
    if (url.includes("api.curseforge.com/v1/mods/123/files")) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }) as typeof fetch;

  try {
    const evidence = await platform.evidenceSources.ingestModDescriptionEvidence({
      useFixtureFallback: false
    });

    assert.ok(evidence.some((entry) => entry.source === "curseforge_description"));
    assert.ok(evidence.some((entry) =>
      entry.claims?.some((claim) =>
        claim.sourceProjectId === "cp_sodium" &&
        claim.targetProjectId === "cp_optifine" &&
        claim.verdict === "incompatible"
      )
    ));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.CURSEFORGE_API_KEY;
    else process.env.CURSEFORGE_API_KEY = originalApiKey;
  }
});
