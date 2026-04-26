import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ServiceConfig {
  serviceName: string;
  port: number;
  appEnv: string;
  logLevel: string;
}

let envLoaded = false;

function loadLocalEnvFile() {
  if (envLoaded) {
    return;
  }

  envLoaded = true;

  const envPath = resolve(import.meta.dirname, "../../../.env");
  if (!existsSync(envPath)) {
    return;
  }

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    const value = line
      .slice(separatorIndex + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .replace(/^'(.*)'$/, "$1");

    process.env[key] = value;
  }
}

export function loadServiceConfig(serviceName: string): ServiceConfig {
  loadLocalEnvFile();
  const normalizedServiceName = serviceName
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toUpperCase();
  const servicePort =
    process.env[`${normalizedServiceName}_HTTP_PORT`] ?? process.env.HTTP_PORT ?? "8080";

  return {
    serviceName,
    port: Number(servicePort),
    appEnv: process.env.APP_ENV ?? "development",
    logLevel: process.env.LOG_LEVEL ?? "info"
  };
}
