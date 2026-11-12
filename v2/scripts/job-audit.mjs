// Story S5, TC-S5-09 / AC-S5-4: audit every BigQuery job the 2.0 service
// account has run, from INFORMATION_SCHEMA.JOBS_BY_USER (its own jobs).
//
//   node v2/scripts/job-audit.mjs [since=2026-11-01]
//
// Pass when every job is a QUERY job with statement type SELECT, none wrote to
// a named table (only BigQuery's anonymous result tables, datasets starting
// with "_"), and there were no LOAD, COPY or EXTRACT jobs. Prints counts and
// bytes; read-only (one SELECT through the v2 runner).
import { run, bqInfo } from "../bq.js";

const since = process.argv[2] ?? "2026-11-01";
const region = `region-${String(bqInfo.location || "europe-west6").toLowerCase()}`;
const sql = `
  SELECT
    job_type,
    IFNULL(statement_type, '(none)') AS statement_type,
    COUNTIF(destination_table.dataset_id IS NOT NULL AND NOT STARTS_WITH(destination_table.dataset_id, '_')) AS named_destination,
    COUNTIF(error_result IS NOT NULL) AS failed,
    COUNT(*) AS jobs,
    SUM(IFNULL(total_bytes_billed, 0)) AS bytes_billed,
    MAX(IFNULL(total_bytes_billed, 0)) AS max_bytes_billed,
    MIN(creation_time) AS first_job,
    MAX(creation_time) AS last_job
  FROM \`${bqInfo.projectId}\`.\`${region}\`.INFORMATION_SCHEMA.JOBS_BY_USER
  WHERE creation_time >= TIMESTAMP(@since)
  GROUP BY 1, 2
  ORDER BY jobs DESC`;

let rows;
try {
  rows = await run(sql, { since }, "job-audit");
} catch (e) {
  if (!/bigquery\.jobs\.list|Access Denied/i.test(String(e?.message))) throw e;
  // Expected for a least-privilege account (Data Viewer + Job User has no jobs.list).
  // The cloud admin runs the same audit across the project for this account.
  console.log(`The service account cannot list jobs (no bigquery.jobs.list), as expected for a read-only account.
Ask the cloud admin to run this in BigQuery (project ${bqInfo.projectId}) and send the result:

  SELECT job_type, statement_type,
         COUNTIF(destination_table.dataset_id IS NOT NULL AND NOT STARTS_WITH(destination_table.dataset_id, '_')) AS named_destination,
         COUNT(*) AS jobs, SUM(total_bytes_billed) AS bytes_billed, MAX(total_bytes_billed) AS max_bytes_billed
  FROM \`${bqInfo.projectId}\`.\`${region}\`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
  WHERE creation_time >= TIMESTAMP('${since}')
    AND user_email = '<the 2.0 service account>'
  GROUP BY 1, 2;

Pass: only job_type QUERY with statement_type SELECT, and named_destination = 0 on every row.`);
  process.exit(2);
}
const total = rows.reduce((s, r) => s + r.jobs, 0);
const bad = rows.filter((r) => r.job_type !== "QUERY" || r.statement_type !== "SELECT" || r.named_destination > 0);
console.log(JSON.stringify({ since, region, total_jobs: total, by_type: rows, verdict: bad.length ? "FAIL" : "PASS" }, null, 1));
process.exitCode = bad.length ? 1 : 0;
