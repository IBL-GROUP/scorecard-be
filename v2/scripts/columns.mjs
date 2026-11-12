// Prints the columns of the given EDW tables/views. Read-only (INFORMATION_SCHEMA).
// Usage: node v2/scripts/columns.mjs table1 table2 ...
import { BigQuery } from "@google-cloud/bigquery";
import { bqSettings } from "../env.js";
const creds = bqSettings.GCP_SERVICE_ACCOUNT_BASE64 ? JSON.parse(Buffer.from(bqSettings.GCP_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8")) : null;
const projectId = bqSettings.GCP_PROJECT_ID || creds?.project_id;
const location = bqSettings.BIGQUERY_LOCATION;
const bq = new BigQuery(creds ? { credentials: creds, projectId } : { keyFilename: bqSettings.GOOGLE_APPLICATION_CREDENTIALS, projectId });
const names = process.argv.slice(2);
const [rows] = await bq.query({ query: `SELECT table_name, column_name, data_type FROM \`${projectId}.EDW.INFORMATION_SCHEMA.COLUMNS\` WHERE table_name IN UNNEST(@names) ORDER BY table_name, ordinal_position`, params: { names }, location, maximumBytesBilled: "200000000" });
for (const n of names) console.log(`${n}: ${rows.filter((r) => r.table_name === n).map((r) => `${r.column_name}:${r.data_type.replace("STRING", "S").replace("NUMERIC", "N").replace("INT64", "I").replace("FLOAT64", "F")}`).join(", ") || "(not found)"}\n`);
