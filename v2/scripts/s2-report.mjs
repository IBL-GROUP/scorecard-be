// Story S2 test report: runs the checks that need live BigQuery and writes
// v2/reports/S2-test-report-<date>.md.
//
//   node v2/scripts/s2-report.mjs [closedStart closedEnd]   default closed month: last month
//
//   TC-S2-02  every endpoint, MTD and a closed month, against the OpenAPI contract
//   AC-S2-8   bytes billed per endpoint at the MTD window, against the cap
//   TC-S2-14  10 identical concurrent requests → one BigQuery job; repeat < 200 ms
//   TC-S2-15  every job of the run: SELECT, bytes cap set, no destination of ours
//   TC-S2-16  a forced SQL error → 500, short message, no SQL text
//
// Read-only: SELECT jobs and jobs.list only. The JWT is signed in-process and
// never printed. TC-S2-05/06/07 run with `npm run test:v2`.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import jwt from "jsonwebtoken";
import { env } from "../env.js";
import { createApp } from "../server.js";
import { bigquery, bqInfo, clearCache, jobStats } from "../bq.js";
import { CALLS, check, queryFor, specFile } from "./contract.mjs";

// Measure real bytes: BigQuery's result cache would bill 0 for repeats (read by bq.js at run time).
process.env.V2_BQ_QUERY_CACHE = "false";

const iso = (d) => d.toISOString().slice(0, 10);
const now = new Date();
const today = iso(now);
const mtd = [`${today.slice(0, 8)}01`, today];
const lastMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
const closed = process.argv.length >= 4 ? process.argv.slice(2, 4) : [`${iso(lastMonthEnd).slice(0, 8)}01`, iso(lastMonthEnd)];

const secret = process.env.JWT_ACCESS_SECRET;
if (!secret) throw new Error("JWT_ACCESS_SECRET is not set in scorecard-be/.env");
const auth = { headers: { Authorization: `Bearer ${jwt.sign({ sub: "s2-report" }, secret, { expiresIn: 900 })}` } };

const server = createApp().listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}/api`;
const runStart = Date.now();
const out = [];
const md = (s = "") => out.push(s);

// ── TC-S2-02 and AC-S2-8 ───────────────────────────────────────────────────
async function sweep([s, e]) {
  clearCache();
  const rows = [];
  for (const [p, kind] of CALLS) {
    const before = jobStats.log.length;
    const r = await fetch(base + p + queryFor(kind, s, e), auth);
    const body = await r.json();
    const jobs = jobStats.log.slice(before);
    rows.push({
      p,
      status: r.status,
      count: body.count ?? "–",
      errs: r.status === 200 ? check(p, body) : [],
      msg: r.status === 200 ? "" : body.message,
      bytes: jobs.reduce((a, j) => a + j.bytesBilled, 0),
    });
  }
  return rows;
}
const sweeps = { [`MTD ${mtd[0]} → ${mtd[1]}`]: await sweep(mtd), [`Closed month ${closed[0]} → ${closed[1]}`]: await sweep(closed) };

// ── TC-S2-14 ───────────────────────────────────────────────────────────────
clearCache();
const concUrl = `${base}/sales-summary${queryFor("range", ...mtd)}`;
const jobs0 = jobStats.started;
const conc = await Promise.all(Array.from({ length: 10 }, () => fetch(concUrl, auth).then((r) => r.status)));
const concJobs = jobStats.started - jobs0;
const t = Date.now();
await fetch(concUrl, auth);
const repeatMs = Date.now() - t;

// ── TC-S2-16 ───────────────────────────────────────────────────────────────
const errRes = await fetch(`${base}/forecast-accuracy-monthly?startDate=abc&endDate=2026-10-31`, auth);
const errBody = await errRes.json();
const errText = JSON.stringify(errBody);
const leaksSql = /\bSELECT\b|\bFROM\s+`|\bWHERE\b/i.test(errText);

server.close();

// ── TC-S2-15 ───────────────────────────────────────────────────────────────
const runJobs = jobStats.log;
let serverSide = null;
try {
  const [jobs] = await bigquery.getJobs({ minCreationTime: String(runStart - 60_000), maxResults: 1000, projection: "full", autoPaginate: true });
  const mine = new Set(runJobs.map((j) => j.jobId));
  const listed = jobs.filter((j) => mine.has(j.id));
  serverSide = {
    listed: listed.length,
    select: listed.filter((j) => j.metadata.statistics?.query?.statementType === "SELECT").length,
    capped: listed.filter((j) => j.metadata.configuration?.query?.maximumBytesBilled).length,
    anon: listed.filter((j) => !j.metadata.configuration?.query?.destinationTable || j.metadata.configuration.query.destinationTable.datasetId.startsWith("_")).length,
  };
} catch (e) {
  serverSide = { error: e.message };
}
const selectAll = runJobs.every((j) => j.statementType === "SELECT");
const cappedAll = runJobs.every((j) => String(j.maximumBytesBilled) === String(env.maxBytesBilled));
const anonAll = runJobs.every((j) => !j.destination || j.destination.startsWith("_"));

// ── Report ─────────────────────────────────────────────────────────────────
const mb = (b) => (b / 1e6).toFixed(1);
const cap = Number(env.maxBytesBilled);
md(`# Story S2 test report: ${today}`);
md();
md(`BigQuery ${bqInfo.projectId} (${bqInfo.location}) · bytes cap ${mb(cap)} MB per job · cache TTL ${env.cacheTtlSeconds}s · contract \`${path.basename(specFile)}\``);
md(`Generated by \`node v2/scripts/s2-report.mjs\`. Read-only: SELECT jobs and jobs.list only. BigQuery's result cache is off for this run, so "MB billed" is the real cost of each endpoint.`);
md();
md(`## TC-S2-02: contract, and AC-S2-8: bytes billed per endpoint`);
for (const [title, rows] of Object.entries(sweeps)) {
  const pass = rows.filter((r) => r.status === 200 && !r.errs.length).length;
  const pend = rows.filter((r) => r.status === 503).length;
  md();
  md(`### ${title}: ${pass} conform · ${pend} pending source · ${rows.length - pass - pend} fail`);
  md();
  md(`| Endpoint | Status | Rows | MB billed | Contract |`);
  md(`|---|---|---|---|---|`);
  for (const r of rows) {
    const c = r.status === 200 ? (r.errs.length ? `**FAIL**: ${[...new Set(r.errs.map((e) => e.replace(/\[\d+\]/g, "[]")))].slice(0, 3).join("; ")}` : "ok") : r.msg;
    md(`| \`${r.p}\` | ${r.status} | ${r.count} | ${mb(r.bytes)} | ${c} |`);
  }
  const maxB = Math.max(...rows.map((r) => r.bytes));
  md();
  md(`Largest endpoint: ${mb(maxB)} MB (${((maxB / cap) * 100).toFixed(0)}% of the cap). ${maxB <= cap ? "None exceeds the cap." : "**Exceeds the cap.**"}`);
}
md();
md(`## TC-S2-14: concurrent identical requests`);
md();
md(`10 simultaneous \`/sales-summary\` requests (MTD, empty cache): statuses ${[...new Set(conc)].join(", ")}; **BigQuery jobs started: ${concJobs}** (expected 1). Repeat inside the TTL: **${repeatMs} ms** (expected < 200 ms). ${concJobs === 1 && repeatMs < 200 ? "**Pass.**" : "**Fail.**"}`);
md();
md(`## TC-S2-15: job history for this run`);
md();
md(`From the job metadata BigQuery returned for each of the ${runJobs.length} jobs:`);
md(`- statement type SELECT: ${runJobs.filter((j) => j.statementType === "SELECT").length}/${runJobs.length}`);
md(`- \`maximumBytesBilled\` = ${env.maxBytesBilled}: ${runJobs.filter((j) => String(j.maximumBytesBilled) === String(env.maxBytesBilled)).length}/${runJobs.length}`);
md(`- destination only BigQuery's anonymous result table (\`_…\` dataset), none set by us: ${runJobs.filter((j) => !j.destination || j.destination.startsWith("_")).length}/${runJobs.length}`);
md();
md(serverSide.error
  ? `Job history read back with jobs.list: not available to this service account (${serverSide.error.slice(0, 120)}). Check in the BigQuery console job history instead.`
  : `Job history read back with jobs.list: ${serverSide.listed} of this run's jobs listed; SELECT ${serverSide.select}, capped ${serverSide.capped}, anonymous destination ${serverSide.anon}.`);
md();
md(`${selectAll && cappedAll && anonAll ? "**Pass.**" : "**Fail.**"}`);
md();
md(`## TC-S2-16: forced SQL error`);
md();
md(`\`/forecast-accuracy-monthly?startDate=abc\` → **${errRes.status}**, message "${errBody.message}", error "${String(errBody.error).slice(0, 160)}". SQL text in the response: ${leaksSql ? "**yes**" : "no"}. ${errRes.status === 500 && !leaksSql ? "**Pass.**" : "**Fail.**"}`);
md();
md(`## Not covered here`);
md();
md(`- TC-S2-05, 06, 07: \`npm run test:v2\`.`);
md(`- TC-S2-03, 04 (parity with 1.0): need read access to the 1.0 PostgreSQL database.`);
md(`- TC-S2-08 (service account refused INSERT / CREATE TABLE): cloud administrator.`);
md(`- TC-S2-01 (source map sign-off): data team, questions F1–F6.`);

const reportDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "reports");
fs.mkdirSync(reportDir, { recursive: true });
const file = path.join(reportDir, `S2-test-report-${today}.md`);
fs.writeFileSync(file, out.join("\n") + "\n");
console.log(out.join("\n"));
console.log(`\nSaved ${file}`);
