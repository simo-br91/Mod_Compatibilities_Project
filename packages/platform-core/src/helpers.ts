import { createHash } from "node:crypto";

import type { AnalysisCounts } from "@modcompat/domain-models";
import type { Finding } from "@modcompat/api-contracts";

export function now(): string {
  return new Date().toISOString();
}

export function stableSortObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableSortObject(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableSortObject(nested)])
    );
  }

  return value;
}

export function stableHash(value: unknown): string {
  const content = JSON.stringify(stableSortObject(value));
  return createHash("sha256").update(content).digest("hex");
}

type LooseVersionToken = number | string;

function tokenizeLooseVersion(version: string): LooseVersionToken[] {
  return version
    .toLowerCase()
    .match(/[0-9]+|[a-z]+/g)
    ?.map((token) => (/^[0-9]+$/.test(token) ? Number(token) : token)) ?? [];
}

export function compareLooseVersions(left: string, right: string): number {
  const leftTokens = tokenizeLooseVersion(left);
  const rightTokens = tokenizeLooseVersion(right);
  const length = Math.max(leftTokens.length, rightTokens.length);

  for (let index = 0; index < length; index += 1) {
    const leftToken = leftTokens[index];
    const rightToken = rightTokens[index];

    if (leftToken === undefined && rightToken === undefined) {
      return 0;
    }

    if (leftToken === undefined) {
      return -1;
    }

    if (rightToken === undefined) {
      return 1;
    }

    if (typeof leftToken === "number" && typeof rightToken === "number") {
      if (leftToken !== rightToken) {
        return leftToken - rightToken;
      }
      continue;
    }

    if (typeof leftToken === "number") {
      return 1;
    }

    if (typeof rightToken === "number") {
      return -1;
    }

    const comparison = leftToken.localeCompare(rightToken);
    if (comparison !== 0) {
      return comparison;
    }
  }

  return left.localeCompare(right);
}

export function isVersionWithinRange(
  version: string,
  minVersion?: string,
  maxVersion?: string
): boolean {
  if (minVersion && compareLooseVersions(version, minVersion) < 0) {
    return false;
  }

  if (maxVersion && compareLooseVersions(version, maxVersion) > 0) {
    return false;
  }

  return true;
}

export function countBySeverity(findings: Finding[]): AnalysisCounts {
  const counts: AnalysisCounts = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0
  };

  for (const finding of findings) {
    counts[finding.severity] += 1;
  }

  return counts;
}
