// BigQuery client, read-only query runner and a small in-memory cache.
//
// - Every statement passes assertReadOnly() first (AC-S2-6).
// - Every job has maximumBytesBilled (AC-S2-8). Bytes billed are logged per job.
// - Results are cached for V2_CACHE_TTL_SECONDS; identical requests in flight
//   share one job (AC-S2-9).
// - Only bigquery.createQueryJob is used: no load, copy, extract, insert or
//   table-create API (AC-S2-7). No destination table is ever set.
// - Values from the browser only ever travel as named parameters.
import { BigQuery } from "@google-cloud/bigquery";
import { bqSettings, env } from "./env.js";
import { assertReadOnly } from "./readonly.js";

function credentials() {
  const b64 = bqSettings.GCP_SERVICE_ACCOUNT_BASE64;
  if (!b64) return null;
  try {
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    throw new Error("GCP_SERVICE_ACCOUNT_BASE64 is not valid base64-encoded JSON");
  }
}

const creds = credentials();
const projectId = bqSettings.GCP_PROJECT_ID || creds?.project_id;
const location = bqSettings.BIGQUERY_LOCATION || undefined;

export const bigquery = new BigQuery(
  creds ? { credentials: creds, projectId } : { keyFilename: bqSettings.GOOGLE_APPLICATION_CREDENTIALS, projectId },
);

const TTL = env.cacheTtlSeconds * 1000;
/** How many BigQuery jobs this process has started (TC-S2-14 reads it). */
// `log` keeps what BigQuery reported for each job (label, id, bytes, statement
// type, bytes cap, destination) for the S2 test report (TC-S2-15). Last 500 only.
// Running totals (all jobs) feed the S5 load test and cost projection.
export const jobStats = { started: 0, log: [], bytesBilled: 0, byStatement: {}, maxBytesBilled: 0 };
const cache = new Map(); // key -> { at, rows } | { at, promise }

/** BigQuery needs explicit types for empty arrays and nulls. */
function typesFor(params) {
  const types = {};
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) types[k] = ["STRING"];
    else if (v === null || v === undefined) types[k] = "STRING";
  }
  return types;
}

/** BigQuery wrapper objects → plain JSON values (dates as YYYY-MM-DD, timestamps as ISO). */
function plain(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(plain);
  if (v instanceof Buffer) return v.toString("base64");
  if ("value" in v && Object.keys(v).length === 1) return v.value; // BigQueryDate/Timestamp/Datetime/Time
  if (typeof v.toFixed === "function" && typeof v.toNumber === "function") return v.toNumber(); // Big (NUMERIC)
  if (v.constructor?.name === "Big") return Number(v.toString());
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = plain(x);
  return out;
}

/**
 * Run one read-only query. `label` names the endpoint in the log line.
 * Returns plain rows.
 */
export async function run(sql, params = {}, label = "query") {
  assertReadOnly(sql);
  const clean = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v === undefined ? null : v]));
  const key = sql + "\u0000" + JSON.stringify(clean);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) {
    console.log(`[v2] ${label} cache hit`);
    return hit.promise ?? hit.rows;
  }

  const started = Date.now();
  const promise = (async () => {
    jobStats.started += 1;
    const [job] = await bigquery.createQueryJob({
      query: sql,
      params: clean,
      types: typesFor(clean),
      location,
      maximumBytesBilled: env.maxBytesBilled,
      useLegacySql: false,
      // BigQuery's own result cache is on unless V2_BQ_QUERY_CACHE=false
      // (the S2 report turns it off to measure real bytes billed).
      useQueryCache: process.env.V2_BQ_QUERY_CACHE !== "false",
    });
    const [rows] = await job.getQueryResults();
    // The insert response can predate the final statistics; read them back (jobs.get).
    await job.getMetadata().catch(() => {});
    const stats = job.metadata?.statistics?.query ?? {};
    const billed = Number(stats.totalBytesBilled || 0);
    jobStats.bytesBilled += billed;
    jobStats.maxBytesBilled = Math.max(jobStats.maxBytesBilled, billed);
    jobStats.byStatement[stats.statementType ?? "?"] = (jobStats.byStatement[stats.statementType ?? "?"] ?? 0) + 1;
    const cfg = job.metadata?.configuration?.query ?? {};
    jobStats.log.push({
      label,
      jobId: job.id,
      statementType: stats.statementType ?? null,
      bytesBilled: billed,
      maximumBytesBilled: cfg.maximumBytesBilled ?? null,
      destination: cfg.destinationTable ? `${cfg.destinationTable.datasetId}.${cfg.destinationTable.tableId}` : null,
      ms: Date.now() - started,
      rows: rows.length,
    });
    if (jobStats.log.length > 500) jobStats.log.shift();
    console.log(`[v2] ${label} rows=${rows.length} bytesBilled=${billed} (${(billed / 1e6).toFixed(1)} MB) cached=${stats.cacheHit ? "bq" : "no"} ${Date.now() - started}ms`);
    return rows.map(plain);
  })();
  cache.set(key, { at: Date.now(), promise });
  try {
    const rows = await promise;
    cache.set(key, { at: Date.now(), rows });
    if (cache.size > 800) cache.delete(cache.keys().next().value);
    return rows;
  } catch (e) {
    cache.delete(key);
    throw e;
  }
}

export const clearCache = () => cache.clear();
export const bqInfo = { projectId, location };
