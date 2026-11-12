// Production, materials, dispatch and distributor endpoints, ported from:
//   /wip                routes.wip.js            → ported; 503 until EDW.vw_wip_sap_data is created (question F2)
//   /rpm                routes.rpm.js
//   /dispatch-vs-order  routes.dispatch.vs.order.js
//   /rd-status          routes.rd.status.js      (branch from hub_mapping, F3)
//
// Known gaps are kept: GAP-005 (dispatch ignores branch; wip and rpm take dates
// only), GAP-006 (rd-status ignores `date`).
import { run } from "../bq.js";
import { T, awaitTable, requireSources } from "../sources.js";
import { filters, get, inList, newRouter, str } from "../http.js";

/**
 * The tables behind vw_sap_tpkg_traw_data (recorddate) and vw_dispatch_vs_order
 * (order_date) refuse queries without a filter on their partition column. 1.0
 * had none, so this one keeps every row (NULL included): it satisfies BigQuery
 * without changing any result.
 */
const ALL_PARTITIONS = (col) => `(${col} IS NULL OR ${col} >= TIMESTAMP('1900-01-01'))`;

export const wip = newRouter();
export const rpm = newRouter();
export const dispatchVsOrder = newRouter();
export const rdStatus = newRouter();

/**
 * 1.0 SQL on EDW.vw_wip_sap_data, which the data team will create with the old
 * columns (F2). Written before the view exists, so column types are unknown:
 * codes are compared as text and the record date is read with DATE(). Until the
 * view exists, BigQuery says "Not found" and this answers 503 (awaitTable).
 * Kept from 1.0: the join to vw_items_class reads no column (GAP-005: filters
 * are ignored), and the latest record_created_date in the window is used.
 */
get(wip, "/", "wip", async (q, label) =>
  awaitTable("sap_wip_data", async () => {
    const W = T("sap_wip_data");
    const sql = `
      SELECT t01.storage_loc, t01.storage_loc_desc, t01.plant, t01.plnt_desc,
             t01.material_type_description, t01.type_description AS material_name, t01.order_number,
             t01.item_qty, t01.good_received_qty,
             SUM(t01.wip_value) AS wip_value,
             SUM(t01.wip) AS quantity
      FROM ${W} t01
      LEFT OUTER JOIN ${T("vw_items_class")} t02 ON CAST(t01.item_code AS STRING) = CAST(t02.mapping_code AS STRING)
      WHERE t01.record_created_date = (
        SELECT MAX(x.record_created_date) FROM ${W} x
        WHERE DATE(x.record_created_date) BETWEEN CAST(@startDate AS DATE) AND CAST(@endDate AS DATE)
      )
      GROUP BY t01.type_description, t01.material_type_description, t01.storage_loc_desc,
               t01.plnt_desc, t01.item_qty, t01.good_received_qty, t01.storage_loc, t01.plant, t01.order_number`;
    const rows = await run(sql, { startDate: str(q.startDate), endDate: str(q.endDate) }, label);
    // 1.0 column names contain spaces, which BigQuery aliases cannot.
    return rows.map(({ material_name, wip_value, quantity, ...r }) => ({
      ...r,
      "Material Name": material_name,
      "WIP Value": wip_value,
      Quantity: quantity,
    }));
  }),
);

const VALUE_COLS = [
  ["valuatedgrblocked", "gr_blocked_val"],
  ["valueunrestricted", "unrestricted_val"],
  ["valuequalityinspection", "quality_inspection_val"],
  ["valuereturns", "returns_val"],
  ["valuestktransferstloc", "storage_location_val"],
  ["valuestocktransferplant", "stock_transfer_plant_val"],
  ["valuestockintransit", "stock_in_transit_val"],
  ["valueblocked", "blocked_val"],
  ["valuerestricted", "restricted_val"],
  ["valuetiedempties", "tied_empties_val"],
];
const QTY_COLS = [
  ["unrestricted", "unrestricted_qty"],
  ["qualityinspection", "qualityinspection_qty"],
  ["returns", "return_qty"],
  ["stocktransferstoragelocation", "stocktransferstoragelocation_qty"],
  ["stocktransferplant", "stocktransferplant_qty"],
  ["stockintransit", "stockintransit_qty"],
  ["blocked", "blocked_qty"],
  ["restricted", "restricted_qty"],
  ["tiedempties", "tiedempties_qty"],
];
// 1.0's total_qty leaves stockintransit out; kept as it is.
const TOTAL_QTY = ["unrestricted", "qualityinspection", "returns", "stocktransferstoragelocation", "stocktransferplant", "blocked", "restricted", "tiedempties"];

get(rpm, "/", "rpm", async (q, label) => {
  const T_RPM = T("sap_tpkg_traw_data");
  const sql = `
    SELECT
      sttd.materialname, sttd.producttype,
      -- INT64 / FLOAT64 in BigQuery; the contract (and 1.0) returns them as text.
      CAST(sttd.plant AS STRING) AS plant,
      CAST(CAST(sttd.storagelocation AS INT64) AS STRING) AS storagelocation,
      COALESCE(sttd.storagelocationname, 'NA') AS storagelocationname,
      sttd.plantname,
      ${VALUE_COLS.map(([c, a]) => `SUM(sttd.${c}) AS ${a}`).join(",\n      ")},
      SUM(${VALUE_COLS.map(([c]) => `sttd.${c}`).join(" + ")}) AS total_val,
      ${QTY_COLS.map(([c, a]) => `SUM(sttd.\`${c}\`) AS ${a}`).join(",\n      ")},
      SUM(${TOTAL_QTY.map((c) => `sttd.\`${c}\``).join(" + ")}) AS total_qty
    FROM ${T_RPM} sttd
    WHERE ${ALL_PARTITIONS("sttd.recorddate")}
      AND sttd.executiondate = (
        SELECT MAX(x.executiondate) FROM ${T_RPM} x
        WHERE x.executiondate BETWEEN TIMESTAMP(@startDate) AND TIMESTAMP(@endDate)
          AND ${ALL_PARTITIONS("x.recorddate")}
      )
    GROUP BY sttd.materialname, sttd.producttype, sttd.plant, sttd.storagelocation, 5, sttd.plantname`;
  return run(sql, { startDate: str(q.startDate), endDate: str(q.endDate) }, label);
});

get(dispatchVsOrder, "/", "dispatch-vs-order", async (q, label) => {
  const f = filters(q);
  const sql = `
    SELECT t01.material_name, t01.channel_type,
           SUM(t01.so_quantity) AS total_order_qty,
           SUM(t01.deliverd_qty) AS total_delivery_qty,
           ROUND(SUM(t01.deliverd_qty) / NULLIF(SUM(t01.so_quantity), 0) * 100, 2) AS delivery_pct
    FROM ${T("vw_dispatch_vs_orders")} t01
    LEFT JOIN ${T("vw_items_class")} t02 ON CAST(t02.mapping_code AS STRING) = CAST(t01.material_no AS STRING)
    WHERE t01.actual_gm_date BETWEEN TIMESTAMP(@startDate) AND TIMESTAMP(@endDate)
      AND ${ALL_PARTITIONS("t01.order_date")}
      ${inList(f.classification, "t02.classification", "classification")}
      ${inList(f.sku, "t02.mapping_code", "sku")}
    GROUP BY t01.material_name, t01.channel_type`;
  return run(sql, { startDate: str(q.startDate), endDate: str(q.endDate), classification: f.classification, sku: f.sku }, label);
});

/**
 * 1.0 RD_STATUS_SQL on EDW.vw_primaray_secondary_stock (data team, Question 10
 * and F3, 12 Nov 2026). Like 1.0's primary_secondary_stock it is a snapshot:
 * one `dated` per distributor (checked). Column names: stock_qty → QTY,
 * ibl_item_code → item_code.
 *
 * Branch: the view has no branch column. Each distributor row (data_flag 'SD')
 * has one SUBINVENTORY_CODE, and every such code is in EDW.hub_mapping, so the
 * branch is that storage location's hub branch (hub_branch_code /
 * hub_branch_desc, the 14 branches): decided 12 Nov 2026 (F3).
 *
 * Kept from 1.0: `date` is validated but not used (GAP-006); "today" is the
 * server's date (V2_TIMEZONE, default UTC), and asOf echoes it.
 */
get(rdStatus, "/", "rd-status", async (q, label) => {
  const { date } = q;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    throw Object.assign(new Error("Invalid `date` — expected YYYY-MM-DD"), { status: 400 });
  }
  requireSources("primary_secondary_stock");
  const tz = process.env.V2_TIMEZONE || "UTC";
  const sql = `
    WITH data_ AS (
      SELECT
        pss.data_flag,
        pss.dated,
        CAST(pss.ibl_distributor_code AS STRING) AS ibl_distributor_code,
        pss.distributor_desc,
        hm.hub_branch_code AS branch_code,
        hm.hub_branch_desc AS branch_desc,
        SUM(pss.stock_value) AS stock_value,
        SUM(pss.QTY) AS stock_qty
      FROM ${T("primary_secondary_stock")} pss
      INNER JOIN ${T("active_rds_list")} arl
        ON CAST(arl.ibl_distributor_code AS STRING) = CAST(pss.ibl_distributor_code AS STRING)
      LEFT OUTER JOIN ${T("sap_items_detail")} sid ON sid.matnr = pss.item_code
      LEFT OUTER JOIN ${T("mv_scoreboard_hub_mapping")} hm
        ON CAST(hm.storage_location_code AS STRING) = pss.SUBINVENTORY_CODE
      WHERE pss.data_flag = 'SD'
        AND sid.busline_id IN ('P07', 'P08', 'P12', 'P01', 'P35')
      GROUP BY pss.data_flag, pss.ibl_distributor_code, pss.distributor_desc, hm.hub_branch_code, hm.hub_branch_desc, pss.dated
    )
    SELECT
      ibl_distributor_code,
      distributor_desc,
      branch_code,
      branch_desc,
      CASE WHEN dated = CURRENT_DATE(@tz) THEN stock_qty ELSE 0 END AS stock_qty,
      CASE WHEN dated = CURRENT_DATE(@tz) THEN stock_value ELSE 0 END AS stock_value,
      CASE WHEN dated <> CURRENT_DATE(@tz) THEN stock_qty ELSE 0 END AS last_stock_qty,
      CASE WHEN dated <> CURRENT_DATE(@tz) THEN stock_value ELSE 0 END AS last_stock_value,
      CASE WHEN dated <> CURRENT_DATE(@tz) THEN CAST(dated AS STRING) ELSE NULL END AS last_stock_date,
      CASE WHEN dated = CURRENT_DATE(@tz) THEN 0 ELSE DATE_DIFF(CURRENT_DATE(@tz), dated, DAY) END AS day_diff
    FROM data_
    ORDER BY dated DESC`;
  const data = await run(sql, { tz }, label);
  const asOf = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  return { asOf, data };
});
