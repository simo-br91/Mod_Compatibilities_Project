import assert from "node:assert/strict";
import test from "node:test";

import {
  DEV_JWT_SECRET,
  GatewayAuthConfigurationError,
  assertGatewayAuthConfiguration,
  normalizeRedirectTarget,
  readGatewayOidcConfig,
  resolveJwtSecret,
  shouldAllowDemoAuth
} from "./auth-runtime.js";

test("demo auth is disabled by default in staging", () => {
  assert.equal(shouldAllowDemoAuth({ APP_ENV: "staging" }), false);
});

test("demo auth can be explicitly enabled for development sandboxes", () => {
  assert.equal(
    shouldAllowDemoAuth({ APP_ENV: "staging", ALLOW_DEMO_AUTH: "true" }),
    true
  );
});

test("placeholder OIDC values are treated as not configured", () => {
  assert.equal(
    readGatewayOidcConfig({
      OIDC_ISSUER_URL: "https://your-oidc-provider.example.com",
      OIDC_CLIENT_ID: "your-client-id",
      OIDC_CLIENT_SECRET: "your-client-secret",
      OIDC_REDIRECT_URI: "http://localhost:8080/auth/callback"
    }),
    null
  );
});

test("resolveJwtSecret returns the development secret only when demo auth is allowed", () => {
  assert.equal(resolveJwtSecret({ APP_ENV: "development" }), DEV_JWT_SECRET);
  assert.throws(
    () => resolveJwtSecret({ APP_ENV: "staging" }),
    GatewayAuthConfigurationError
  );
});

test("auth configuration requires OIDC when demo auth is disabled", () => {
  assert.throws(
    () =>
      assertGatewayAuthConfiguration({
        APP_ENV: "staging",
        JWT_SECRET: "a-secure-jwt-secret-with-more-than-thirty-two-chars"
      }),
    GatewayAuthConfigurationError
  );
});

test("normalizeRedirectTarget only allows same-origin or relative redirects", () => {
  const webBaseUrl = "https://app.modcompat.example";

  assert.equal(
    normalizeRedirectTarget("/dashboard", webBaseUrl, "/sign-in"),
    "/dashboard"
  );
  assert.equal(
    normalizeRedirectTarget(
      "https://app.modcompat.example/projects/demo",
      webBaseUrl,
      "/sign-in"
    ),
    "https://app.modcompat.example/projects/demo"
  );
  assert.equal(
    normalizeRedirectTarget(
      "https://evil.example/phish",
      webBaseUrl,
      "/sign-in"
    ),
    "/sign-in"
  );
});
