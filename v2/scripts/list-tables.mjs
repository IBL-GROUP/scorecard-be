// Lists BigQuery tables/views whose names contain any of the given words.
// Read-only (INFORMATION_SCHEMA). Usage: node v2/scripts/list-tables.mjs word1 word2 ...
import { BigQuery } from "@google-cloud/bigquery";
import { bqSettings } from "../env.js";
const creds = bqSettings.GCP_SERVICE_ACCOUNT_BASE64 ? JSON.parse(Buffer.from(bqSettings.GCP_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8")) : null;
const projectId = bqSettings.GCP_PROJECT_ID || creds?.project_id;
const location = bqSettings.BIGQUERY_LOCATION;
const bq = new BigQuery(creds ? { credentials: creds, projectId } : { keyFilename: bqSettings.GOOGLE_APPLICATION_CREDENTIALS, projectId });
const [rows] = await bq.query({ query: `SELECT table_schema, table_name, table_type FROM \`${projectId}.region-${location.toLowerCase()}.INFORMATION_SCHEMA.TABLES\` ORDER BY 1, 2`, location, maximumBytesBilled: "200000000" });
const words = process.argv.slice(2).map((w) => w.toLowerCase());
for (const r of rows) if (!words.length || words.some((w) => r.table_name.toLowerCase().includes(w))) console.log(`${r.table_schema}.${r.table_name} (${r.table_type})`);
