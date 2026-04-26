import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";

import { createPhase1Platform } from "./index.js";

const DEFAULT_POSTGRES_SMOKE_URL = "postgres://postgres:postgres@localhost:5432/modcompat";

interface TemporaryDatabase {
  adminPool: Pool;
  databaseName: string;
  connectionString: string;
}

async function tryCreateTempDatabase(baseConnectionString: string): Promise<TemporaryDatabase> {
  const adminPool = new Pool({ connectionString: baseConnectionString });

  try {
    const databaseName = `test_modcompat_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    await adminPool.query(`CREATE DATABASE ${databaseName}`);

    const tempConnectionString = baseConnectionString.replace(
      /\/[^/]*$/,
      `/${databaseName}`
    );

    return {
      adminPool,
      databaseName,
      connectionString: tempConnectionString
    };
  } catch (error) {
    await adminPool.end();
    throw error;
  }
}

async function cleanupTempDatabase(
  adminPool: Pool,
  databaseName: string
): Promise<void> {
  try {
    await adminPool.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
  } finally {
    await adminPool.end();
  }
}

function describeConnectionError(error: unknown): string {
  if (error instanceof Error) {
    if (error.message.includes("ECONNREFUSED")) {
      return "Postgres server is not running";
    }
    if (error.message.includes("password")) {
      return "Invalid Postgres credentials";
    }
    return error.message;
  }
  return String(error);
}

test("Postgres persists and rehydrates knowledge snapshots with all related data", async (t) => {
  const previousPostgresUrl = process.env.POSTGRES_URL;
  const baseConnectionString = previousPostgresUrl ?? DEFAULT_POSTGRES_SMOKE_URL;

  let adminPool: Pool | undefined;
  let databaseName: string | undefined;

  try {
    // Create a temporary database for this test
    try {
      const temporaryDatabase = await tryCreateTempDatabase(baseConnectionString);
      adminPool = temporaryDatabase.adminPool;
      databaseName = temporaryDatabase.databaseName;
      process.env.POSTGRES_URL = temporaryDatabase.connectionString;
    } catch (error) {
      t.skip(`Postgres snapshot persistence test skipped: ${describeConnectionError(error)}`);
      return;
    }

    // Build and promote a snapshot
    const source = createPhase1Platform();
    const { snapshot } = source.knowledgeSynthesis.buildAndPromoteSnapshot({
      createdBy: "test-actor",
      versionLabel: "test-snapshot-v1"
    });

    assert.ok(snapshot.snapshotId, "Snapshot should have an ID");
    assert.equal(snapshot.status, "promoted", "Snapshot should be promoted");

    // Persist the snapshot and all related data
    await source.persistence.persistKnowledgeSnapshot(snapshot.snapshotId);

    // Also persist all related records
    const claims =
      source.repository.promotedCompatibilityClaimsBySnapshot.get(snapshot.snapshotId) ?? [];
    for (const claimId of claims) {
      await source.persistence.persistPromotedCompatibilityClaim(claimId);
    }

    const pairwiseIds =
      source.repository.pairwiseCompatibilityBySnapshot.get(snapshot.snapshotId) ?? [];
    for (const recordId of pairwiseIds) {
      await source.persistence.persistPairwiseCompatibilityRecord(recordId);
    }

    const fragmentIds =
      source.repository.fragmentCompatibilityBySnapshot.get(snapshot.snapshotId) ?? [];
    for (const recordId of fragmentIds) {
      await source.persistence.persistFragmentCompatibilityRecord(recordId);
    }

    const signatureIds =
      source.repository.technicalConflictSignaturesBySnapshot.get(snapshot.snapshotId) ?? [];
    for (const signatureId of signatureIds) {
      await source.persistence.persistTechnicalConflictSignature(signatureId);
    }

    // Close the source platform connection
    const sourcePool = source.persistence["pool"];
    if (sourcePool) {
      await sourcePool.end();
    }

    // Create a fresh platform instance and rehydrate the snapshot
    const target = createPhase1Platform();
    await target.persistence.hydrateKnowledgeSnapshotByVersion(snapshot.version);

    // Verify the snapshot was rehydrated
    const rehydratedSnapshot = target.repository.knowledgeSnapshots.get(snapshot.snapshotId);
    assert.ok(rehydratedSnapshot, "Snapshot should be rehydrated from database");
    assert.equal(rehydratedSnapshot.version, snapshot.version);
    assert.equal(rehydratedSnapshot.status, "promoted");

    // Verify related data was rehydrated
    const rehydratedClaims =
      target.repository.promotedCompatibilityClaimsBySnapshot.get(snapshot.snapshotId) ?? [];
    assert.equal(
      rehydratedClaims.length,
      claims.length,
      "All claims should be rehydrated"
    );

    const rehydratedPairwise =
      target.repository.pairwiseCompatibilityBySnapshot.get(snapshot.snapshotId) ?? [];
    assert.equal(
      rehydratedPairwise.length,
      pairwiseIds.length,
      "All pairwise records should be rehydrated"
    );

    const rehydratedFragments =
      target.repository.fragmentCompatibilityBySnapshot.get(snapshot.snapshotId) ?? [];
    assert.equal(
      rehydratedFragments.length,
      fragmentIds.length,
      "All fragment records should be rehydrated"
    );

    const rehydratedSignatures =
      target.repository.technicalConflictSignaturesBySnapshot.get(snapshot.snapshotId) ?? [];
    assert.equal(
      rehydratedSignatures.length,
      signatureIds.length,
      "All signatures should be rehydrated"
    );

    // Close the target platform connection
    const targetPool = target.persistence["pool"];
    if (targetPool) {
      await targetPool.end();
    }
  } finally {
    // Cleanup
    if (adminPool && databaseName) {
      await cleanupTempDatabase(adminPool, databaseName);
    }

    if (previousPostgresUrl === undefined) {
      delete process.env.POSTGRES_URL;
    } else {
      process.env.POSTGRES_URL = previousPostgresUrl;
    }
  }
});

test("Active knowledge snapshot can be retrieved from Postgres after restart", async (t) => {
  const previousPostgresUrl = process.env.POSTGRES_URL;
  const baseConnectionString = previousPostgresUrl ?? DEFAULT_POSTGRES_SMOKE_URL;

  let adminPool: Pool | undefined;
  let databaseName: string | undefined;

  try {
    try {
      const temporaryDatabase = await tryCreateTempDatabase(baseConnectionString);
      adminPool = temporaryDatabase.adminPool;
      databaseName = temporaryDatabase.databaseName;
      process.env.POSTGRES_URL = temporaryDatabase.connectionString;
    } catch (error) {
      t.skip(`Postgres active snapshot test skipped: ${describeConnectionError(error)}`);
      return;
    }

    // Build and promote a snapshot
    const source = createPhase1Platform();
    const { snapshot } = source.knowledgeSynthesis.buildAndPromoteSnapshot({
      createdBy: "test-actor",
      versionLabel: "active-snapshot-v1"
    });

    // Persist the snapshot
    await source.persistence.persistKnowledgeSnapshot(snapshot.snapshotId);

    // Close source connection
    const sourcePool = source.persistence["pool"];
    if (sourcePool) {
      await sourcePool.end();
    }

    // Create fresh instance and check if active snapshot is retrievable
    const target = createPhase1Platform();
    await target.persistence.hydrateLatestPromotedKnowledgeSnapshot();

    const activeSnapshot = target.knowledgeSynthesis.getActiveSnapshot();
    assert.ok(activeSnapshot, "Active snapshot should be rehydrated from database");
    assert.equal(activeSnapshot.version, snapshot.version);
    assert.equal(activeSnapshot.status, "promoted");

    // Close target connection
    const targetPool = target.persistence["pool"];
    if (targetPool) {
      await targetPool.end();
    }
  } finally {
    // Cleanup
    if (adminPool && databaseName) {
      await cleanupTempDatabase(adminPool, databaseName);
    }

    if (previousPostgresUrl === undefined) {
      delete process.env.POSTGRES_URL;
    } else {
      process.env.POSTGRES_URL = previousPostgresUrl;
    }
  }
});
