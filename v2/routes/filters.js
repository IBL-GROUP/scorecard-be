// Filter-bar endpoints, ported from:
//   /filters, /filters/branches   routes.filters.js
//   /total-sku                    routes.total.sku.js
// None of them reads the dashboard filters (GAP-005), as in 1.0.
import { run } from "../bq.js";
import { T } from "../sources.js";
import { get, newRouter } from "../http.js";

export const filterLists = newRouter();
export const totalSku = newRouter();

get(filterLists, "/", "filters", async (_q, label) => {
  // Every column of vw_items_class, plus the three names the filter bar reads.
  // mapping_code is INT64 in BigQuery; it is returned as text, as PostgreSQL's
  // bigint/numeric arrived. PostgreSQL sorts NULLs last.
  const sql = `
    SELECT vic.* EXCEPT (classification, mapping_code),
           CAST(vic.mapping_code AS STRING) AS mapping_code,
           CAST(vic.mapping_code AS STRING) AS item_code,
           vic.PRD AS item_description,
           COALESCE(vic.classification, 'Others') AS classification
    FROM ${T("vw_items_class")} vic
    ORDER BY vic.PRD ASC NULLS LAST`;
  return run(sql, {}, label);
});

get(filterLists, "/branches", "filters/branches", async (_q, label) => {
  // One row per storage location; 8210 and 8206 left out, as in 1.0.
  const sql = `
    SELECT mshm.* EXCEPT (storage_location_code),
           CAST(mshm.storage_location_code AS STRING) AS storage_location_code
    FROM ${T("mv_scoreboard_hub_mapping")} mshm
    WHERE mshm.hub_branch_code NOT IN ('8210', '8206')`;
  return run(sql, {}, label);
});

get(totalSku, "/", "total-sku", async (_q, label) => {
  const sql = `
    SELECT vic.classification, COUNT(vic.mapping_code) AS count
    FROM ${T("vw_items_class")} vic
    GROUP BY vic.classification`;
  return run(sql, {}, label);
});
