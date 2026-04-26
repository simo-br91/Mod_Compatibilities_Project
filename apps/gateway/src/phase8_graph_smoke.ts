process.env.POSTGRES_URL = "";

const { buildGatewayApp } = await import("./app.ts");

const app = buildGatewayApp();
const demo = app.handlers.getDemoFlow();

console.log(
  JSON.stringify({
    service: app.config.serviceName,
    analysisId: demo.analysis.analysisId,
    findingCount: demo.findings.length,
    graphNodeCount: demo.graph?.nodes.length ?? 0,
    graphEdgeCount: demo.graph?.edges.length ?? 0,
    simulationStatus: demo.simulationRun?.status ?? "missing"
  })
);
