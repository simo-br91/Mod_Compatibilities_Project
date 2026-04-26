import { createLogger } from "@modcompat/observability";
import { createPhase1Platform } from "@modcompat/platform-core";

export interface NotificationApp {
  routes: Array<{ method: "GET" | "POST"; path: string; summary: string }>;
  handlers: {
    createWebhook(input: Parameters<ReturnType<typeof createPhase1Platform>["notifications"]["registerWebhook"]>[0]): ReturnType<ReturnType<typeof createPhase1Platform>["notifications"]["registerWebhook"]>;
    listWebhooks(): ReturnType<ReturnType<typeof createPhase1Platform>["notifications"]["listWebhooks"]>;
    listDeliveries(analysisId: string): ReturnType<ReturnType<typeof createPhase1Platform>["notifications"]["listDeliveries"]>;
    getStatusCheck(analysisId: string): ReturnType<ReturnType<typeof createPhase1Platform>["notifications"]["getStatusCheck"]>;
  };
}

export function buildNotificationApp(): NotificationApp {
  const logger = createLogger("notification");
  const platform = createPhase1Platform();

  platform.notifications.registerWebhook({
    targetUrl: "https://example.invalid/webhooks/modcompat",
    eventTypes: ["analysis.completed"],
    secret: "demo-secret"
  });
  const demo = platform.createDemoFlow();

  const routes = [
    { method: "POST" as const, path: "/v1/webhooks", summary: "Register webhook" },
    { method: "GET" as const, path: "/v1/webhooks", summary: "List webhooks" },
    { method: "GET" as const, path: "/v1/analyses/:analysisId/webhook-deliveries", summary: "List webhook deliveries for an analysis" },
    { method: "GET" as const, path: "/v1/analyses/:analysisId/status-check", summary: "Get status check for an analysis" }
  ];

  logger.info("Notification service initialized", {
    routeCount: routes.length,
    deliveryCount: platform.notifications.listDeliveries(demo.analysis.analysisId).length
  });

  return {
    routes,
    handlers: {
      createWebhook(input) {
        return platform.notifications.registerWebhook(input);
      },
      listWebhooks() {
        return platform.notifications.listWebhooks();
      },
      listDeliveries(analysisId) {
        return platform.notifications.listDeliveries(analysisId);
      },
      getStatusCheck(analysisId) {
        return platform.notifications.getStatusCheck(analysisId);
      }
    }
  };
}

const app = buildNotificationApp();

console.log(
  JSON.stringify({
    service: "notification",
    status: "phase6-extended",
    routes: app.routes
  })
);
