// Branch-filter check (question F1 / Question 7): calls the endpoints that read
// EDW.hub_mapping as sales_inv_locations, without and with a `branch` filter,
// and prints a short summary. Read-only; the token is never printed.
//   node v2/scripts/branch-check.mjs 2026-11-01 2026-11-11 8029
import jwt from "jsonwebtoken";
import { createApp } from "../server.js";

const [startDate, endDate, branch = "8029"] = process.argv.slice(2);
const secret = process.env.JWT_ACCESS_SECRET;
if (!secret) throw new Error("JWT_ACCESS_SECRET is not set in scorecard-be/.env");
const auth = { headers: { Authorization: `Bearer ${jwt.sign({ sub: "branch-check" }, secret, { expiresIn: 600 })}` } };
const server = createApp().listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}/api`;
const call = async (p, extra = "") => {
  const r = await fetch(`${base}${p}?startDate=${startDate}&endDate=${endDate}${extra}`, auth);
  return { status: r.status, body: await r.json() };
};
const sum = (rows, k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
const out = {};
for (const p of ["/cover-days", "/cover-days/total", "/tgt-vs-actual"]) {
  const all = await call(p);
  const one = await call(p, `&branch=${branch}`);
  out[p] = {
    all: { status: all.status, inv_val: Math.round(sum(all.body.data ?? [], "inv_val")), cover_days: (all.body.data ?? []).map((r) => r.cover_days) },
    branch: { status: one.status, inv_val: Math.round(sum(one.body.data ?? [], "inv_val")), cover_days: (one.body.data ?? []).map((r) => r.cover_days) },
  };
}
const inv = await call("/inventory-days");
const invB = await call("/inventory-days", `&branch=${branch}`);
const cols = (rows) => Object.fromEntries(Object.keys(rows[0] ?? {}).filter((k) => !["classification", "item_desc"].includes(k)).map((k) => [k, rows.filter((r) => r[k] !== null).length]));
out["/inventory-days"] = { rows: inv.body.data.length, nonNullPerColumn: cols(inv.body.data), branchRows: invB.body.data.length, branchNonNull: cols(invB.body.data) };
const sm = await call("/service-measure");
const smB = await call("/service-measure", `&branch=${branch}`);
out["/service-measure"] = { rows: sm.body.data, branch: smB.body.data };
console.log(JSON.stringify(out, null, 1));
server.close();
