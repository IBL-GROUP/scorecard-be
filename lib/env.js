// Environment for the server.
//
// - Server settings (port, JWT secret, CORS) come from this repo's .env.
// - BigQuery settings (GCP_PROJECT_ID, BIGQUERY_LOCATION, GCP_SERVICE_ACCOUNT_BASE64,
//   GOOGLE_APPLICATION_CREDENTIALS) come from the same .env; if it has none, from
//   the file BQ_ENV_FILE names (only those keys are read from it).
// - Values are never logged.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

dotenv.config({ path: path.join(root, ".env") });

const BQ_KEYS = ["GCP_PROJECT_ID", "BIGQUERY_LOCATION", "GCP_SERVICE_ACCOUNT_BASE64", "GOOGLE_APPLICATION_CREDENTIALS"];

const ownBq = BQ_KEYS.some((k) => process.env[k]);
const bqEnvFile = ownBq ? path.join(root, ".env") : path.resolve(root, process.env.BQ_ENV_FILE || ".env");

function readBqSettings() {
  if (!ownBq && !fs.existsSync(bqEnvFile)) {
    throw new Error(`BigQuery settings not found: set GCP_* in .env, or BQ_ENV_FILE (${bqEnvFile})`);
  }
  const parsed = ownBq ? process.env : dotenv.parse(fs.readFileSync(bqEnvFile));
  const out = {};
  for (const k of BQ_KEYS) if (parsed[k]) out[k] = parsed[k];
  if (!out.GCP_SERVICE_ACCOUNT_BASE64 && !out.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error("BigQuery settings file has neither GCP_SERVICE_ACCOUNT_BASE64 nor GOOGLE_APPLICATION_CREDENTIALS");
  }
  // A relative key-file path is relative to the settings file, not to this repo.
  if (out.GOOGLE_APPLICATION_CREDENTIALS && !path.isAbsolute(out.GOOGLE_APPLICATION_CREDENTIALS)) {
    out.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(path.dirname(bqEnvFile), out.GOOGLE_APPLICATION_CREDENTIALS);
  }
  return out;
}

export const bqSettings = readBqSettings();
export const bqSettingsFile = bqEnvFile;

export const env = {
  port: Number(process.env.PORT) || 3005,
  corsOrigins: (process.env.CORS_ORIGIN || "http://localhost:5175")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  cacheTtlSeconds: Number(process.env.CACHE_TTL_SECONDS) || 600,
  maxBytesBilled: String(Number(process.env.BQ_MAX_BYTES_BILLED) || 3e9),
  /** BigQuery dataset holding the Supply Chain Pulse tables, e.g. "project.dataset". */
  dataset: process.env.BQ_DATASET || "",
};
