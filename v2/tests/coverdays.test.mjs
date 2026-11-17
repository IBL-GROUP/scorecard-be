// TC-EXEC-052 (scorecard-fe FEAT-EXEC): ?coverDays, the days the month's target
// is spread over when cover days are worked out. No request reaches BigQuery.
import test from "node:test";
import assert from "node:assert/strict";
import { coverDaysParam } from "../http.js";

test("TC-EXEC-052 coverDays absent or empty: null (the days in the To month, as 1.0)", () => {
  assert.equal(coverDaysParam({}), null);
  assert.equal(coverDaysParam({ coverDays: "" }), null);
});

test("TC-EXEC-052 coverDays a whole number from 1 to 366 is used", () => {
  assert.equal(coverDaysParam({ coverDays: "30" }), 30);
  assert.equal(coverDaysParam({ coverDays: "1" }), 1);
  assert.equal(coverDaysParam({ coverDays: "366" }), 366);
  assert.equal(coverDaysParam({ coverDays: ["45", "60"] }), 45);
});

test("TC-EXEC-052 anything else is a 400", () => {
  for (const v of ["0", "-5", "367", "12.5", "abc", "30d"]) {
    assert.throws(() => coverDaysParam({ coverDays: v }), (e) => e.status === 400 && /1 to 366/.test(e.message), v);
  }
});
