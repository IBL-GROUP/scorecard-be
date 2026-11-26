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
 * Each hub branch's zone, market and region (Supply Chain Pulse 2.0), as Sales Pulse
 * 2.0 places warehouse stock (HUB_GEO). vw_zone_region_data has one row per
 * distributor (26 Nov 2026), with its hub_name and city; these branches are
 * IBL warehouses with no distributor, so a branch is found by hub_name, or
 * else by city (Bahawalpur, Faisalabad, Korangi, Mingora). A hub serving more
 * than one region (Lahore, Multan, Peshawar, Islamabad) takes its home region,
 * the row whose city is the branch itself. A branch the view does not name is
 * zone and region 'Others'. One row per hub branch name.
 */
const branchGeo = () => `
    SELECT b.hub_name,
      ARRAY_AGG(STRUCT(TRIM(z.zone_description) AS zone, TRIM(z.market) AS market, TRIM(z.region) AS region)
        ORDER BY IF(LOWER(TRIM(z.city)) = b.hub_name, 0, 1), IF(LOWER(TRIM(z.hub_name)) = b.hub_name, 0, 1), z.region
        LIMIT 1)[OFFSET(0)] AS home
    FROM (SELECT DISTINCT LOWER(TRIM(hub_branch_desc)) AS hub_name FROM ${T("mv_scoreboard_hub_mapping")}) b
    CROSS JOIN ${T("zone_region")} z
    WHERE LOWER(TRIM(z.hub_name)) = b.hub_name OR LOWER(TRIM(z.city)) = b.hub_name
    GROUP BY 1`;

get(filterLists, "/branches", "filters/branches", async (_q, label) => {
  // One row per storage location; 8210 and 8206 left out, as in 1.0. Each row
  // also carries its branch's zone and region (2.0).
  const sql = `
    SELECT mshm.* EXCEPT (storage_location_code),
           CAST(mshm.storage_location_code AS STRING) AS storage_location_code,
           COALESCE(g.home.zone, 'Others') AS zone,
           COALESCE(g.home.market, 'Others') AS market,
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
