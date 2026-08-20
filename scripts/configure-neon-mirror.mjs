#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();
const paperclipHome = process.env.PAPERCLIP_HOME || join(home, ".paperclip");
const instanceId = process.env.PAPERCLIP_INSTANCE_ID || "default";
const stateDir = join(paperclipHome, "instances", instanceId, "data", "neon-mirror");
const credentialsPath = join(stateDir, "credentials.env");

mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const url = execFileSync("neon", [
  "connection-string", "main",
  "--project-id", "muddy-scene-99836673",
  "--database-name", "neondb",
  "--endpoint-type", "read_write",
  "--ssl", "require",
], { encoding: "utf8" }).trim();

if (!url.startsWith("postgres")) throw new Error("Neon CLI did not return a PostgreSQL connection string");
writeFileSync(credentialsPath, `PAPERCLIP_MIRROR_NEON_URL=${JSON.stringify(url)}\n`, { mode: 0o600 });
chmodSync(credentialsPath, 0o600);
console.log(`Wrote protected Neon mirror credentials to ${credentialsPath}`);
