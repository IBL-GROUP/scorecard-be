// Filter-bar endpoints, ported from:
//   /filters, /filters/branches   routes.filters.js
//   /total-sku                    routes.total.sku.js
// None of them reads the dashboard filters (GAP-005), as in 1.0.
import { run } from "../lib/bq.js";
import { T } from "../lib/sources.js";
import { get, newRouter } from "../lib/http.js";

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

/**
 * Each hub branch's zone and region (Supply Chain Pulse 2.0), the same rule as
 * Sales Pulse 2.0's HUB_GEO: vw_zone_region_data maps cities to branch codes,
 * and a branch serving cities in more than one region (Lahore, Multan,
 * Peshawar, Islamabad) takes its home region, the one whose city is the branch
 * itself. Branches are matched by name; a branch the view does not have is
 * zone and region 'Others'. One row per hub branch name.
 */
const branchGeo = () => `
    SELECT LOWER(TRIM(hb.hub_branch_desc)) AS hub_name,
      ARRAY_AGG(STRUCT(TRIM(z.zone_description) AS zone, TRIM(z.region) AS region)
        ORDER BY IF(LOWER(TRIM(z.city)) = LOWER(TRIM(hb.hub_branch_desc)), 0, 1), z.region LIMIT 1)[OFFSET(0)] AS home
    FROM ${T("zone_region")} z
    JOIN (SELECT DISTINCT hub_branch_code, hub_branch_desc FROM ${T("mv_scoreboard_hub_mapping")}) hb
      ON CAST(z.branch_code AS STRING) = TRIM(CAST(hb.hub_branch_code AS STRING))
    WHERE CAST(FORMAT_DATE('%Y%m%d', CURRENT_DATE()) AS INT64) BETWEEN z.from_date AND z.end_date
    GROUP BY 1`;

get(filterLists, "/branches", "filters/branches", async (_q, label) => {
  // One row per storage location; 8210 and 8206 left out, as in 1.0. Each row
  // also carries its branch's zone and region (2.0).
  const sql = `
    SELECT mshm.* EXCEPT (storage_location_code),
           CAST(mshm.storage_location_code AS STRING) AS storage_location_code,
           COALESCE(g.home.zone, 'Others') AS zone,
           COALESCE(g.home.region, 'Others') AS region
    FROM ${T("mv_scoreboard_hub_mapping")} mshm
    LEFT JOIN (${branchGeo()}) g ON g.hub_name = LOWER(TRIM(mshm.hub_branch_desc))
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
