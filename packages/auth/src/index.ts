export interface AuthContext {
  subjectId: string;
  organizationId?: string;
  workspaceIds: string[];
  roles: string[];
  scopes: string[];
}

export interface Authenticator {
  authenticate(token: string): Promise<AuthContext>;
}

export class StaticTokenAuthenticator implements Authenticator {
  constructor(private readonly sessions: Record<string, AuthContext>) {}

  async authenticate(token: string): Promise<AuthContext> {
    const session = this.sessions[token];

    if (!session) {
      throw new Error("Invalid or expired token");
    }

    return session;
  }
}

export function createDemoAuthenticator(): Authenticator {
  return new StaticTokenAuthenticator({
    "demo-token": {
      subjectId: "usr_demo",
      organizationId: "org_demo",
      workspaceIds: ["wrk_demo"],
      roles: ["owner"],
      scopes: [
        "workspace:read",
        "workspace:write",
        "project:read",
        "project:write",
        "analysis:read",
        "analysis:write"
      ]
    }
  });
}
