// Spot check for stories S3/S4 (TC-S3-08, AC-S3-3, AC-S4-3): computes KPIs
// straight from the BigQuery source tables with the PRD v2 formulas, written
// here independently of v2/routes, and prints them as JSON. A browser script
// compares them with what the 2.0 screen shows.
//
//   node v2/scripts/spotcheck.mjs 2026-11-01 2026-11-11 [today]
//
// Read-only: SELECT statements through the v2 runner (guard + bytes cap).
import { run } from "../bq.js";

const [start, end, todayArg] = process.argv.slice(2);
const today = todayArg || end;
const E = "`data-light-house-prod.EDW";
const p = { s: start, e: end };
const one = async (sql, params = p) => (await run(sql, params, "spotcheck"))[0];

const dim = new Date(Date.UTC(+end.slice(0, 4), +end.slice(5, 7), 0)).getUTCDate();
const day = Math.min(+((end < today ? end : today).slice(8, 10)), dim);
const monthStart = `${end.slice(0, 8)}01`;
const monthEnd = `${end.slice(0, 8)}${String(dim).padStart(2, "0")}`;

// Sales (TP) in the window, with 1.0's NOT NULL conditions.
const sales = await one(`SELECT SUM(amount) v FROM ${E}.vw_mv_tsc_data\` a
  WHERE billing_date BETWEEN DATE(@s) AND DATE(@e)
    AND classification IS NOT NULL AND branch_id IS NOT NULL AND item_code IS NOT NULL`);
// IBL target to date and for the whole month (daily rows).
const tgt = await one(`SELECT
    SUM(IF(DATE(target_date) BETWEEN DATE(@s) AND DATE(@e), target_value, 0)) td,
    SUM(IF(DATE(target_date) BETWEEN DATE(@ms) AND DATE(@me), target_value, 0)) full_month
  FROM ${E}.vw_tscl_spl_targets\`
  WHERE loc_code IS NOT NULL AND item_code IS NOT NULL AND DATE(target_date) BETWEEN DATE(@ms) AND DATE(@me)`, { ...p, ms: monthStart, me: monthEnd });
const budget = await one(`SELECT COUNT(*) n, SUM(value) v FROM ${E}.vw_tscl_budget\` WHERE DATE_TRUNC(DATE(target_date), MONTH) = DATE(@ms)`, { ms: monthStart });

// Range activation: SKUs sold (sales summary rule) ÷ SKUs in range (vw_items_class), classes A, B, C, N.
const range = await one(`
  WITH sold AS (
    SELECT classification, COUNT(*) n FROM (
      SELECT classification, item_code FROM ${E}.vw_mv_tsc_data\`
      WHERE billing_date BETWEEN DATE(@s) AND DATE(@e)
        AND classification IS NOT NULL AND branch_id IS NOT NULL AND item_code IS NOT NULL
      GROUP BY 1, 2 HAVING SUM(amount) != 0)
    GROUP BY 1),
  inrange AS (SELECT classification, COUNT(mapping_code) n FROM ${E}.vw_items_class\` GROUP BY 1)
  SELECT (SELECT SUM(n) FROM sold WHERE classification IN ('A','B','C','N')) sold,
         (SELECT SUM(n) FROM inrange WHERE classification IN ('A','B','C','N')) in_range`);

// Stock at the latest closing date in the window, per class (TP and cost).
const stock = await run(`
  WITH d AS (
    SELECT MAX(stock_closing_date) cd FROM ${E}.vw_daily_stock_movement_history\`
    WHERE stock_closing_date BETWEEN TIMESTAMP(@s) AND TIMESTAMP(@e) AND busline_code IN ('P07','P08','P12','P01','P35')),
  s AS (
    SELECT COALESCE(c.classification, 'Others') cls, SUM(h.qty * h.trade_price) tp, SUM(h.qty * h.item_cost) cost
    FROM ${E}.vw_daily_stock_movement_history\` h
    LEFT JOIN ${E}.vw_items_class\` c
      ON CAST(c.mapping_code AS STRING) = IF(REGEXP_CONTAINS(h.item_code, r'^[0-9]+$'), CAST(CAST(h.item_code AS INT64) AS STRING), h.item_code)
    WHERE h.stock_closing_date = (SELECT cd FROM d) AND h.busline_code IN ('P07','P08','P12','P01','P35')
      AND (h.subinventory_code LIKE '80%' OR h.subinventory_code IN ('8206','8210')) AND h.qty <> 0
    GROUP BY 1),
  t AS (
    SELECT COALESCE(c.classification, 'Others') cls, SUM(t.target_value) trg
    FROM ${E}.vw_tscl_spl_targets\` t
    LEFT JOIN ${E}.vw_items_class\` c ON CAST(c.mapping_code AS STRING) = t.item_code
    WHERE DATE(t.target_date) BETWEEN DATE(@ms) AND DATE(@me)
    GROUP BY 1),
  b AS (
    SELECT classification cls, days FROM ${E}.cover_days\`
    WHERE effective_date <= DATE(@e)
    QUALIFY ROW_NUMBER() OVER (PARTITION BY classification ORDER BY effective_date DESC) = 1)
  SELECT s.cls, s.tp, s.cost, t.trg, b.days bm FROM s LEFT JOIN t USING (cls) LEFT JOIN b USING (cls)`, { ...p, ms: monthStart, me: monthEnd }, "spotcheck");
const allTrg = await one(`SELECT SUM(target_value) v FROM ${E}.vw_tscl_spl_targets\` WHERE DATE(target_date) BETWEEN DATE(@ms) AND DATE(@me)`, { ms: monthStart, me: monthEnd });

let tpTotal = 0, costTotal = 0, wNum = 0, wDen = 0, excess = 0;
for (const r of stock) {
  tpTotal += r.tp;
  costTotal += r.cost;
  const dt = (r.trg || 0) / dim;
  if (r.bm > 0 && dt > 0) {
    wNum += r.bm * dt;
    wDen += dt;
    const cd = r.tp / dt;
    excess += Math.max(0, cd - r.bm) * dt * (r.tp > 0 ? r.cost / r.tp : 0);
  }
}
const totalCd = tpTotal / (allTrg.v / dim);
const wBm = wDen ? wNum / wDen : null;

// Fill rate: Σ delivered ÷ Σ ordered by goods-issue date.
const fill = await one(`SELECT SUM(deliverd_qty) d, SUM(so_quantity) o FROM ${E}.vw_dispatch_vs_order\`
  WHERE actual_gm_date BETWEEN TIMESTAMP(@s) AND TIMESTAMP(@e) AND (order_date IS NULL OR order_date >= TIMESTAMP('1900-01-01'))`);
// RMPM at the latest execution date in the window (1.0 rule, see question F6).
const rmpm = await one(`
  WITH x AS (SELECT MAX(executiondate) ed FROM ${E}.vw_sap_tpkg_traw_data\`
             WHERE executiondate BETWEEN TIMESTAMP(@s) AND TIMESTAMP(@e) AND (recorddate IS NULL OR recorddate >= TIMESTAMP('1900-01-01')))
  SELECT SUM(valuatedgrblocked + valueunrestricted + valuequalityinspection + valuereturns + valuestktransferstloc
             + valuestocktransferplant + valuestockintransit + valueblocked + valuerestricted + valuetiedempties) total,
         SUM(valueblocked + valuequalityinspection + valuerestricted + valuereturns) held
  FROM ${E}.vw_sap_tpkg_traw_data\`
  WHERE executiondate = (SELECT ed FROM x) AND (recorddate IS NULL OR recorddate >= TIMESTAMP('1900-01-01'))`);

const S = sales.v, Ttd = tgt.td, T = tgt.full_month;
console.log(
  JSON.stringify({
    window: { start, end, today, daysGone: day, daysInMonth: dim },
    "RV-01": S,
    "EX-01": (S / Ttd) * 100,
    "EX-02": ((S / day) * dim / T) * 100,
    "RV-05": (T - S) / (dim - day),
    "EX-03": budget.n > 0 && budget.v > 0 ? "budget loaded" : "no budget",
    "RV-10": (range.sold / range.in_range) * 100,
    "EX-04": wBm ? (totalCd / wBm) * 100 : null,
    "IN-02": costTotal,
    "EX-08": excess,
    "EX-06": (fill.d / fill.o) * 100,
    "OP-09": rmpm.total,
    "OP-11": rmpm.total ? (rmpm.held / rmpm.total) * 100 : null,
  }),
);
