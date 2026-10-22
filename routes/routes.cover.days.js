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
        WITH max_dates AS (
            SELECT
                d.item_code,
                MAX(d.stock_closing_date) AS max_closing_date
            FROM daily_stock_movement_history d
            WHERE d.stock_closing_date BETWEEN :startDate AND :endDate
            AND d.busline_code IN ('P07','P08','P12','P01','P35')
            GROUP BY d.item_code
        ),
        stk AS (
            SELECT
                COALESCE(dmpm.classification, 'Others') AS classification,
                SUM(dsmh.qty * dsmh.trade_price) AS inv_val,
                SUM(dsmh.qty * dsmh.item_cost) AS inv_val_efp,
                SUM(dsmh.qty) as quantity
            FROM daily_stock_movement_history dsmh
            JOIN max_dates md
                ON md.item_code = dsmh.item_code
                AND md.max_closing_date = dsmh.stock_closing_date
            LEFT OUTER JOIN mv_item_list dmpm
                ON dmpm.item_code::TEXT = dsmh.item_code::text
        --        CASE
        --            WHEN dsmh.item_code NOT LIKE 'F%' THEN (dsmh.item_code::bigint)::TEXT
        --            ELSE dsmh.item_code
        --        END
            LEFT OUTER JOIN sales_inv_locations sil ON sil.inv_sloc::TEXT = subinventory_code
            WHERE
            dsmh.busline_code IN ('P07','P08','P12','P01','P35')
            AND (dsmh.subinventory_code LIKE '80%' or dsmh.subinventory_code = '8206' or dsmh.subinventory_code = '8210')
        ${classification ? `AND dmpm.classification::text IN (:classification)` : ""}
        ${sku ? `AND dmpm.item_code::text IN (:sku)` : ""}
        ${branch ? `AND sil.inv_sloc::text IN (:branch)` : ""}
        --    and dmpm.item_code = '1219000680'
            AND qty <> 0
            GROUP BY COALESCE(dmpm.classification, 'Others')
        ),
        filtered_targets AS (
            SELECT
            COALESCE(t03.classification, 'Others') AS classification,
            SUM(t01.target_value) AS trg_value
            FROM mv_tscl_spl_targets t01
            LEFT OUTER JOIN mv_item_list t03 ON t03.item_code::TEXT = t01.item_code::TEXT
            WHERE t01.target_date >= DATE_TRUNC('month', CAST(:endDate AS date))
            AND t01.target_date < DATE_TRUNC('month', CAST(:endDate AS date)) + INTERVAL '1 month'
        ${classification ? `AND t03.classification::text IN (:classification)` : ""}
        ${sku ? `AND t03.item_code::text IN (:sku)` : ""}
        ${branch ? `AND t01.loc_code::text IN (:branch)` : ""}
        --    and  t01.item_code = '1219000680'
            GROUP BY COALESCE(t03.classification, 'Others')
        ),
        days_calc AS (
            SELECT EXTRACT(DAY FROM (
                DATE_TRUNC('month', CAST(:endDate AS date)) + INTERVAL '1 month - 1 day'
            ))::int AS total_days_in_month
        )
        SELECT
            ft.classification,
            s.inv_val,
            s.inv_val_efp,
            ft.trg_value,
            s.quantity,
            ROUND(ft.trg_value::numeric / NULLIF(dc.total_days_in_month, 0), 1) AS daily_target,
            ROUND(
                CASE
                    WHEN ABS(COALESCE(s.inv_val, 0)) < 0.001 THEN 0
                    ELSE COALESCE(s.inv_val, 0)
                END::numeric /
                NULLIF(ft.trg_value::numeric / NULLIF(dc.total_days_in_month, 0), 0)
            , 1) AS cover_days,
            ROUND(
                CASE
                    WHEN ABS(COALESCE(s.inv_val_efp, 0)) < 0.001 THEN 0
                    ELSE COALESCE(s.inv_val_efp, 0)
                END::numeric /
                NULLIF(ft.trg_value::numeric / NULLIF(dc.total_days_in_month, 0), 0)
            , 1) AS cover_days_efp
        FROM filtered_targets ft
        LEFT JOIN stk s ON s.classification = ft.classification
        CROSS JOIN days_calc dc
        ORDER BY ft.classification;
    `;

    const replacements = { startDate, endDate };
    if (branch) replacements.branch = Array.isArray(branch) ? branch : [branch];
    if (classification) replacements.classification = Array.isArray(classification) ? classification : [classification];
    if (sku) replacements.sku = Array.isArray(sku) ? sku : [sku];

    const results = await db.sequelize.query(sql, {
      replacements,
      type: db.sequelize.QueryTypes.SELECT,
    });
    console.log(`Fetched ${results.length} records from cover days`);
    res.json({ success: true, count: results.length, data: results });
  } catch (error) {
    console.error("Error fetching cover days:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching data",
      error: error.message,
    });
  }
});

router.get("/closing-inv", async (_req, res) => {
  try {
    const sql = `select max(dsmh.stock_closing_date) as closing_date FROM daily_stock_movement_history dsmh;`;

    const results = await db.sequelize.query(sql, {
      type: db.sequelize.QueryTypes.SELECT,
    });
    console.log(`Fetched ${results.length} records from cover days`);
    res.json({ success: true, count: results.length, data: results });
  } catch (error) {
    console.error("Error fetching cover days:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching data",
      error: error.message,
    });
  }
});

router.get("/total", async (req, res) => {
  try {
    const {
      startDate,
      endDate,
      classification,
      sku,
      branch,
    } = req.query;

    const sql = `
        WITH max_dates AS (
            SELECT
                d.item_code,
                MAX(d.stock_closing_date) AS max_closing_date
            FROM daily_stock_movement_history d
            WHERE d.stock_closing_date BETWEEN :startDate AND :endDate
            AND d.busline_code IN ('P07','P08','P12','P01','P35')
            GROUP BY d.item_code
        ),
        stk AS (
            SELECT
                SUM(dsmh.qty * dsmh.trade_price) AS inv_val,
                SUM(dsmh.qty * dsmh.item_cost) AS inv_val_efp,
                SUM(dsmh.qty) as quantity
            FROM daily_stock_movement_history dsmh
            JOIN max_dates md
                ON md.item_code = dsmh.item_code
                AND md.max_closing_date = dsmh.stock_closing_date
            LEFT OUTER JOIN mv_item_list dmpm
                ON dmpm.item_code::TEXT = dsmh.item_code::text
            LEFT OUTER JOIN sales_inv_locations sil ON sil.inv_sloc::TEXT = subinventory_code
            WHERE
            dsmh.busline_code IN ('P07','P08','P12','P01','P35')
            AND (dsmh.subinventory_code LIKE '80%' or dsmh.subinventory_code = '8206' or dsmh.subinventory_code = '8210')
        ${classification ? `AND dmpm.classification::text IN (:classification)` : ""}
        ${sku ? `AND dmpm.item_code::text IN (:sku)` : ""}
        ${branch ? `AND sil.inv_sloc::text IN (:branch)` : ""}
            AND qty <> 0
        ),
        filtered_targets AS (
            SELECT
            SUM(t01.target_value) AS trg_value
            FROM mv_tscl_spl_targets t01
            LEFT OUTER JOIN mv_item_list t03 ON t03.item_code::TEXT = t01.item_code::TEXT
            WHERE t01.target_date >= DATE_TRUNC('month', CAST(:endDate AS date))
            AND t01.target_date < DATE_TRUNC('month', CAST(:endDate AS date)) + INTERVAL '1 month'
        ${classification ? `AND t03.classification::text IN (:classification)` : ""}
        ${sku ? `AND t03.item_code::text IN (:sku)` : ""}
        ${branch ? `AND t01.loc_code::text IN (:branch)` : ""}
        ),
        days_calc AS (
            SELECT EXTRACT(DAY FROM (
                DATE_TRUNC('month', CAST(:endDate AS date)) + INTERVAL '1 month - 1 day'
            ))::int AS total_days_in_month
        )
        SELECT
            s.inv_val,
            s.inv_val_efp,
            ft.trg_value,
            s.quantity,
            ROUND(ft.trg_value::numeric / NULLIF(dc.total_days_in_month, 0), 1) AS daily_target,
            ROUND(
                CASE
                    WHEN ABS(COALESCE(s.inv_val, 0)) < 0.001 THEN 0
                    ELSE COALESCE(s.inv_val, 0)
                END::numeric /
                NULLIF(ft.trg_value::numeric / NULLIF(dc.total_days_in_month, 0), 0)
            , 1) AS cover_days,
            ROUND(
                CASE
                    WHEN ABS(COALESCE(s.inv_val_efp, 0)) < 0.001 THEN 0
                    ELSE COALESCE(s.inv_val_efp, 0)
                END::numeric /
                NULLIF(ft.trg_value::numeric / NULLIF(dc.total_days_in_month, 0), 0)
            , 1) AS cover_days_efp
        FROM stk s
        CROSS JOIN filtered_targets ft
        CROSS JOIN days_calc dc;
    `;

    const replacements = { startDate, endDate };
    if (branch) replacements.branch = Array.isArray(branch) ? branch : [branch];
    if (classification) replacements.classification = Array.isArray(classification) ? classification : [classification];
    if (sku) replacements.sku = Array.isArray(sku) ? sku : [sku];

    const results = await db.sequelize.query(sql, {
      replacements,
      type: db.sequelize.QueryTypes.SELECT,
    });
    console.log(`Fetched ${results.length} records from cover days`);
    res.json({ success: true, count: results.length, data: results });
  } catch (error) {
    console.error("Error fetching cover days:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching data",
      error: error.message,
    });
  }
});


export default router;
