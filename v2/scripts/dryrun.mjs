// Dry-run a SELECT (no data read, nothing billed): prints whether BigQuery
// accepts it and how many bytes it would process. Read-only.
//   node v2/scripts/dryrun.mjs "SELECT ..."
import { bigquery, bqInfo } from "../bq.js";
import { assertReadOnly } from "../readonly.js";
const sql = process.argv[2];
assertReadOnly(sql);
try {
  const [job] = await bigquery.createQueryJob({ query: sql, location: bqInfo.location, dryRun: true, useLegacySql: false });
  const b = Number(job.metadata.statistics.totalBytesProcessed);
  console.log(`OK · would process ${(b / 1e6).toFixed(1)} MB`);
} catch (e) {
  console.log(`REFUSED · ${e.message}`);
}
