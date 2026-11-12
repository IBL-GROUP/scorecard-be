// Environment for the 2.0 (BigQuery) server.
//
// - Server settings (port, JWT secret, CORS) come from this repo's own .env.
// - BigQuery settings come ONLY from the file named by BQ_ENV_FILE (by default
//   DSR-test-be's .env, as agreed for story S2), and only these keys are read
//   from it: GCP_PROJECT_ID, BIGQUERY_LOCATION, GCP_SERVICE_ACCOUNT_BASE64,
//   GOOGLE_APPLICATION_CREDENTIALS. Nothing else in that file is loaded.
// - Values are never logged.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

dotenv.config({ path: path.join(root, ".env") });

const BQ_KEYS = ["GCP_PROJECT_ID", "BIGQUERY_LOCATION", "GCP_SERVICE_ACCOUNT_BASE64", "GOOGLE_APPLICATION_CREDENTIALS"];

const bqEnvFile = path.resolve(root, process.env.BQ_ENV_FILE || "../Version 2/DSR-test-be/.env");

function readBqSettings() {
  if (!fs.existsSync(bqEnvFile)) {
    throw new Error(`BigQuery settings file not found (BQ_ENV_FILE): ${bqEnvFile}`);
  }
  const parsed = dotenv.parse(fs.readFileSync(bqEnvFile));
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
  port: Number(process.env.V2_PORT) || 3012,
  corsOrigins: (process.env.V2_CORS_ORIGINS || process.env.CORS_ORIGIN || "http://localhost:5175")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  cacheTtlSeconds: Number(process.env.V2_CACHE_TTL_SECONDS) || 600,
  maxBytesBilled: String(Number(process.env.BQ_MAX_BYTES_BILLED) || 3e9),
  /** BigQuery dataset holding the Supply Chain Pulse tables, e.g. "project.dataset". */
  dataset: process.env.BQ_DATASET || "",
};
