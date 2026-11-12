// TC-S2-02 smoke run: call every v2 endpoint against live BigQuery and check
// each response against the scorecard-be OpenAPI contract.
//
//   node v2/scripts/smoke.mjs [startDate endDate]     default: this month to date
//
// Read-only. A short-lived JWT is signed in-process with JWT_ACCESS_SECRET
// from this repo's .env; the token is never printed.
import path from "path";
import jwt from "jsonwebtoken";
import { env } from "../env.js";
import { createApp } from "../server.js";
import { CALLS, check, queryFor, specFile } from "./contract.mjs";

const today = new Date().toISOString().slice(0, 10);
const [startDate = `${today.slice(0, 8)}01`, endDate = today] = process.argv.slice(2);

const secret = process.env.JWT_ACCESS_SECRET;
if (!secret) throw new Error("JWT_ACCESS_SECRET is not set in scorecard-be/.env");
const auth = { headers: { Authorization: `Bearer ${jwt.sign({ sub: "smoke-test" }, secret, { expiresIn: 600 })}` } };

const server = createApp().listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}/api`;
console.log(`Window ${startDate} → ${endDate} · bytes cap ${env.maxBytesBilled} · contract ${path.basename(specFile)}\n`);

const results = [];
for (const [p, kind] of CALLS) {
  const url = base + p + queryFor(kind, startDate, endDate);
  const t0 = Date.now();
  const r = await fetch(url, auth);
  const body = await r.json();
  const ms = Date.now() - t0;
  const errs = r.status === 200 ? check(p, body) : [];
  const t1 = Date.now();
  await fetch(url, auth);
  results.push({ p, status: r.status, rows: body.count ?? "-", ms, cachedMs: Date.now() - t1, errs, msg: r.status === 200 ? "" : body.message || body.error });
}
server.close();

console.log("\nendpoint | status | rows | first ms | repeat ms | contract");
for (const x of results) {
  console.log(`${x.p} | ${x.status} | ${x.rows} | ${x.ms} | ${x.cachedMs} | ${x.status === 200 ? (x.errs.length ? `FAIL (${x.errs.length})` : "ok") : x.msg}`);
  for (const e of x.errs.slice(0, 5)) console.log(`    ${e}`);
}
const ok = results.filter((x) => x.status === 200 && !x.errs.length).length;
const pending = results.filter((x) => x.status === 503).length;
console.log(`\n${ok} pass · ${pending} pending source (503) · ${results.length - ok - pending} fail`);
process.exitCode = results.length - ok - pending ? 1 : 0;
