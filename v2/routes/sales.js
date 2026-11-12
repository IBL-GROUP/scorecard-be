// Sales, targets and budget endpoints, ported from the 1.0 routes:
//   /sales-summary                       routes.sales.summary.js
//   /forecast-accuracy-monthly(/daysgone) routes.forcast.accuracy.monthly.js
//   /forecast-accuracy-yearly            routes.forcast.accuracy.yearly.js
//   /forecast-accuracy-category-monthly  routes.forcast.accuracy.category.monthly.js
//   /forecast-accuracy-category-yearly   routes.forcast.accuracy.category.yearly.js
//   /ibl-vs-tscl                         routes.ibl.vs.tscl.js
//
// Behaviour is copied as it is today, including the known gaps (GAP-004:
// budget accuracy stops the day before endDate; GAP-007: no date validation and
// the March 2026 default on /forecast-accuracy-monthly). PostgreSQL's
// `x = x` predicates, which drop NULLs, are written as `x IS NOT NULL`.
import { run } from "../bq.js";
import { T } from "../sources.js";
import { filters, get, inList, newRouter, str } from "../http.js";
import { END, END_MONTH, NEXT_MONTH, START, pgFmMonthLabel, pgMonthLabel } from "../sql.js";

export const salesSummary = newRouter();
export const faMonthly = newRouter();
export const faYearly = newRouter();
export const faCategoryMonthly = newRouter();
export const faCategoryYearly = newRouter();
export const iblVsTscl = newRouter();

const params = (q, f, extra = {}) => ({ startDate: str(q.startDate), endDate: str(q.endDate), ...f, ...extra });

get(salesSummary, "/", "sales-summary", async (q, label) => {
  const f = filters(q);
  const sql = `
    WITH sale AS (
      SELECT a.item_code, a.classification, SUM(a.amount) AS amount, 0 AS target_value
      FROM ${T("vw_mv_tscl_data_")} a
      WHERE a.billing_date BETWEEN ${START} AND ${END}
        ${inList(f.classification, "a.classification", "classification")}
        ${inList(f.sku, "a.item_code", "sku")}
        ${inList(f.branch, "a.branch_id", "branch")}
        AND a.classification IS NOT NULL AND a.branch_id IS NOT NULL AND a.item_code IS NOT NULL
      GROUP BY a.classification, a.item_code
      HAVING SUM(a.amount) != 0
    )
    SELECT a.classification, COUNT(DISTINCT a.item_code) AS sku, SUM(a.amount) AS amount
    FROM sale a
    GROUP BY a.classification`;
  return run(sql, params(q, f), label);
});

/** Monthly targets (mv_tscl_spl_targets) with the 1.0 filters and NOT NULL predicates. */
const targetFilters = (f, b = "b") => `
        ${inList(f.classification, `${b}.classification`, "classification")}
        ${inList(f.sku, `${b}.item_code`, "sku")}
        ${inList(f.branch, `${b}.loc_code`, "branch")}
        AND ${b}.loc_code IS NOT NULL AND ${b}.item_code IS NOT NULL`;

get(faMonthly, "/daysgone", "forecast-accuracy-monthly/daysgone", async (q, label) => {
  const f = filters(q);
  const sql = `
    SELECT 0 AS amount, SUM(b.target_value) AS target_value
    FROM ${T("mv_tscl_spl_targets")} b
    WHERE DATE(b.target_date) BETWEEN ${START} AND ${END}
      ${targetFilters(f)}`;
  return run(sql, params(q, f, { startDate: str(q.startDate) ?? "2026-03-01", endDate: str(q.endDate) ?? "2026-03-31" }), label);
});

get(faMonthly, "/", "forecast-accuracy-monthly", async (q, label) => {
  const f = filters(q);
  const sql = `
    WITH sale AS (
      SELECT SUM(a.amount) AS amount, 0 AS target_value
      FROM ${T("vw_mv_tscl_data_")} a
      WHERE a.billing_date BETWEEN ${START} AND ${END}
        ${inList(f.classification, "a.classification", "classification")}
        ${inList(f.sku, "a.item_code", "sku")}
        ${inList(f.branch, "a.branch_id", "branch")}
        AND a.classification IS NOT NULL AND a.branch_id IS NOT NULL AND a.item_code IS NOT NULL
      UNION ALL
      SELECT 0 AS amount, SUM(b.target_value) AS target_value
      FROM ${T("mv_tscl_spl_targets")} b
      -- Every month the selected window touches.
      WHERE DATE(b.target_date) >= DATE_TRUNC(${START}, MONTH)
        AND DATE(b.target_date) < ${NEXT_MONTH}
        ${targetFilters(f)}
    )
    SELECT SUM(amount) AS amount, SUM(target_value) AS target_value,
           SUM(amount) / NULLIF(SUM(target_value), 0) AS pct
    FROM sale`;
  return run(sql, params(q, f, { startDate: str(q.startDate) ?? "2026-03-01", endDate: str(q.endDate) ?? "2026-03-31" }), label);
});

get(faYearly, "/", "forecast-accuracy-yearly", async (q, label) => {
  const f = filters(q);
  const sql = `
    WITH date_range AS (
      SELECT ${START} AS cur_start,
             DATE_SUB(${END}, INTERVAL 1 DAY) AS cur_end,      -- GAP-004: the last day is left out
             DATE_TRUNC(${START}, MONTH) AS start_month,
             ${END_MONTH} AS end_month,
             LEAST(${END}, CURRENT_DATE(@tz)) AS elapsed_end
    ),
    -- Budget of every month the window touches; target_to_date prorates each
    -- month by the share of its days the window covers, up to today.
    budget AS (
      SELECT
        COALESCE(SUM(a.value), 0) AS target_value,
        COALESCE(SUM(
          a.value
          * GREATEST(DATE_DIFF(LEAST(m.month_end, d.elapsed_end), GREATEST(m.td, d.cur_start), DAY) + 1, 0)
          / (DATE_DIFF(m.month_end, m.td, DAY) + 1)
        ), 0) AS target_to_date
      FROM ${T("mv_tscl_budget")} a
      CROSS JOIN date_range d
      CROSS JOIN UNNEST([STRUCT(
        DATE(a.target_date) AS td,
        DATE_SUB(DATE_ADD(DATE(a.target_date), INTERVAL 1 MONTH), INTERVAL 1 DAY) AS month_end
      )]) m
      WHERE DATE(a.target_date) BETWEEN d.start_month AND d.end_month
        ${inList(f.classification, "a.classification", "classification")}
        ${inList(f.sku, "a.item_code", "sku")}
    ),
    current_sales AS (
      SELECT a.item_code, SUM(a.sold_qty) AS cur_qty
      FROM ${T("vw_mv_tscl_data_")} a
      CROSS JOIN date_range d
      WHERE a.billing_date BETWEEN d.cur_start AND d.cur_end
        ${inList(f.classification, "a.classification", "classification")}
        ${inList(f.sku, "a.item_code", "sku")}
        ${inList(f.branch, "a.branch_id", "branch")}
      GROUP BY a.item_code
    ),
    efp_latest AS (
      SELECT item_code, efp_price FROM (
        SELECT b.item_code, b.sales_efp AS efp_price,   -- 1.0: "SALE E.F.P" (question F4)
               ROW_NUMBER() OVER (PARTITION BY b.item_code ORDER BY b.first_date DESC) AS rn
        FROM ${T("tscl_efp")} b
        CROSS JOIN date_range d
        WHERE DATE(b.first_date) < d.cur_end
          ${inList(f.classification, "b.classification", "classification")}
          ${inList(f.sku, "b.item_code", "sku")}
          ${inList(f.branch, "b.branch_id", "branch")}
      ) t
      WHERE rn = 1
    ),
    efp_sales AS (
      SELECT SUM(cs.cur_qty * COALESCE(el.efp_price, 0)) AS amount
      FROM current_sales cs
      LEFT OUTER JOIN efp_latest el ON el.item_code = cs.item_code
    )
    SELECT e.amount, b.target_value, b.target_to_date,
           CASE WHEN e.amount <> 0 AND b.target_value <> 0 THEN ROUND(e.amount / b.target_value, 2) ELSE 0 END AS pct
    FROM efp_sales e
    CROSS JOIN budget b`;
  return run(sql, params(q, f, { tz: process.env.V2_TIMEZONE || "UTC" }), label);
});

get(faCategoryMonthly, "/", "forecast-accuracy-category-monthly", async (q, label) => {
  const f = filters(q);
  const sql = `
    WITH sale AS (
      SELECT a.classification,
             DATE_TRUNC(a.billing_date, MONTH) AS month_date,
             ${pgMonthLabel("DATE_TRUNC(a.billing_date, MONTH)")} AS month,
             SUM(a.amount) AS amount, 0 AS target_value
      FROM ${T("vw_mv_tscl_data_")} a
      WHERE a.billing_date >= DATE_SUB(${END_MONTH}, INTERVAL 2 MONTH)
        AND a.billing_date < DATE_ADD(${END}, INTERVAL 1 DAY)
        ${inList(f.classification, "a.classification", "classification")}
        ${inList(f.sku, "a.item_code", "sku")}
        ${inList(f.branch, "a.branch_id", "branch")}
      GROUP BY a.classification, month_date, month
      UNION ALL
      SELECT b.classification,
             DATE_TRUNC(DATE(b.target_date), MONTH) AS month_date,
             ${pgMonthLabel("DATE_TRUNC(DATE(b.target_date), MONTH)")} AS month,
             0 AS amount, SUM(b.target_value) AS target_value
      FROM ${T("mv_tscl_spl_targets")} b
      WHERE DATE(b.target_date) >= DATE_SUB(${END_MONTH}, INTERVAL 2 MONTH)
        AND DATE(b.target_date) < DATE_ADD(${END}, INTERVAL 1 DAY)
        ${targetFilters(f)}
      GROUP BY b.classification, month_date, month
    )
    SELECT COALESCE(a.classification, 'Others') AS classification, a.month,
           SUM(amount) AS amount, SUM(target_value) AS target_value,
           CASE WHEN SUM(amount) <> 0 AND SUM(target_value) <> 0
                THEN ROUND(SUM(amount) / SUM(target_value) * 100, 2) ELSE 0 END AS pct
    FROM sale a
    GROUP BY 1, a.month_date, a.month
    ORDER BY a.month_date DESC, 1`;
  return run(sql, { endDate: str(q.endDate), ...f }, label);
});

get(faCategoryYearly, "/", "forecast-accuracy-category-yearly", async (q, label) => {
  const f = filters(q);
  const salesWhere = `
        a.billing_date >= DATE_SUB(${END_MONTH}, INTERVAL 2 MONTH)
        AND a.billing_date < ${NEXT_MONTH}
        ${inList(f.classification, "a.classification", "classification")}
        ${inList(f.sku, "a.item_code", "sku")}
        ${inList(f.branch, "a.branch_id", "branch")}`;
  // 1.0 used LEFT JOIN LATERAL (… ORDER BY priority, first_date DESC LIMIT 1)
  // per sales row. The pick depends only on (item_code, billing month), so it
  // is computed once per pair here, with the same priority order:
  //   0 this month's price when non-zero, 1 last month's, 2 this month's zero.
  const sql = `
    WITH sale_months AS (
      SELECT DISTINCT a.item_code, DATE_TRUNC(a.billing_date, MONTH) AS m
      FROM ${T("vw_mv_tscl_data_")} a
      WHERE ${salesWhere}
    ),
    efp_pick AS (
      SELECT sm.item_code, sm.m,
        ARRAY_AGG(STRUCT(e.sales_efp AS v) ORDER BY
          CASE
            WHEN DATE_TRUNC(DATE(e.first_date), MONTH) = sm.m AND COALESCE(e.sales_efp, 0) <> 0 THEN 0
            WHEN DATE_TRUNC(DATE(e.first_date), MONTH) = DATE_SUB(sm.m, INTERVAL 1 MONTH) THEN 1
            WHEN DATE_TRUNC(DATE(e.first_date), MONTH) = sm.m THEN 2
            ELSE 3
          END,
          e.first_date DESC
          LIMIT 1)[OFFSET(0)].v AS efp
      FROM sale_months sm
      JOIN ${T("tscl_efp")} e
        ON e.item_code = sm.item_code
       AND DATE_TRUNC(DATE(e.first_date), MONTH) IN (sm.m, DATE_SUB(sm.m, INTERVAL 1 MONTH))
      -- tscl_efp requires a first_date filter (partitioned). The join above only
      -- ever matches the months endDate-3 … endDate, so this removes nothing.
      WHERE e.first_date >= TIMESTAMP(DATE_SUB(${END_MONTH}, INTERVAL 3 MONTH))
        AND e.first_date < TIMESTAMP(${NEXT_MONTH})
      GROUP BY sm.item_code, sm.m
    ),
    sale AS (
      SELECT a.classification,
             DATE_TRUNC(a.billing_date, MONTH) AS month_date,
             ${pgFmMonthLabel("DATE_TRUNC(a.billing_date, MONTH)")} AS month,
             SUM(a.sold_qty * COALESCE(p.efp, 0)) AS amount, 0 AS target_value
      FROM ${T("vw_mv_tscl_data_")} a
      LEFT JOIN efp_pick p ON p.item_code = a.item_code AND p.m = DATE_TRUNC(a.billing_date, MONTH)
      WHERE ${salesWhere}
      GROUP BY a.classification, month_date, month
      UNION ALL
      SELECT COALESCE(b.classification, 'Others') AS classification,
             DATE_TRUNC(DATE(b.target_date), MONTH) AS month_date,
             ${pgFmMonthLabel("DATE_TRUNC(DATE(b.target_date), MONTH)")} AS month,
             0 AS amount, SUM(b.value) AS target_value
      FROM ${T("mv_tscl_budget")} b
      WHERE DATE(b.target_date) >= DATE_SUB(${END_MONTH}, INTERVAL 2 MONTH)
        AND DATE(b.target_date) < ${NEXT_MONTH}
        ${inList(f.classification, "b.classification", "classification")}
        ${inList(f.sku, "b.item_code", "sku")}
      GROUP BY 1, month_date, month
    )
    SELECT COALESCE(a.classification, 'Others') AS classification, a.month,
           SUM(amount) AS amount, SUM(target_value) AS target_value,
           CASE WHEN SUM(amount) <> 0 AND SUM(target_value) <> 0
                THEN ROUND(SUM(amount) / SUM(target_value) * 100, 2) ELSE 0 END AS pct
    FROM sale a
    GROUP BY 1, a.month_date, a.month
    ORDER BY a.month_date DESC, 1`;
  return run(sql, { endDate: str(q.endDate), ...f }, label);
});

get(iblVsTscl, "/", "ibl-vs-tscl", async (q, label) => {
  const f = filters(q);
  const sql = `
    WITH ibl_target AS (
      SELECT COALESCE(b.classification, 'Others') AS classification, SUM(b.target_value) AS target_value
      FROM ${T("mv_tscl_spl_targets")} b
      WHERE DATE_TRUNC(DATE(b.target_date), MONTH) = ${END_MONTH}
        ${targetFilters(f)}
      GROUP BY 1
    ),
    tscl_target AS (
      SELECT COALESCE(b.classification, 'Others') AS classification, SUM(b.value) AS target_value
      FROM ${T("mv_tscl_budget")} b
      WHERE DATE_TRUNC(DATE(b.target_date), MONTH) = ${END_MONTH}
        ${inList(f.classification, "b.classification", "classification")}
        ${inList(f.sku, "b.item_code", "sku")}
        AND b.item_code IS NOT NULL
      GROUP BY 1
    ),
    combined AS (
      SELECT COALESCE(i.classification, t.classification, 'Others') AS classification,
             COALESCE(i.target_value, 0) AS ibl_target,
             COALESCE(t.target_value, 0) AS tscl_target
      FROM ibl_target i
      FULL OUTER JOIN tscl_target t ON i.classification = t.classification
    )
    SELECT classification, ibl_target, tscl_target,
           CASE WHEN tscl_target <> 0 THEN ROUND(ibl_target / tscl_target * 100, 2) ELSE 0 END AS ibl_vs_tscl_pct
    FROM combined
    UNION ALL
    SELECT 'Total', SUM(ibl_target), SUM(tscl_target),
           CASE WHEN SUM(tscl_target) <> 0 THEN ROUND(SUM(ibl_target) / SUM(tscl_target) * 100, 2) ELSE 0 END
    FROM combined`;
  return run(sql, { endDate: str(q.endDate), ...f }, label);
});
