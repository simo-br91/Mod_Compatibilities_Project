import { fileURLToPath } from "node:url";

import { Client, type WorkflowHandle } from "@temporalio/client";
import { Context } from "@temporalio/activity";
import { NativeConnection, Worker } from "@temporalio/worker";

import type {
  CreateAnalysisHttpRequest,
  TemporalAnalysisWorkflowResult
} from "./contracts.js";

interface RuntimeLogger {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
}

interface TemporalExecutionRuntimeOptions {
  address?: string;
  namespace?: string;
  taskQueue?: string;
  logger: RuntimeLogger;
  executeAnalysis(
    payload: CreateAnalysisHttpRequest,
    signal?: AbortSignal
  ): Promise<TemporalAnalysisWorkflowResult>;
}

export interface TemporalExecutionHandle {
  result(): Promise<TemporalAnalysisWorkflowResult>;
  cancel(): Promise<void>;
}

export interface TemporalExecutionRuntime {
  readonly enabled: boolean;
  startAnalysisRequest(
    idempotencyKey: string,
    payload: CreateAnalysisHttpRequest
  ): Promise<TemporalExecutionHandle>;
  cancelAnalysisRequest(idempotencyKey: string): Promise<void>;
  getStatus(): {
    enabled: boolean;
    ready: boolean;
    taskQueue?: string;
    namespace?: string;
    address?: string;
    lastError?: string;
  };
  shutdown(): Promise<void>;
}

export function createTemporalExecutionRuntime(
  options: TemporalExecutionRuntimeOptions
): TemporalExecutionRuntime | undefined {
  const address = options.address?.trim();
  if (!address) {
    return undefined;
  }

  const namespace = options.namespace?.trim() || "default";
  const taskQueue = options.taskQueue?.trim() || "analysis-orchestrator";
  const handles = new Map<string, WorkflowHandle>();

  let ready = false;
  let lastError: string | undefined;
  let client: Client | undefined;
  let connection: NativeConnection | undefined;
  let worker: Worker | undefined;
  let workerRunPromise: Promise<void> | undefined;

  const startPromise = (async () => {
    connection = await NativeConnection.connect({ address });
    client = new Client({
      connection,
      namespace
    });

    worker = await Worker.create({
      connection,
      namespace,
      taskQueue,
      workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
      activities: {
        executeAnalysisActivity: async (
          payload: CreateAnalysisHttpRequest
        ): Promise<TemporalAnalysisWorkflowResult> => {
          const activityContext = Context.current();
          const controller = new AbortController();
          const abortListener = () => controller.abort(activityContext.cancellationSignal.reason);
          const heartbeatTimer = setInterval(() => {
            activityContext.heartbeat({ status: "running" });
          }, 1000);

          activityContext.cancellationSignal.addEventListener("abort", abortListener, {
            once: true
          });

          try {
            activityContext.heartbeat({ status: "started" });
            const result = await options.executeAnalysis(payload, controller.signal);
            activityContext.heartbeat({
              status: "completed",
              analysisId: result.analysisId
            });
            return result;
          } catch (error) {
            if (activityContext.cancellationSignal.aborted) {
              await activityContext.cancelled;
            }
            throw error;
          } finally {
            clearInterval(heartbeatTimer);
            activityContext.cancellationSignal.removeEventListener("abort", abortListener);
          }
        }
      }
    });

    workerRunPromise = worker.run().catch((error) => {
      lastError = error instanceof Error ? error.message : String(error);
      ready = false;
      options.logger.error("Temporal worker stopped unexpectedly", {
        error: lastError
      });
      throw error;
    });

    ready = true;
    options.logger.info("Temporal runtime connected", {
      address,
      namespace,
      taskQueue
    });
  })().catch((error) => {
    lastError = error instanceof Error ? error.message : String(error);
    options.logger.error("Temporal runtime initialization failed", {
      address,
      namespace,
      taskQueue,
      error: lastError
    });
    throw error;
  });

  return {
    enabled: true,
    async startAnalysisRequest(idempotencyKey, payload) {
      await startPromise;

      if (!client) {
        throw new Error("Temporal client is not available.");
      }

      const workflowId = `analysis-request-${idempotencyKey}`;
      const handle = await client.workflow.start("analysisRequestWorkflow", {
        workflowId,
        taskQueue,
        args: [payload]
      });
      handles.set(idempotencyKey, handle);

      return {
        async result() {
          return handle.result();
        },
        async cancel() {
          await handle.cancel();
        }
      };
    },
    async cancelAnalysisRequest(idempotencyKey) {
      await startPromise;

      const workflowId = `analysis-request-${idempotencyKey}`;
      const handle =
        handles.get(idempotencyKey) ??
        client?.workflow.getHandle(workflowId);

      if (!handle) {
        throw new Error(`Temporal workflow handle not found for ${idempotencyKey}`);
      }

      await handle.cancel();
    },
    getStatus() {
      return {
        enabled: true,
        ready,
        taskQueue,
        namespace,
        address,
        lastError
      };
    },
    async shutdown() {
      if (worker) {
        worker.shutdown();
      }

      if (workerRunPromise) {
        try {
          await workerRunPromise;
        } catch {
          // Worker failure was already reported through logger/status.
        }
      }

      if (connection) {
        await connection.close();
      }
    }
  };
}
