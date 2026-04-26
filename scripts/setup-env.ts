#!/usr/bin/env node
/**
 * Securely set POSTGRES_URL without exposing password in command history
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import readline from "readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer);
    });
  });
}

function passwordQuestion(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    let password = "";
    process.stdin.on("data", (ch) => {
      ch = ch.toString("utf8");
      if (ch === "\n" || ch === "\r" || ch === "\u0004") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\n");
        resolve(password);
      } else if (ch === "\u0003") {
        process.exit();
      } else if (ch === "\u007f") {
        password = password.slice(0, -1);
      } else {
        password += ch;
      }
    });
  });
}

function upsertEnvValue(filePath: string, key: string, value: string) {
  const line = `${key}=${value}`;
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const lines = existing ? existing.split(/\r?\n/) : [];
  const index = lines.findIndex((entry) => entry.startsWith(`${key}=`));

  if (index >= 0) {
    lines[index] = line;
  } else {
    if (lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("");
    }
    lines.push(line);
  }

  writeFileSync(filePath, `${lines.join("\n").replace(/\n+$/u, "")}\n`, "utf8");
}

async function setup() {
  console.log("=".repeat(60));
  console.log("PostgreSQL Connection Setup");
  console.log("=".repeat(60) + "\n");
  console.log(
    "Use the shared/remote Postgres URL you want the offline and ground-truth pipelines to persist to by default.\n"
  );

  const host = await question("PostgreSQL Host [localhost]: ");
  const port = await question("PostgreSQL Port [5432]: ");
  const username = await question("PostgreSQL Username [postgres]: ");
  const password = await passwordQuestion("PostgreSQL Password: ");
  const database = await question("PostgreSQL Database [modcompat]: ");
  const saveToEnv = await question("Write POSTGRES_URL into .env now? [Y/n]: ");

  const finalHost = host || "localhost";
  const finalPort = port || "5432";
  const finalUsername = username || "postgres";
  const finalDatabase = database || "modcompat";

  const connectionString = `postgresql://${finalUsername}:${password}@${finalHost}:${finalPort}/${finalDatabase}`;
  const envPath = resolve(".env");

  console.log("\n" + "=".repeat(60));
  console.log("✅ Configuration saved");
  console.log("=".repeat(60));
  if (!saveToEnv.trim() || saveToEnv.trim().toLowerCase() === "y") {
    upsertEnvValue(envPath, "POSTGRES_URL", connectionString);
    console.log(`\nSaved POSTGRES_URL to ${envPath}\n`);
  } else {
    console.log(
      `\nRun this to set the environment variable for this session:\n`
    );
    console.log(`$env:POSTGRES_URL = "${connectionString}"\n`);
  }

  rl.close();
}

setup().catch(console.error);
