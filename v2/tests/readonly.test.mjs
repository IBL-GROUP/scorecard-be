// TC-S2-07: the query runner refuses any non-SELECT statement before it reaches BigQuery.
import test from "node:test";
import assert from "node:assert/strict";
import { assertReadOnly } from "../readonly.js";

const refused = [
  "INSERT INTO `p.d.t` (a) VALUES (1)",
  "UPDATE `p.d.t` SET a = 1 WHERE true",
  "DELETE FROM `p.d.t` WHERE true",
  "MERGE `p.d.t` t USING `p.d.s` s ON false WHEN NOT MATCHED THEN INSERT ROW",
  "CREATE TABLE `p.d.x` AS SELECT 1",
  "CREATE OR REPLACE VIEW `p.d.v` AS SELECT 1",
  "DROP TABLE `p.d.t`",
  "ALTER TABLE `p.d.t` ADD COLUMN b INT64",
  "TRUNCATE TABLE `p.d.t`",
  "EXPORT DATA OPTIONS(uri='gs://x/*') AS SELECT 1",
  "LOAD DATA INTO `p.d.t` FROM FILES(format='CSV', uris=['gs://x'])",
  "SELECT 1; DELETE FROM `p.d.t` WHERE true",
  "SELECT 1; SELECT 2",
  "DECLARE x INT64; SELECT x",
  "CALL `p.d.proc`()",
  "BEGIN TRANSACTION",
  "GRANT `roles/bigquery.dataViewer` ON TABLE `p.d.t` TO 'user:x@y'",
  "",
  "   -- only a comment",
];

for (const sql of refused) {
  test(`TC-S2-07 refuses: ${sql.slice(0, 48) || "(empty)"}`, () => {
    assert.throws(() => assertReadOnly(sql), (e) => e.code === "READ_ONLY_VIOLATION");
  });
}

const allowed = [
  "SELECT 1",
  "select * from `p.d.t` where a = 'DELETE FROM x; DROP TABLE y'",
  "WITH a AS (SELECT 1 AS x) SELECT x FROM a",
  "-- a comment that says DROP TABLE\nSELECT record_created_date, executiondate FROM `p.d.t`",
  "SELECT REPLACE(name, ' SELL', '') AS n FROM `p.d.t`;",
  "(SELECT 1) UNION ALL (SELECT 2)",
];

for (const sql of allowed) {
  test(`TC-S2-07 allows: ${sql.replace(/\s+/g, " ").slice(0, 48)}`, () => {
    assert.equal(assertReadOnly(sql), true);
  });
}
