// Stock, cover-days and threshold endpoints, ported from the 1.0 routes:
//   /cover-days, /cover-days/total, /cover-days/closing-inv, /cover-days/benchmarks
//                                     routes.cover.days.js
//   /inventory-days                   routes.inventory.days.js
//   /above-below-threshold            routes.above-below-threshold.js
//   /service-measure                  routes.service.measure.js
//   /tgt-vs-actual                    routes.tgt.vs.actual.js
//
// 1.0's sales_inv_locations is EDW.hub_mapping (data team, Question 7), read
// through sql.js#SIL with 1.0's column names. It is joined exactly where 1.0
// joins it. /above-below-threshold filters branch on dsmh.subinventory_code, as
// 1.0 does, so it does not use it.
//
// Known gaps are kept as they are today: GAP-001 (inventory-days and
// service-measure hard-code April 2026), GAP-005 (above-below ignores
// classification).
import { run } from "../bq.js";
import { T } from "../sources.js";
import { filters, get, inList, newRouter, str } from "../http.js";
import { BUSLINES, DAYS_IN_MONTH, DSMH_CODE, END_MONTH, NEXT_MONTH, SID_CODE, SIL, SLOC, latestStockDate, thresholdsInForce, vic } from "../sql.js";

export const coverDays = newRouter();
export const inventoryDays = newRouter();
export const aboveBelow = newRouter();
export const serviceMeasure = newRouter();
export const tgtVsActual = newRouter();

const params = (q, f) => ({ startDate: str(q.startDate), endDate: str(q.endDate), ...f });

/** Closing-stock CTE body shared by /cover-days, /cover-days/total and /tgt-vs-actual. */
const closingStock = (f, select, groupBy = "") => `
      SELECT ${select}
      FROM ${T("vw_daily_stock_movement_history")} dsmh
      LEFT OUTER JOIN ${T("vw_items_class")} dmpm ON ${vic("dmpm")} = ${DSMH_CODE}
      LEFT OUTER JOIN ${SIL()} sil ON sil.inv_sloc = dsmh.subinventory_code
      WHERE ${latestStockDate("stock_closing_date", T("vw_daily_stock_movement_history"))}
        AND dsmh.busline_code IN ${BUSLINES}
        AND ${SLOC}
        ${inList(f.classification, "dmpm.classification", "classification")}
        ${inList(f.sku, "dmpm.mapping_code", "sku")}
        ${inList(f.branch, "sil.inv_sloc", "branch")}
        AND dsmh.qty <> 0
      ${groupBy}`;

/** The 14 branch columns of /inventory-days and the branches /service-measure keeps (1.0's lists). */
const BRANCHES = [
  ["8006", "bahawalpur"],
  ["8018", "dss_korangi"],
  ["8019", "faisalabad"],
  ["8023", "gujranwala"],
  ["8028", "hyderabad"],
  ["8029", "islamabad"],
  ["8035", "karachi"],
  ["8044", "korangi"],
  ["8046", "lahore"],
  ["8056", "mingora"],
  ["8059", "multan"],
  ["8070", "peshawar"],
  ["8072", "quetta"],
  ["8085", "sukkur"],
];

/**
 * Stock value per branch, class and item at the latest opening date in
 * 1–21 or 1–30 April 2026: hard-coded in 1.0 (GAP-001), kept.
 */
const aprilStock = (f, aprilEnd, extraSelect = "", extraGroup = "") => {
  const DSMH = T("vw_daily_stock_movement_history");
  return `
      SELECT COALESCE(dmpm.classification, 'Others') AS classification,
             MAX(sid.matnr_desc) AS PRD,
             ${SID_CODE} AS mapping_code,
             sil.inv_sloc AS branch_code,
             ${extraSelect}
             SUM(dsmh.qty * dsmh.trade_price) AS inv_val
      FROM ${DSMH} dsmh
      LEFT OUTER JOIN ${T("sap_items_detail")} sid ON sid.matnr = dsmh.item_code
      LEFT OUTER JOIN ${T("vw_items_class")} dmpm ON ${vic("dmpm")} = ${SID_CODE}
      LEFT OUTER JOIN ${SIL()} sil ON sil.inv_sloc = dsmh.subinventory_code
      WHERE ${latestStockDate("stock_opening_date", DSMH, "TIMESTAMP('2026-04-01')", `TIMESTAMP('${aprilEnd}')`)}
        AND dsmh.busline_code IN ${BUSLINES}
        AND ${SLOC}
        ${inList(f.classification, "dmpm.classification", "classification")}
        ${inList(f.sku, "dmpm.mapping_code", "sku")}
        ${inList(f.branch, "sil.inv_sloc", "branch")}
      GROUP BY sil.inv_sloc, dmpm.classification, ${extraGroup} ${SID_CODE}`;
};

/** Targets for endDate's month per branch, class and item (both 1.0 routes). */
const branchItemTargets = (f) => `
      SELECT CAST(t01.loc_code AS STRING) AS branch_code,
             COALESCE(t03.classification, 'Others') AS classification,
             ${SID_CODE} AS mapping_code,
             MAX(sid.matnr_desc) AS PRD,
             SUM(t01.target_value) AS trg_value
      FROM ${T("mv_tscl_spl_targets")} t01
      LEFT OUTER JOIN ${T("vw_items_class")} t03 ON ${vic("t03")} = CAST(t01.item_code AS STRING)
      LEFT OUTER JOIN ${T("sap_items_detail")} sid ON sid.matnr = t01.item_code
      WHERE DATE(t01.target_date) >= ${END_MONTH}
        AND DATE(t01.target_date) < ${NEXT_MONTH}
        ${inList(f.classification, "t03.classification", "classification")}
        ${inList(f.sku, "t03.mapping_code", "sku")}
        ${inList(f.branch, "t01.loc_code", "branch")}
      GROUP BY t01.loc_code, t03.classification, ${SID_CODE}`;

/** 1.0's cover_days_detail columns (daily target and cover days, 1 dp). */
const detailCols = `
      ROUND(a.trg_value / NULLIF(dc.total_days_in_month, 0), 1) AS daily_target,
      ROUND(
        (CASE WHEN ABS(COALESCE(a.inv_val, 0)) < 0.001 THEN 0 ELSE COALESCE(a.inv_val, 0) END)
        / NULLIF(a.trg_value / NULLIF(dc.total_days_in_month, 0), 0), 1) AS cover_days`;

/** Targets for endDate's month, joined to vw_items_class on item_code. */
const monthTargets = (f, select, groupBy = "") => `
      SELECT ${select}
      FROM ${T("mv_tscl_spl_targets")} t01
      LEFT OUTER JOIN ${T("vw_items_class")} t03 ON ${vic("t03")} = CAST(t01.item_code AS STRING)
      WHERE DATE(t01.target_date) >= ${END_MONTH}
        AND DATE(t01.target_date) < ${NEXT_MONTH}
        ${inList(f.classification, "t03.classification", "classification")}
        ${inList(f.sku, "t03.mapping_code", "sku")}
        ${inList(f.branch, "t01.loc_code", "branch")}
      ${groupBy}`;

const coverDaysCols = (s, ft) => `
      ROUND(${ft}.trg_value / NULLIF(dc.total_days_in_month, 0), 1) AS daily_target,
      ROUND(
        (CASE WHEN ABS(COALESCE(${s}.inv_val, 0)) < 0.001 THEN 0 ELSE COALESCE(${s}.inv_val, 0) END)
        / NULLIF(${ft}.trg_value / NULLIF(dc.total_days_in_month, 0), 0), 1) AS cover_days,
      ROUND(
        (CASE WHEN ABS(COALESCE(${s}.inv_val_efp, 0)) < 0.001 THEN 0 ELSE COALESCE(${s}.inv_val_efp, 0) END)
        / NULLIF(${ft}.trg_value / NULLIF(dc.total_days_in_month, 0), 0), 1) AS cover_days_efp`;

get(coverDays, "/", "cover-days", async (q, label) => {
  const f = filters(q);
  const sql = `
    WITH stk AS (${closingStock(
      f,
      `COALESCE(dmpm.classification, 'Others') AS classification,
       SUM(dsmh.qty * dsmh.trade_price) AS inv_val,
       SUM(dsmh.qty * dsmh.item_cost) AS inv_val_efp,
       SUM(dsmh.qty) AS quantity`,
      "GROUP BY 1",
    )}),
    filtered_targets AS (${monthTargets(f, "COALESCE(t03.classification, 'Others') AS classification, SUM(t01.target_value) AS trg_value", "GROUP BY 1")}),
    days_calc AS (SELECT ${DAYS_IN_MONTH} AS total_days_in_month)
    SELECT s.classification, s.inv_val, s.inv_val_efp, ft.trg_value, s.quantity,
      ${coverDaysCols("s", "ft")}
    FROM stk s
    LEFT JOIN filtered_targets ft ON ft.classification = s.classification
    CROSS JOIN days_calc dc
    ORDER BY s.classification`;
  return run(sql, params(q, f), label);
});

get(coverDays, "/closing-inv", "cover-days/closing-inv", async (_q, label) => {
  const sql = `SELECT MAX(dsmh.stock_closing_date) AS closing_date FROM ${T("vw_daily_stock_movement_history")} dsmh`;
  return run(sql, {}, label);
});

get(coverDays, "/total", "cover-days/total", async (q, label) => {
  const f = filters(q);
  const sql = `
    WITH stk AS (${closingStock(
      f,
      `SUM(dsmh.qty * dsmh.trade_price) AS inv_val,
       SUM(dsmh.qty * dsmh.item_cost) AS inv_val_efp,
       SUM(dsmh.qty) AS quantity`,
    )}),
    filtered_targets AS (${monthTargets(f, "SUM(t01.target_value) AS trg_value")}),
    days_calc AS (SELECT ${DAYS_IN_MONTH} AS total_days_in_month)
    SELECT s.inv_val, ft.trg_value, s.quantity, s.inv_val_efp,
      ${coverDaysCols("s", "ft")}
    FROM stk s
    CROSS JOIN filtered_targets ft
    CROSS JOIN days_calc dc`;
  return run(sql, params(q, f), label);
});

get(coverDays, "/benchmarks", "cover-days/benchmarks", async (q, label) => {
  const requested = String(q.endDate ?? "").trim();
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : new Date().toISOString().slice(0, 10);
  const sql = `${thresholdsInForce(T("cover_days"), "cd.classification, cd.days, cd.threshold, cd.effective_date", "CAST(@asOf AS DATE)")}
    ORDER BY cd.classification`;
  const data = await run(sql, { asOf }, label);
  return { as_of: asOf, data };
});

get(inventoryDays, "/", "inventory-days", async (q, label) => {
  const f = filters(q);
  const sql = `
    WITH inv_value AS (${aprilStock(f, "2026-04-21")}),
    filtered_targets AS (${branchItemTargets(f)}),
    days_calc AS (SELECT ${DAYS_IN_MONTH} AS total_days_in_month),
    aggregated AS (
      SELECT iv.classification, iv.PRD, iv.branch_code, iv.inv_val, ft.trg_value
      FROM inv_value iv
      LEFT JOIN filtered_targets ft
        ON iv.branch_code = ft.branch_code
       AND iv.classification = ft.classification
       AND CAST(iv.mapping_code AS STRING) = CAST(ft.mapping_code AS STRING)
    ),
    cover_days_detail AS (
      SELECT a.classification, a.PRD, a.branch_code, a.inv_val, a.trg_value, ${detailCols}
      FROM aggregated a
      CROSS JOIN days_calc dc
    )
    SELECT classification,
           COALESCE(PRD, 'Unknown') AS item_desc,
           ${BRANCHES.map(([code, col]) => `MAX(CASE WHEN branch_code = '${code}' THEN cover_days END) AS ${col}`).join(",\n           ")},
           ROUND(AVG(cover_days), 1) AS total
    FROM cover_days_detail
    GROUP BY classification, PRD
    ORDER BY classification, PRD NULLS LAST`;
  return run(sql, params(q, f), label);
});

get(serviceMeasure, "/", "service-measure", async (q, label) => {
  const f = filters(q);
  const sql = `
    WITH inv_value AS (${aprilStock(f, "2026-04-30", "REPLACE(sil.inv_sloc_desc, ' SELL', '') AS branch_desc,", "sil.inv_sloc_desc,")}),
    filtered_targets AS (${branchItemTargets(f)}),
    days_calc AS (SELECT ${DAYS_IN_MONTH} AS total_days_in_month),
    -- Threshold in force at endDate per class; 0 means none is set.
    thresholds AS (${thresholdsInForce(T("cover_days"), "cd.classification, NULLIF(cd.threshold, 0) AS threshold")}),
    aggregated AS (
      -- From the targets side, so every target SKU appears (as 1.0).
      SELECT ft.mapping_code, ft.classification, ft.PRD, ft.branch_code,
             REPLACE(sil.inv_sloc_desc, ' SELL', '') AS branch_desc,
             iv.inv_val, ft.trg_value
      FROM filtered_targets ft
      LEFT JOIN inv_value iv
        ON iv.branch_code = ft.branch_code
       AND iv.classification = ft.classification
       AND CAST(iv.mapping_code AS STRING) = CAST(ft.mapping_code AS STRING)
      LEFT JOIN ${SIL()} sil ON sil.inv_sloc = ft.branch_code
    ),
    cover_days_detail AS (
      SELECT a.mapping_code, a.classification, a.PRD, a.branch_code, a.branch_desc, a.inv_val, a.trg_value, ${detailCols}
      FROM aggregated a
      CROSS JOIN days_calc dc
    ),
    totals AS (
      SELECT cdd.branch_code, cdd.branch_desc, cdd.classification,
             COUNT(DISTINCT cdd.mapping_code) AS total_sku,
             COUNT(DISTINCT CASE
               WHEN COALESCE(cdd.cover_days, 0) > th.threshold AND COALESCE(cdd.cover_days, 0) < 9999 THEN cdd.mapping_code
             END) AS sku_above_threshold
      FROM cover_days_detail cdd
      LEFT JOIN thresholds th ON th.classification = cdd.classification
      GROUP BY cdd.branch_code, cdd.branch_desc, cdd.classification
    )
    SELECT t.branch_desc AS branch,
           ${["A", "B", "C", "N"]
             .map((c) => `MAX(CASE WHEN classification = '${c}' THEN ROUND(sku_above_threshold / NULLIF(total_sku, 0) * 100, 2) END) AS sku_${c.toLowerCase()}`)
             .join(",\n           ")}
    FROM totals t
    WHERE t.branch_code IN (${BRANCHES.map(([code]) => `'${code}'`).join(",")})
    GROUP BY t.branch_code, t.branch_desc
    ORDER BY t.branch_desc NULLS LAST`;
  const rows = await run(sql, params(q, f), label);
  // 1.0 column names contain - and %, which BigQuery aliases cannot.
  return rows.map((r) => ({ branch: r.branch, "SKU-A%": r.sku_a, "SKU-B%": r.sku_b, "SKU-C%": r.sku_c, "SKU-N%": r.sku_n }));
});

get(aboveBelow, "/", "above-below-threshold", async (q, label) => {
  const f = filters(q);
  const DSMH = T("vw_daily_stock_movement_history");
  const sql = `
    WITH sku_base AS (
      SELECT DISTINCT ${vic("v")} AS mapping_code, COALESCE(v.classification, 'Others') AS classification
      FROM ${T("vw_items_class")} v
      WHERE v.classification IN ('A', 'B', 'C', 'N')
    ),
    inv_value AS (
      SELECT ${SID_CODE} AS mapping_code, SUM(dsmh.qty * dsmh.trade_price) AS inv_val
      FROM ${DSMH} dsmh
      LEFT OUTER JOIN ${T("sap_items_detail")} sid ON sid.matnr = dsmh.item_code
      LEFT OUTER JOIN ${T("vw_items_class")} dmpm ON ${vic("dmpm")} = ${SID_CODE}
      WHERE ${latestStockDate("stock_opening_date", DSMH)}
        AND dsmh.busline_code IN ${BUSLINES}
        AND ${SLOC}
        ${inList(f.sku, "dmpm.mapping_code", "sku")}
        ${inList(f.branch, "dsmh.subinventory_code", "branch")}
      GROUP BY 1
    ),
    filtered_targets AS (
      SELECT ${SID_CODE} AS mapping_code, SUM(t01.target_value) AS trg_value
      FROM ${T("mv_tscl_spl_targets")} t01
      LEFT OUTER JOIN ${T("sap_items_detail")} sid ON sid.matnr = t01.item_code
      LEFT OUTER JOIN ${T("vw_items_class")} t03 ON ${vic("t03")} = ${SID_CODE}
      WHERE DATE_TRUNC(DATE(t01.target_date), MONTH) = ${END_MONTH}
        ${inList(f.sku, "t03.mapping_code", "sku")}
        ${inList(f.branch, "t01.loc_code", "branch")}
      GROUP BY 1
    ),
    days_calc AS (SELECT ${DAYS_IN_MONTH} AS total_days),
    thresholds AS (${thresholdsInForce(T("cover_days"), "cd.classification, NULLIF(cd.threshold, 0) AS threshold")}),
    sku_summary AS (
      SELECT sb.mapping_code, sb.classification,
             ROUND(COALESCE(iv.inv_val, 0) / NULLIF(COALESCE(ft.trg_value, 0) / dc.total_days, 0), 1) AS cover_days
      FROM sku_base sb
      LEFT JOIN inv_value iv ON sb.mapping_code = iv.mapping_code
      LEFT JOIN filtered_targets ft ON sb.mapping_code = ft.mapping_code
      CROSS JOIN days_calc dc
    )
    SELECT ss.classification,
           COUNT(CASE WHEN ss.cover_days > th.threshold THEN 1 END) AS above,
           COUNT(CASE WHEN ss.cover_days <= th.threshold THEN 1 END) AS below
    FROM sku_summary ss
    LEFT JOIN thresholds th ON th.classification = ss.classification
    GROUP BY ss.classification
    ORDER BY ss.classification`;
  const rows = await run(sql, params(q, f), label);
  // 1.0 column names contain spaces and < >, which BigQuery aliases cannot.
  return rows.map((r) => ({ classification: r.classification, "No Of SKUs > Threshold": r.above, "No Of SKUs < Threshold": r.below }));
});

get(tgtVsActual, "/", "tgt-vs-actual", async (q, label) => {
  const f = filters(q);
  const sql = `
    WITH stk AS (${closingStock(f, "dmpm.classification, SUM(dsmh.qty * dsmh.trade_price) AS inv_val", "GROUP BY dmpm.classification")}),
    filtered_targets AS (${monthTargets(f, "t03.classification, SUM(t01.target_value) AS trg_value", "GROUP BY t03.classification")}),
    cover_days_benchmark AS (${thresholdsInForce(T("cover_days"), "cd.classification, cd.threshold")}),
    days_calc AS (SELECT ${DAYS_IN_MONTH} AS total_days_in_month)
    SELECT s.classification,
           cdb.threshold AS cover_days_tgt,
           ROUND(
             (CASE WHEN ABS(COALESCE(s.inv_val, 0)) < 0.001 THEN 0 ELSE COALESCE(s.inv_val, 0) END)
             / NULLIF(ft.trg_value / NULLIF(dc.total_days_in_month, 0), 0), 1) AS cover_days
    FROM filtered_targets ft
    LEFT JOIN stk s ON ft.classification = s.classification
    LEFT JOIN cover_days_benchmark cdb ON cdb.classification = ft.classification
    CROSS JOIN days_calc dc
    WHERE ft.classification IN ('A', 'B', 'C', 'N')
    ORDER BY ft.classification`;
  return run(sql, params(q, f), label);
});
