// Source status handling (story S2): a table the data team has named but not
// created yet answers 503 SOURCE_PENDING, never 500. No BigQuery call is made.
import test from "node:test";
import assert from "node:assert/strict";
import { awaitTable, MISSING_RECHECK_MS, notReady, requireSources, SOURCES, T } from "../sources.js";

// Each test uses its own clock, far apart, so the remembered "not found" of one does not leak into the next.
let clock = 0;
const later = () => ((clock += 10 * MISSING_RECHECK_MS), () => clock);

test("awaitTable turns BigQuery 'Not found' for the awaited table into SOURCE_PENDING", async () => {
  const table = SOURCES.sap_wip_data.table;
  await assert.rejects(
    awaitTable("sap_wip_data", async () => {
      throw new Error(`Not found: Table data-light-house-prod:EDW.${table} was not found in location europe-west6`);
    }, later()),
    (e) => e.code === "SOURCE_PENDING" && e.status === 503 && e.pending[0] === "sap_wip_data",
  );
});

test("awaitTable passes other errors through unchanged", async () => {
  await assert.rejects(
    awaitTable("sap_wip_data", async () => {
      throw new Error("Not found: Table data-light-house-prod:EDW.some_other_table");
    }, later()),
    (e) => e.code !== "SOURCE_PENDING",
  );
  await assert.rejects(
    awaitTable("sap_wip_data", async () => {
      throw new Error("Syntax error");
    }, later()),
    /Syntax error/,
  );
});

test("awaitTable returns the rows when the table exists", async () => {
  assert.deepEqual(await awaitTable("sap_wip_data", async () => [{ a: 1 }], later()), [{ a: 1 }]);
});

test("TC-S5-12 a missing table is remembered for 5 minutes: no BigQuery job per request, then asked again", async () => {
  const now = later();
  let jobs = 0;
  const missing = async () => {
    jobs++;
    throw new Error(`Not found: Table x:EDW.${SOURCES.sap_wip_data.table}`);
  };
  await assert.rejects(awaitTable("sap_wip_data", missing, now), (e) => e.code === "SOURCE_PENDING");
  for (let i = 0; i < 5; i++) await assert.rejects(awaitTable("sap_wip_data", missing, now), (e) => e.code === "SOURCE_PENDING");
  assert.equal(jobs, 1, "one job, not one per request");
  clock += MISSING_RECHECK_MS + 1;
  assert.deepEqual(await awaitTable("sap_wip_data", async () => (jobs++, [{ ok: 1 }]), now), [{ ok: 1 }]);
  assert.equal(jobs, 2, "asked again after 5 minutes; the table now exists");
});

test("an awaited source can be named in SQL; a pending one cannot", () => {
  assert.match(T("sap_wip_data"), /vw_wip_sap_data`$/);
  SOURCES.__test_pending = { table: null, status: "pending", note: "test" };
  try {
    assert.throws(() => T("__test_pending"), (e) => e.code === "SOURCE_PENDING");
    assert.throws(() => requireSources("__test_pending"), (e) => e.status === 503);
  } finally {
    delete SOURCES.__test_pending;
  }
});

test("hub_mapping and distributor stock are confirmed; health lists only what is not ready", () => {
  assert.match(T("sales_inv_locations"), /hub_mapping`$/);
  assert.match(T("primary_secondary_stock"), /vw_primaray_secondary_stock`$/);
  assert.deepEqual(notReady(), ["sap_wip_data"]);
});
