// Story S5, TC-S5-12 / AC-S5-5: load test of the 2.0 API on live BigQuery.
//
//   node v2/scripts/loadtest.mjs [--vus 25] [--minutes 15] [--today 2026-11-12]
//
// Runs the v2 app in this process (so it can count the BigQuery jobs it
// starts) and simulates N users. Each user visit requests all 22 endpoints, at
// most 6 at a time as a browser does, for this month to date (80%) or last
// month (20%), then pauses 5–15 s. Pass: no errors other than 503
// SOURCE_PENDING, and BigQuery jobs stay far below the request count (the
// cache coalesces identical requests). Read-only; the JWT is signed in-process
// and never printed.
import jwt from "jsonwebtoken";
import { env } from "../env.js";
import { jobStats } from "../bq.js";
import { createApp } from "../server.js";
import { CALLS, queryFor } from "./contract.mjs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const VUS = Number(arg("vus", 25));
const MINUTES = Number(arg("minutes", 15));
const today = arg("today", new Date().toISOString().slice(0, 10));
const mtd = [`${today.slice(0, 8)}01`, today];
const lm = (() => {
  const d = new Date(`${today.slice(0, 8)}01T00:00:00Z`);
  const end = new Date(d.getTime() - 86400000);
  return [`${end.toISOString().slice(0, 8)}01`, end.toISOString().slice(0, 10)];
})();

const secret = process.env.JWT_ACCESS_SECRET;
if (!secret) throw new Error("JWT_ACCESS_SECRET is not set in scorecard-be/.env");
const auth = { headers: { Authorization: `Bearer ${jwt.sign({ sub: "load-test" }, secret, { expiresIn: MINUTES * 60 + 600 })}` } };

const server = createApp().listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}/api`;
const quiet = console.log;
console.log = () => {}; // the app logs every request; keep the report readable

const lat = [];
const errors = {};
let requests = 0;
let pending = 0;
const stopAt = Date.now() + MINUTES * 60_000;
const startJobs = jobStats.started;
const startBytes = jobStats.bytesBilled;

async function visit() {
  const [s, e] = Math.random() < 0.8 ? mtd : lm;
  const queue = CALLS.map(([p, kind]) => base + p + queryFor(kind, s, e));
  const worker = async () => {
    for (let url; (url = queue.shift()); ) {
      const t0 = Date.now();
      try {
        const r = await fetch(url, auth);
        await r.arrayBuffer();
        requests++;
        lat.push(Date.now() - t0);
        if (r.status === 503) pending++;
        else if (r.status !== 200) errors[`${r.status} ${new URL(url).pathname}`] = (errors[`${r.status} ${new URL(url).pathname}`] ?? 0) + 1;
      } catch (err) {
        errors[`network ${err.code ?? err.message}`] = (errors[`network ${err.code ?? err.message}`] ?? 0) + 1;
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

async function user(i) {
  await new Promise((r) => setTimeout(r, i * 400)); // users arrive over ~10 s
  let visits = 0;
  while (Date.now() < stopAt) {
    await visit();
    visits++;
    await new Promise((r) => setTimeout(r, 5000 + Math.random() * 10000));
  }
  return visits;
}

const t0 = Date.now();
const visits = (await Promise.all(Array.from({ length: VUS }, (_, i) => user(i)))).reduce((a, b) => a + b, 0);
server.close();
console.log = quiet;

lat.sort((a, b) => a - b);
const pct = (p) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))] ?? null;
const jobs = jobStats.started - startJobs;
const result = {
  users: VUS,
  minutes: Number(((Date.now() - t0) / 60000).toFixed(1)),
  visits,
  requests,
  pending_503: pending,
  errors,
  latency_ms: { p50: pct(50), p90: pct(90), p99: pct(99), max: lat[lat.length - 1] ?? null },
  bigquery: {
    jobs_started: jobs,
    requests_per_job: jobs ? Number((requests / jobs).toFixed(1)) : null,
    bytes_billed: jobStats.bytesBilled - startBytes,
    max_bytes_one_job: jobStats.maxBytesBilled,
    bytes_cap: env.maxBytesBilled,
    statement_types: jobStats.byStatement,
  },
  verdict: Object.keys(errors).length === 0 ? "PASS" : "FAIL",
};
console.log(JSON.stringify(result, null, 1));
process.exitCode = result.verdict === "PASS" ? 0 : 1;
