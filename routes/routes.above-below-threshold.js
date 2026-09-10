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
        //   ${classification ? `AND classification::text IN (:classification)` : ""}

    const sql = `
      WITH sku_base AS (
          SELECT DISTINCT
              mapping_code,
              COALESCE(classification, 'Others') AS classification
          FROM vw_items_class
          where classification in ('A', 'B', 'C', 'N')
      ),
      inv_value AS (
          SELECT
              (CASE WHEN sid.mapping_code = '' OR sid.mapping_code IS NULL
                    THEN sid.matnr ELSE sid.mapping_code END) AS mapping_code,
              SUM(dsmh.qty * dsmh.trade_price) AS inv_val
          FROM daily_stock_movement_history dsmh
          LEFT OUTER JOIN sap_items_detail sid
              ON sid.matnr = dsmh.item_code
          LEFT OUTER JOIN vw_items_class dmpm
              ON dmpm.mapping_code::TEXT =
                (CASE WHEN sid.mapping_code = '' OR sid.mapping_code IS NULL
                      THEN sid.matnr ELSE sid.mapping_code END)::TEXT
          LEFT OUTER JOIN sales_inv_locations sil
              ON sil.inv_sloc::TEXT = dsmh.subinventory_code
          WHERE dsmh.stock_opening_date = (
              SELECT MAX(stock_opening_date)
              FROM daily_stock_movement_history d
              WHERE d.stock_opening_date BETWEEN :startDate AND :endDate
              AND d.busline_code IN ('P07','P08','P12','P01','P35')
          )
          AND dsmh.busline_code IN ('P07','P08','P12','P01','P35')
          AND (
              dsmh.subinventory_code LIKE '80%'
              OR dsmh.subinventory_code = '8206'
              OR dsmh.subinventory_code = '8210'
          )
          -- and sil.sale_loc = '8006'
          ${sku ? `AND dmpm.mapping_code::text IN (:sku)` : ""}
          ${branch ? `AND dsmh.subinventory_code::text IN (:branch)` : ""}
          GROUP BY
              (CASE WHEN sid.mapping_code = '' OR sid.mapping_code IS NULL
                    THEN sid.matnr ELSE sid.mapping_code END)
      ),
      filtered_targets AS (
          SELECT
              (CASE WHEN sid.mapping_code = '' OR sid.mapping_code IS NULL  -- ✅ removed loc_code & classification
                    THEN sid.matnr ELSE sid.mapping_code END) AS mapping_code,
              SUM(t01.target_value) AS trg_value                            -- ✅ SUM across ALL branches
          FROM mv_tscl_spl_targets t01
          LEFT OUTER JOIN sap_items_detail sid
              ON sid.matnr = t01.item_code
          LEFT OUTER JOIN vw_items_class t03
              ON t03.mapping_code::TEXT =
                (CASE WHEN sid.mapping_code = '' OR sid.mapping_code IS NULL
                      THEN sid.matnr ELSE sid.mapping_code END)::TEXT
          WHERE DATE_TRUNC('month', t01.target_date) = DATE_TRUNC('month', :endDate::date)
          ${sku ? `AND t03.mapping_code::text IN (:sku)` : ""}
          ${branch ? `AND t01.loc_code::text IN (:branch)` : ""}
          -- and  t01.loc_code = '8006'
          GROUP BY
              (CASE WHEN sid.mapping_code = '' OR sid.mapping_code IS NULL
                    THEN sid.matnr ELSE sid.mapping_code END)               -- ✅ group only by mapping_code
      ),
      days_calc AS (
          SELECT EXTRACT(DAY FROM (
              DATE_TRUNC('month', :endDate::date) + INTERVAL '1 month - 1 day'
          ))::int AS total_days
      ),
      -- The threshold in force at the end of the window, per class, from
      -- cover_days (versioned by effective_date) — the same figures the
      -- Inventory Days Threshold card shows. 0 means none is set.
      thresholds AS (
          SELECT DISTINCT ON (cd.classification)
                 cd.classification, NULLIF(cd.threshold, 0) AS threshold
          FROM cover_days cd
          WHERE cd.effective_date <= CAST(:endDate AS date)
          ORDER BY cd.classification, cd.effective_date DESC
      ),
      sku_summary AS (
          SELECT
              sb.mapping_code,
              sb.classification,
              COALESCE(iv.inv_val, 0)    AS total_inv,
              COALESCE(ft.trg_value, 0)  AS total_trg,
              ROUND(
                  COALESCE(iv.inv_val, 0)::numeric /
                  NULLIF(COALESCE(ft.trg_value, 0)::numeric / dc.total_days, 0)
              , 1) AS cover_days
          FROM sku_base sb
          LEFT JOIN inv_value iv        ON sb.mapping_code::TEXT = iv.mapping_code::TEXT
          LEFT JOIN filtered_targets ft ON sb.mapping_code::TEXT = ft.mapping_code::TEXT
          CROSS JOIN days_calc dc
      )
      SELECT
          ss.classification,
          COUNT(CASE WHEN ss.cover_days >  th.threshold THEN 1 END) AS "No Of SKUs > Threshold",
          COUNT(CASE WHEN ss.cover_days <= th.threshold THEN 1 END) AS "No Of SKUs < Threshold"
      FROM sku_summary ss
      LEFT JOIN thresholds th ON th.classification = ss.classification
      GROUP BY ss.classification
      ORDER BY ss.classification;
    `;

    const replacements = { startDate, endDate };
    if (classification) replacements.classification = Array.isArray(classification) ? classification : [classification];
    if (sku) replacements.sku = Array.isArray(sku) ? sku : [sku];
    if (branch) replacements.branch = Array.isArray(branch) ? branch : [branch];

    const results = await db.sequelize.query(sql, {
      replacements,
      type: db.sequelize.QueryTypes.SELECT,
    });
    console.log(`Fetched ${results.length} records from above below threshold`);
    res.json({ success: true, count: results.length, data: results });
  } catch (error) {
    console.error("Error fetching above below threshold:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching data",
      error: error.message,
    });
  }
});

export default router;
