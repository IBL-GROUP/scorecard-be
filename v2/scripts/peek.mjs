// Run one read-only SELECT through the v2 runner and print the rows (max 30).
//   node v2/scripts/peek.mjs "SELECT ..."
import { run } from "../bq.js";
const rows = await run(process.argv[2], {}, "peek");
console.table(rows.slice(0, 30));
