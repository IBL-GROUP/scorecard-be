import express from "express";
import db from "../models/index.js";

const router = express.Router();

router.get("/daysgone", async (req, res) => {
  try {
    const {
      startDate = "2026-03-01",
      endDate = "2026-03-31",
      classification,
      sku,
      branch,
    } = req.query;

    const sql = `
      SELECT
          0 AS amount,
          SUM(target_value) AS target_value
      FROM mv_tscl_spl_targets b
      WHERE b.target_date::date BETWEEN :startDate AND :endDate
      ${classification ? `AND COALESCE(b.classification, 'Others')::text IN (:classification)` : ""}
      ${sku ? `AND b.item_code::text IN (:sku)` : ""}
      ${branch ? `AND b.loc_code::text IN (:branch)` : ""}
      and COALESCE(b.classification, 'Others')  = COALESCE(b.classification, 'Others')
      and b.loc_code  = b.loc_code and  b.item_code = b.item_code;
    `;

    const replacements = { startDate, endDate };
    if (classification) replacements.classification = Array.isArray(classification) ? classification : [classification];
    if (sku) replacements.sku = Array.isArray(sku) ? sku : [sku];
    if (branch) replacements.branch = Array.isArray(branch) ? branch : [branch];

    const results = await db.sequelize.query(sql, {
      replacements,
      type: db.sequelize.QueryTypes.SELECT,
    });
    console.log(`Fetched ${results.length} records from forecast accuracy daysgone`);
    res.json({ success: true, count: results.length, data: results });
  } catch (error) {
    console.error("Error fetching forecast accuracy daysgone:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching data",
      error: error.message,
    });
  }
});

router.get("/", async (req, res) => {
  try {
    const {
      startDate = "2026-03-01",
      endDate = "2026-03-31",
      classification,
      sku,
      branch,
    } = req.query;

    const sql = `
      WITH sale AS (
          SELECT
              SUM(amount) AS amount,
              0           AS target_value
          FROM vw_mv_tscl_data_ a
          WHERE a.billing_date BETWEEN :startDate AND :endDate
      ${classification ? `AND a.classification::text IN (:classification)` : ""}
      ${sku ? `AND a.item_code::text IN (:sku)` : ""}
      ${branch ? `AND a.branch_id::text IN (:branch)` : ""}
      and a.classification = a.classification and
      a.branch_id = a.branch_id and  item_code = item_code
          UNION ALL
          SELECT
              0               AS amount,
              SUM(target_value) AS target_value
          FROM mv_tscl_spl_targets b
          -- Every month the selected window touches, the same span the sales
          -- above are summed over.
          WHERE b.target_date >= DATE_TRUNC('month', CAST(:startDate AS date))
            AND b.target_date < DATE_TRUNC('month', CAST(:endDate AS date)) + INTERVAL '1 month'
          ${classification ? `AND COALESCE(b.classification, 'Others')::text IN (:classification)` : ""}
          ${sku ? `AND b.item_code::text IN (:sku)` : ""}
          ${branch ? `AND b.loc_code::text IN (:branch)` : ""}
          and COALESCE(b.classification, 'Others')  = COALESCE(b.classification, 'Others')  
        and b.loc_code  = b.loc_code and  b.item_code = b.item_code
      )
      SELECT
          SUM(amount)       AS amount,
          SUM(target_value) AS target_value,
          SUM(amount)/NULLIF(SUM(target_value), 0) as pct
      FROM sale a;
    `;

    const replacements = { startDate, endDate };
    if (classification) replacements.classification = Array.isArray(classification) ? classification : [classification];
    if (sku) replacements.sku = Array.isArray(sku) ? sku : [sku];
    if (branch) replacements.branch = Array.isArray(branch) ? branch : [branch];

    const results = await db.sequelize.query(sql, {
      replacements,
      type: db.sequelize.QueryTypes.SELECT,
    });
    console.log(`Fetched ${results.length} records from forecast accuracy monthly`);
    res.json({ success: true, count: results.length, data: results });
  } catch (error) {
    console.error("Error fetching forecast accuracy monthly:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching data",
      error: error.message,
    });
  }
});

export default router;
