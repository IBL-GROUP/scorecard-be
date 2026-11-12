// TC-S2-05 (401 without or with an expired token) and TC-S2-06 (non-GET refused).
// No request here reaches BigQuery: each one is turned away before a route runs.
import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { createApp, ROUTE_GROUPS } from "../server.js";

const secret = process.env.JWT_ACCESS_SECRET;
let server;
let base;

test.before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const paths = ROUTE_GROUPS.map(([p]) => `/api${p}`);

test("TC-S2-05 every endpoint answers 401 without Authorization", async () => {
  for (const p of paths) {
    const r = await fetch(base + p);
    assert.equal(r.status, 401, p);
  }
});

test("TC-S2-05 an expired token gets 401 'Session expired'", { skip: !secret && "JWT_ACCESS_SECRET not set" }, async () => {
  const token = jwt.sign({ sub: "test", exp: Math.floor(Date.now() / 1000) - 60 }, secret);
  const r = await fetch(`${base}/api/sales-summary`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).message, "Session expired");
});

test("TC-S2-05 a token signed with another secret gets 401", async () => {
  const token = jwt.sign({ sub: "test" }, "not-the-secret", { expiresIn: 60 });
  const r = await fetch(`${base}/api/sales-summary`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 401);
});

test("TC-S2-06 POST, PUT, PATCH and DELETE get 405 on every endpoint", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    for (const p of [...paths, "/api/health", "/api/cache/clear"]) {
      const r = await fetch(base + p, { method });
      assert.equal(r.status, 405, `${method} ${p}`);
    }
  }
});
