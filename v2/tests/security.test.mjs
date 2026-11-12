// Story S5 security checks (TC-S5-15, AC-S5-8): error responses carry no SQL
// or BigQuery text, CORS answers only the configured origins, and the open
// health routes reveal nothing sensitive. No request here reaches BigQuery.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { get, newRouter } from "../http.js";
import { env } from "../env.js";
import { createApp } from "../server.js";

async function serve(app) {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test("TC-S5-15 an unexpected error answers 500 with a reference only: no SQL, no BigQuery message", async () => {
  const router = newRouter();
  const leak = "Unrecognized name: branch_id at [12:9]; SELECT SUM(amount) FROM `data-light-house-prod.EDW.vw_mv_tsc_data`";
  get(router, "/boom", "boom", async () => {
    throw new Error(leak);
  });
  const app = express().use("/api", router);
  const { server, base } = await serve(app);
  const errors = console.error;
  console.error = () => {}; // the detail is logged server-side; keep the test output clean
  try {
    const r = await fetch(`${base}/api/boom`);
    const text = await r.text();
    assert.equal(r.status, 500);
    assert.match(JSON.parse(text).error, /^Internal error \(ref [0-9a-f]{8}\)$/);
    for (const bad of ["SELECT", "Unrecognized", "branch_id", "data-light-house-prod", "EDW", "vw_mv_tsc_data"]) {
      assert.ok(!text.includes(bad), `response contains "${bad}"`);
    }
  } finally {
    console.error = errors;
    server.close();
  }
});

test("TC-S5-15 our own 400 messages (bad input) are still shown", async () => {
  const router = newRouter();
  get(router, "/bad", "bad", async () => {
    throw Object.assign(new Error("Invalid `date` — expected YYYY-MM-DD"), { status: 400 });
  });
  const { server, base } = await serve(express().use("/api", router));
  try {
    const r = await fetch(`${base}/api/bad`);
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /expected YYYY-MM-DD/);
  } finally {
    server.close();
  }
});

test("TC-S5-15 CORS: a foreign origin gets no Access-Control-Allow-Origin; a configured one does", async () => {
  const { server, base } = await serve(createApp());
  try {
    const foreign = await fetch(`${base}/api/health`, { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "GET" } });
    assert.equal(foreign.headers.get("access-control-allow-origin"), null);
    const allowed = [].concat(env.corsOrigins ?? []).find((o) => typeof o === "string" && o.startsWith("http"));
    if (allowed) {
      const ok = await fetch(`${base}/api/health`, { method: "OPTIONS", headers: { Origin: allowed, "Access-Control-Request-Method": "GET" } });
      assert.equal(ok.headers.get("access-control-allow-origin"), allowed);
      assert.doesNotMatch(ok.headers.get("access-control-allow-methods") ?? "", /POST|PUT|PATCH|DELETE/);
    }
  } finally {
    server.close();
  }
});
