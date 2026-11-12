// Story S2, step 1: map every PostgreSQL source the 1.0 routes read to its
// BigQuery table. Read-only: it only queries INFORMATION_SCHEMA views.
//
//   node v2/scripts/source-map.mjs            # print the mapping
//   node v2/scripts/source-map.mjs --columns  # also print each table's columns
//
// Output goes to the console; nothing is written to BigQuery.
import { BigQuery } from "@google-cloud/bigquery";
import { bqSettings } from "../env.js";

const SOURCES = [
  "vw_items_class",
  "vw_daily_stock_movement_history",
  "mv_tscl_spl_targets",
  "sap_items_detail",
  "sales_inv_locations",
  "vw_mv_tscl_data_",
  "cover_days",
  "mv_tscl_budget",
  "tscl_efp",
  "vw_invoice_productmap",
  "sap_wip_data",
  "sap_tpkg_traw_data",
  "mv_scoreboard_hub_mapping",
  "frg_dist_metric_prod_mapping",
  "vw_dispatch_vs_orders",
  "primary_secondary_stock",
  "active_rds_list",
];

const creds = bqSettings.GCP_SERVICE_ACCOUNT_BASE64 ? JSON.parse(Buffer.from(bqSettings.GCP_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8")) : null;
const projectId = bqSettings.GCP_PROJECT_ID || creds?.project_id;
const location = bqSettings.BIGQUERY_LOCATION;
const bq = new BigQuery(creds ? { credentials: creds, projectId } : { keyFilename: bqSettings.GOOGLE_APPLICATION_CREDENTIALS, projectId });

const region = `region-${(location || "US").toLowerCase()}`;
const run = async (query, params = {}) => (await bq.query({ query, params, location, maximumBytesBilled: "200000000", useLegacySql: false }))[0];

// Tables and views whose name matches a source exactly, or with a common suffix/prefix variation.
const tables = await run(
  `SELECT table_schema, table_name, table_type
   FROM \`${projectId}.${region}.INFORMATION_SCHEMA.TABLES\`
   ORDER BY table_schema, table_name`,
);

const norm = (s) => s.toLowerCase().replace(/^(vw_|mv_)/, "").replace(/_+$/, "");
console.log(`Project ${projectId}, location ${location}: ${tables.length} tables/views visible\n`);
console.log("source | exact match | similar names");
const found = {};
for (const src of SOURCES) {
  const exact = tables.filter((t) => t.table_name.toLowerCase() === src.toLowerCase());
  const similar = tables.filter((t) => !exact.includes(t) && (norm(t.table_name) === norm(src) || t.table_name.toLowerCase().includes(norm(src))));
  found[src] = exact;
  console.log(`${src} | ${exact.map((t) => `${t.table_schema}.${t.table_name} (${t.table_type})`).join(", ") || "—"} | ${similar.slice(0, 6).map((t) => `${t.table_schema}.${t.table_name}`).join(", ") || "—"}`);
}

if (process.argv.includes("--columns")) {
  for (const [src, list] of Object.entries(found)) {
    for (const t of list) {
      const cols = await run(
        `SELECT column_name, data_type FROM \`${projectId}.${t.table_schema}.INFORMATION_SCHEMA.COLUMNS\` WHERE table_name = @t ORDER BY ordinal_position`,
        { t: t.table_name },
      );
      console.log(`\n${src} → ${t.table_schema}.${t.table_name}\n  ${cols.map((c) => `${c.column_name}:${c.data_type}`).join(", ")}`);
    }
  }
}
