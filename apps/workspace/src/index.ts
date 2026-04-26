import { createLogger } from "@modcompat/observability";
import { createPhase1Platform } from "@modcompat/platform-core";

const logger = createLogger("workspace");
const platform = createPhase1Platform();
const session = platform.auth.createSession();
const workspace = platform.workspace.createWorkspace({
  organizationId: session.organization.organizationId,
  name: "Phase 1 Imports",
  slug: "phase-1-imports"
});
const project = platform.workspace.createProject({
  workspaceId: workspace.workspaceId,
  name: "Resolver Validation Pack",
  slug: "resolver-validation-pack"
});

logger.info("Workspace service Phase 1 ready", {
  organizationId: session.organization.organizationId,
  seededWorkspaceId: workspace.workspaceId,
  seededProjectId: project.projectId,
  responsibilities: ["organizations", "memberships", "workspaces", "projects", "api_keys"]
});
