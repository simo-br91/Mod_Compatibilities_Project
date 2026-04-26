export class GatewayAuthConfigurationError extends Error {
  readonly code = "gateway_auth_configuration_error" as const;

  constructor(message: string) {
    super(message);
    this.name = "GatewayAuthConfigurationError";
  }
}

export interface GatewayOidcConfig {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export const DEV_JWT_SECRET = "dev-only-insecure-jwt-secret-change-before-production";

function readEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function isPlaceholderValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.startsWith("your-") ||
    normalized.includes("example.com") ||
    normalized === "change-this-to-a-random-256-bit-secret-in-production"
  );
}

function readConfiguredEnvValue(
  env: NodeJS.ProcessEnv,
  key: string
): string | undefined {
  const value = readEnvValue(env, key);
  if (!value || isPlaceholderValue(value)) {
    return undefined;
  }
  return value;
}

export function getAppEnv(env: NodeJS.ProcessEnv = process.env): string {
  return (readEnvValue(env, "APP_ENV") ?? readEnvValue(env, "NODE_ENV") ?? "development")
    .toLowerCase();
}

export function isProductionLikeEnvironment(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const appEnv = getAppEnv(env);
  return appEnv === "production" || appEnv === "prod" || appEnv === "staging";
}

export function shouldAllowDemoAuth(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const configured = readEnvValue(env, "ALLOW_DEMO_AUTH")?.toLowerCase();
  if (configured) {
    if (TRUE_VALUES.has(configured)) {
      return true;
    }
    if (FALSE_VALUES.has(configured)) {
      return false;
    }
  }

  return !isProductionLikeEnvironment(env);
}

export function shouldUseSecureCookies(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return isProductionLikeEnvironment(env);
}

export function readGatewayOidcConfig(
  env: NodeJS.ProcessEnv = process.env
): GatewayOidcConfig | null {
  const issuerUrl = readConfiguredEnvValue(env, "OIDC_ISSUER_URL");
  const clientId = readConfiguredEnvValue(env, "OIDC_CLIENT_ID");
  const clientSecret = readConfiguredEnvValue(env, "OIDC_CLIENT_SECRET");
  const redirectUri = readConfiguredEnvValue(env, "OIDC_REDIRECT_URI");

  if (!issuerUrl || !clientId || !clientSecret || !redirectUri) {
    return null;
  }

  return { issuerUrl, clientId, clientSecret, redirectUri };
}

export function resolveJwtSecret(
  env: NodeJS.ProcessEnv = process.env
): string {
  const configuredSecret = readConfiguredEnvValue(env, "JWT_SECRET");
  if (configuredSecret) {
    return configuredSecret;
  }

  if (shouldAllowDemoAuth(env)) {
    return DEV_JWT_SECRET;
  }

  throw new GatewayAuthConfigurationError(
    "JWT_SECRET must be configured with a non-placeholder value when demo auth is disabled."
  );
}

export function assertGatewayAuthConfiguration(
  env: NodeJS.ProcessEnv = process.env
) {
  const demoAuthAllowed = shouldAllowDemoAuth(env);
  const oidc = readGatewayOidcConfig(env);
  const jwtSecret = resolveJwtSecret(env);

  if (!demoAuthAllowed && !oidc) {
    throw new GatewayAuthConfigurationError(
      "OIDC must be configured when demo auth is disabled. Set OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, and OIDC_REDIRECT_URI."
    );
  }

  if (isProductionLikeEnvironment(env) && jwtSecret === DEV_JWT_SECRET) {
    throw new GatewayAuthConfigurationError(
      "Production-like environments must not use the built-in development JWT secret."
    );
  }

  return {
    demoAuthAllowed,
    jwtSecret,
    oidcConfigured: Boolean(oidc)
  };
}

export function resolveWebBaseUrl(
  env: NodeJS.ProcessEnv = process.env
): string {
  return readEnvValue(env, "WEB_BASE_URL") ?? "http://localhost:3000";
}

export function isAllowedRedirectTarget(
  redirectTo: string,
  webBaseUrl: string
): boolean {
  if (!redirectTo) {
    return false;
  }

  if (redirectTo.startsWith("/")) {
    return !redirectTo.startsWith("//");
  }

  try {
    const target = new URL(redirectTo);
    const allowedBase = new URL(webBaseUrl);
    return target.origin === allowedBase.origin;
  } catch {
    return false;
  }
}

export function normalizeRedirectTarget(
  redirectTo: string | null | undefined,
  webBaseUrl: string,
  fallbackPath: string
): string {
  const candidate = redirectTo?.trim();
  if (candidate && isAllowedRedirectTarget(candidate, webBaseUrl)) {
    return candidate;
  }

  return fallbackPath;
}
