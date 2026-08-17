import express from "express";
import db from "../models/index.js";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const {
      startDate,
      endDate,
      classification,
      sku,
      branch,
    } = req.query;

    const sql = `
      WITH date_range AS (
          SELECT
              :startDate::date AS cur_start,
              (:endDate::date - INTERVAL '1 day')::date AS cur_end,
              DATE_TRUNC('month', :endDate::date)::date AS month_start
      ),
      -- The budget of the selected month and nothing else: on a June date this
      -- is June's target, on July it is July's. No falling back to the previous
      -- month — a month with no target loaded reports 0 rather than borrowing
      -- an earlier figure and reading as if a target had been set.
      --
      -- target_date is always the first of its month, so the equality holds.
      -- Ungrouped on purpose: with no matching rows this still returns one row
      -- (NULL, coalesced to 0), and the final CROSS JOIN keeps its result.
      budget AS (
          SELECT COALESCE(SUM(a.value), 0) AS target_value
          FROM mv_tscl_budget a
          CROSS JOIN date_range d
          WHERE a.target_date = d.month_start
      ),
      current_sales AS (
          SELECT
              a.item_code,
              SUM(a.sold_qty) AS cur_qty
          FROM vw_mv_tscl_data_ a
          CROSS JOIN date_range d
          WHERE a.billing_date BETWEEN d.cur_start AND d.cur_end
                      ${classification ? `AND a.classification::text IN (:classification)` : ""}
                  ${sku ? `AND a.item_code::text IN (:sku)` : ""}
                  ${branch ? `AND a.branch_id::text IN (:branch)` : ""}
          GROUP BY a.item_code
      ),
      efp_latest AS (
          SELECT item_code, efp_price
          FROM (
              SELECT
                  b.item_code,
                  b."SALE E.F.P" AS efp_price,
                  ROW_NUMBER() OVER (PARTITION BY b.item_code ORDER BY b.first_date DESC) AS rn
              FROM tscl_efp b
              CROSS JOIN date_range d
              WHERE b.first_date::date < d.cur_end
                ${classification ? `AND b.classification::text IN (:classification)` : ""}
                ${sku ? `AND b.item_code::text IN (:sku)` : ""}
                ${branch ? `AND b.branch_id::text IN (:branch)` : ""}
          ) t
          WHERE rn = 1
      ),
      efp_sales AS (
          SELECT
              SUM(cs.cur_qty * COALESCE(el.efp_price, 0)) AS amount
          FROM current_sales cs
          LEFT OUTER JOIN efp_latest el ON el.item_code = cs.item_code
      )
      SELECT
          e.amount,
          b.target_value,
          CASE
              WHEN e.amount <> 0 AND b.target_value <> 0
              THEN ROUND((e.amount / b.target_value)::numeric, 2)
              ELSE 0
          END AS pct
      FROM efp_sales e
      CROSS JOIN budget b;
    `;

    const replacements = { startDate, endDate };
    if (classification) replacements.classification = Array.isArray(classification) ? classification : [classification];
    if (sku) replacements.sku = Array.isArray(sku) ? sku : [sku];
    if (branch) replacements.branch = Array.isArray(branch) ? branch : [branch];

    const results = await db.sequelize.query(sql, {
      replacements,
      type: db.sequelize.QueryTypes.SELECT,
    });
    console.log(`Fetched ${results.length} records from forecast accuracy yearly`);
    res.json({ success: true, count: results.length, data: results });
  } catch (error) {
    console.error("Error fetching forecast accuracy yearly:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching data",
      error: error.message,
    });
  }
});

export default router;


