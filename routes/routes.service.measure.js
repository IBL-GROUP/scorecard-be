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
        WITH inv_value AS (
            SELECT
                COALESCE(dmpm.classification, 'Others') AS classification,
                MAX(sid.matnr_desc) AS "PRD",
                (CASE WHEN sid.mapping_code = '' OR sid.mapping_code IS NULL
                    THEN sid.matnr ELSE sid.mapping_code END) AS mapping_code,
                sil.inv_sloc                            AS branch_code,
                REPLACE(sil.inv_sloc_desc, ' SELL', '') AS branch_desc,
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
                WHERE d.stock_opening_date BETWEEN '2026-04-01' AND '2026-04-30'
                AND d.busline_code IN ('P07','P08','P12','P01','P35')
            )
            AND dsmh.busline_code IN ('P07','P08','P12','P01','P35')
            AND (dsmh.subinventory_code LIKE '80%' OR dsmh.subinventory_code = '8206' OR dsmh.subinventory_code = '8210')
            ${classification ? `AND dmpm.classification::text IN (:classification)` : ""}
            ${sku ? `AND dmpm.mapping_code::text IN (:sku)` : ""}
            ${branch ? `AND sil.inv_sloc::text IN (:branch)` : ""}
            GROUP BY
                sil.inv_sloc,
                dmpm.classification,
                sil.inv_sloc_desc,
                (CASE WHEN sid.mapping_code = '' OR sid.mapping_code IS NULL
                    THEN sid.matnr ELSE sid.mapping_code END)
        ),
        filtered_targets AS (
            SELECT
                t01.loc_code AS branch_code,
                COALESCE(t03.classification, 'Others') AS classification,
                (CASE WHEN sid.mapping_code = '' OR sid.mapping_code IS NULL
                    THEN sid.matnr ELSE sid.mapping_code END) AS mapping_code,
                MAX(sid.matnr_desc) AS "PRD",
                SUM(t01.target_value) AS trg_value
            FROM mv_tscl_spl_targets t01
            LEFT OUTER JOIN vw_items_class t03
                ON t03.mapping_code::TEXT = t01.item_code::TEXT
            LEFT OUTER JOIN sap_items_detail sid
                ON sid.matnr = t01.item_code
            WHERE DATE_TRUNC('month', t01.target_date) = DATE_TRUNC('month', :endDate::date)
            ${classification ? `AND t03.classification::text IN (:classification)` : ""}
            ${sku ? `AND t03.mapping_code::text IN (:sku)` : ""}
            ${branch ? `AND t01.loc_code::text IN (:branch)` : ""}
            GROUP BY
                t01.loc_code,
                t03.classification,
                (CASE WHEN sid.mapping_code = '' OR sid.mapping_code IS NULL
                    THEN sid.matnr ELSE sid.mapping_code END)
        ),
        days_calc AS (
            SELECT EXTRACT(DAY FROM (
                DATE_TRUNC('month', :endDate::date) + INTERVAL '1 month - 1 day'
            ))::int AS total_days_in_month
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
        aggregated AS (
            SELECT
                ft.mapping_code,
                ft.classification,
                ft."PRD",
                ft.branch_code,
                -- ✅ get branch_desc from sil since ft doesn't have it
                REPLACE(sil.inv_sloc_desc, ' SELL', '') AS branch_desc,
                iv.inv_val,
                ft.trg_value
            FROM filtered_targets ft
            -- ✅ flipped to LEFT JOIN from targets side so all target SKUs appear
            LEFT JOIN inv_value iv
                ON  iv.branch_code::TEXT  = ft.branch_code::TEXT
                AND iv.classification     = ft.classification
                AND iv.mapping_code::TEXT = ft.mapping_code::TEXT
            LEFT JOIN sales_inv_locations sil
                ON sil.inv_sloc::TEXT = ft.branch_code::TEXT
        ),
        cover_days_detail AS (
            SELECT
                a.mapping_code,
                a.classification,
                a."PRD",
                a.branch_code,
                a.branch_desc,
                a.inv_val,
                a.trg_value,
                ROUND(a.trg_value::numeric / NULLIF(dc.total_days_in_month, 0), 1) AS daily_target,
                ROUND(
                    CASE
                        WHEN ABS(COALESCE(a.inv_val, 0)) < 0.001 THEN 0
                        ELSE COALESCE(a.inv_val, 0)
                    END::numeric /
                    NULLIF(a.trg_value::numeric / NULLIF(dc.total_days_in_month, 0), 0)
                , 1) AS cover_days
            FROM aggregated a
            CROSS JOIN days_calc dc
        ),
        totals AS (
            SELECT
                cdd.branch_code,
                cdd.branch_desc,
                cdd.classification,
                COUNT(DISTINCT cdd.mapping_code) AS total_sku,
                -- Above the class's threshold from cover_days (A, B, C and N
                -- alike); a class with none set counts nothing above it.
                COUNT(DISTINCT CASE
                    WHEN COALESCE(cdd.cover_days, 0) > th.threshold
                     AND COALESCE(cdd.cover_days, 0) < 9999 THEN cdd.mapping_code
                END) AS sku_above_threshold
            FROM cover_days_detail cdd
            LEFT JOIN thresholds th ON th.classification = cdd.classification
            GROUP BY cdd.branch_code, cdd.branch_desc, cdd.classification
        )
        SELECT
            t.branch_desc                               AS branch,
            MAX(CASE WHEN classification = 'A' THEN
                ROUND(sku_above_threshold::numeric / NULLIF(total_sku::numeric, 0) * 100, 2)
            END)                                        AS "SKU-A%",
            MAX(CASE WHEN classification = 'B' THEN
                ROUND(sku_above_threshold::numeric / NULLIF(total_sku::numeric, 0) * 100, 2)
            END)                                        AS "SKU-B%",
            MAX(CASE WHEN classification = 'C' THEN
                ROUND(sku_above_threshold::numeric / NULLIF(total_sku::numeric, 0) * 100, 2)
            END)                                        AS "SKU-C%",
            MAX(CASE WHEN classification = 'N' THEN
                ROUND(sku_above_threshold::numeric / NULLIF(total_sku::numeric, 0) * 100, 2)
            END)                                        AS "SKU-N%"
        FROM totals t
        WHERE t.branch_code::TEXT IN ('8006','8018','8019','8023','8028','8029','8035','8044','8046','8056','8059','8070','8072','8085')
        GROUP BY t.branch_code, t.branch_desc
        ORDER BY t.branch_desc;
    `;

    const replacements = { startDate, endDate };
    if (branch) replacements.branch = Array.isArray(branch) ? branch : [branch];
    if (classification) replacements.classification = Array.isArray(classification) ? classification : [classification];
    if (sku) replacements.sku = Array.isArray(sku) ? sku : [sku];

    const results = await db.sequelize.query(sql, {
      replacements,
      type: db.sequelize.QueryTypes.SELECT,
    });
    console.log(`Fetched ${results.length} records from service measure`);
    res.json({ success: true, count: results.length, data: results });
  } catch (error) {
    console.error("Error fetching service measure:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching data",
      error: error.message,
    });
  }
});

export default router;
