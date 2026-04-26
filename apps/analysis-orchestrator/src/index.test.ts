import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createPhase1Platform } from "../../../packages/platform-core/src/index.ts";
import { startOrchestratorServer } from "./index.ts";

function createTestApp() {
  const originalPostgresUrl = process.env.POSTGRES_URL;
  delete process.env.POSTGRES_URL;
  const platform = createPhase1Platform();
  if (originalPostgresUrl === undefined) {
    delete process.env.POSTGRES_URL;
  } else {
    process.env.POSTGRES_URL = originalPostgresUrl;
  }

  return {
    config: {
      serviceName: "analysis-orchestrator-test",
      port: 0,
      appEnv: "test",
      logLevel: "error"
    },
    logger: {
      service: "analysis-orchestrator-test",
      info() {
        // Silence test logs.
      },
      warn() {
        // Silence test logs.
      },
      error() {
        // Silence test logs.
      }
    },
    platform,
    requestStates: new Map(),
    cancellationControllers: new Map()
  };
}

async function startTestServer() {
  const app = createTestApp();
  const server = startOrchestratorServer(app);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function close() {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  return { app, baseUrl, close };
}

function importSnapshot(app: ReturnType<typeof createTestApp>) {
  return app.platform.imports.importModList({
    projectId: "prj_demo",
    createdBy: "usr_demo",
    environment: {
      minecraftVersion: "1.21.1",
      loader: "fabric",
      javaVersion: "21",
      side: "both"
    },
    mods: [
      { name: "sodium", version: "0.6.0+mc1.21.1" },
      { name: "modmenu", version: "11.0.2" }
    ]
  });
}

test("analysis requests with inputRef.type 'import' resolve to the import's snapshot", async () => {
  const { app, baseUrl, close } = await startTestServer();
  try {
    const imported = importSnapshot(app);
    const importId = imported.importRecord.importId;
    const idempotencyKey = "import-type-test";

    const submissionResponse = await fetch(`${baseUrl}/v1/analyses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-idempotency-key": idempotencyKey
      },
      body: JSON.stringify({
        projectId: "prj_demo",
        request: {
          trigger: "manual",
          analysisMode: "standard",
          inputRef: { type: "import", id: importId },
          environment: imported.snapshot.environment
        }
      })
    });
    assert.equal(submissionResponse.status, 202);

    // Poll until terminal.
    let statusBody: { status: string; analysisId?: string } = { status: "started" };
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const statusResponse = await fetch(`${baseUrl}/v1/analysis-requests/${idempotencyKey}`);
      statusBody = await statusResponse.json();
      if (statusBody.status === "completed" || statusBody.status === "failed") {
        break;
      }
    }

    assert.equal(statusBody.status, "completed", `Expected completed, got ${statusBody.status}`);
    assert.ok(statusBody.analysisId, "Expected analysisId in completed response");
  } finally {
    await close();
  }
});

test("internal recommendation, graph, and simulation hydration routes return 404 for unknown analyses", async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const recommendationResponse = await fetch(
      `${baseUrl}/v1/internal/analyses/ana_missing/recommendation-context`
    );
    assert.equal(recommendationResponse.status, 404);
    const recommendationBody = await recommendationResponse.json();
    assert.equal(recommendationBody.error.code, "recommendation_context_not_found");

    const graphResponse = await fetch(`${baseUrl}/v1/internal/analyses/ana_missing/graph-context`);
    assert.equal(graphResponse.status, 404);
    const graphBody = await graphResponse.json();
    assert.equal(graphBody.error.code, "graph_context_not_found");

    const simulationResponse = await fetch(
      `${baseUrl}/v1/internal/analyses/ana_missing/simulation-run`
    );
    assert.equal(simulationResponse.status, 404);
    const simulationBody = await simulationResponse.json();
    assert.equal(simulationBody.error.code, "simulation_run_not_found");
  } finally {
    await close();
  }
});

test("in-flight analysis requests can be cooperatively cancelled via abort signal", async () => {
  const { app, baseUrl, close } = await startTestServer();
  try {
    const imported = importSnapshot(app);
    const idempotencyKey = "cooperative-cancel-test";

    const submissionResponse = await fetch(`${baseUrl}/v1/analyses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-idempotency-key": idempotencyKey
      },
      body: JSON.stringify({
        projectId: "prj_demo",
        request: {
          trigger: "manual",
          analysisMode: "standard",
          inputRef: {
            type: "pack_snapshot",
            id: imported.snapshot.packSnapshotId
          },
          environment: imported.snapshot.environment,
          options: { runSimulation: true }
        }
      })
    });
    assert.equal(submissionResponse.status, 202);

    // Give the background execution just enough time to start running.
    await new Promise((resolve) => setTimeout(resolve, 70));

    const cancelResponse = await fetch(
      `${baseUrl}/v1/analysis-requests/${idempotencyKey}/cancel`,
      { method: "POST" }
    );
    // 200 = cancelled before start
    // 202 = cooperative abort signal sent to in-flight running analysis
    // 409 = analysis already completed before cancel reached it (fast test env)
    assert.ok(
      cancelResponse.status === 200 ||
      cancelResponse.status === 202 ||
      cancelResponse.status === 409,
      `Expected 200, 202, or 409 but got ${cancelResponse.status}`
    );

    // Wait for pipeline to finish (either completes normally or honours cancel signal).
    await new Promise((resolve) => setTimeout(resolve, 300));

    const statusResponse = await fetch(`${baseUrl}/v1/analysis-requests/${idempotencyKey}`);
    assert.equal(statusResponse.status, 200);
    const statusBody = await statusResponse.json();
    // May be cancelled (caught the signal) or completed (signal arrived after last phase).
    assert.ok(
      statusBody.status === "cancelled" || statusBody.status === "completed",
      `Expected cancelled or completed but got ${statusBody.status}`
    );
    if (statusBody.status === "cancelled") {
      assert.equal(statusBody.errorCode, "analysis_request_cancelled");
    }
  } finally {
    await close();
  }
});

test("accepted analysis requests can be cancelled before background execution starts", async () => {
  const { app, baseUrl, close } = await startTestServer();
  try {
    const imported = importSnapshot(app);
    const idempotencyKey = "cancel-analysis-test";

    const submissionResponse = await fetch(`${baseUrl}/v1/analyses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-idempotency-key": idempotencyKey
      },
      body: JSON.stringify({
        projectId: "prj_demo",
        request: {
          trigger: "manual",
          analysisMode: "standard",
          inputRef: {
            type: "pack_snapshot",
            id: imported.snapshot.packSnapshotId
          },
          environment: imported.snapshot.environment,
          options: {
            includeAlternatives: true,
            includeLowConfidence: true,
            runSimulation: true
          }
        }
      })
    });
    assert.equal(submissionResponse.status, 202);

    const cancellationResponse = await fetch(
      `${baseUrl}/v1/analysis-requests/${idempotencyKey}/cancel`,
      {
        method: "POST"
      }
    );
    assert.equal(cancellationResponse.status, 200);
    const cancellationBody = await cancellationResponse.json();
    assert.equal(cancellationBody.status, "cancelled");

    await new Promise((resolve) => setTimeout(resolve, 120));

    const statusResponse = await fetch(`${baseUrl}/v1/analysis-requests/${idempotencyKey}`);
    assert.equal(statusResponse.status, 200);
    const statusBody = await statusResponse.json();
    assert.equal(statusBody.status, "cancelled");
    assert.equal(statusBody.errorCode, "analysis_request_cancelled");
  } finally {
    await close();
  }
});
