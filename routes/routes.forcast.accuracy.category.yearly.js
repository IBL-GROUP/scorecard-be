import express from "express";
import db from "../models/index.js";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const {
      endDate,
      classification,
      sku,
      branch,
    } = req.query;

    const sql = `
 WITH sale AS (
    SELECT
        a.classification,
        DATE_TRUNC('month', a.billing_date) AS month_date,
        TO_CHAR(DATE_TRUNC('month', a.billing_date), 'FMMonth YYYY') AS month,
        SUM(a.sold_qty * COALESCE(b."SALE E.F.P", 0)) AS amount,
        0           AS target_value
    FROM vw_mv_tscl_data_ a
    LEFT JOIN LATERAL (
        SELECT efp."SALE E.F.P"
        FROM tscl_efp efp
        WHERE efp.item_code = a.item_code
          AND DATE_TRUNC('month', efp.first_date::date) IN (
              DATE_TRUNC('month', a.billing_date),
              DATE_TRUNC('month', a.billing_date) - INTERVAL '1 month'
          )
        ORDER BY CASE
            WHEN DATE_TRUNC('month', efp.first_date::date) = DATE_TRUNC('month', a.billing_date)
                 AND COALESCE(efp."SALE E.F.P", 0) <> 0 THEN 0
            WHEN DATE_TRUNC('month', efp.first_date::date) = DATE_TRUNC('month', a.billing_date) - INTERVAL '1 month' THEN 1
            WHEN DATE_TRUNC('month', efp.first_date::date) = DATE_TRUNC('month', a.billing_date) THEN 2
            ELSE 3
        END,
        efp.first_date DESC
        LIMIT 1
    ) b ON TRUE
    WHERE a.billing_date >= DATE_TRUNC('month', :endDate::date) - INTERVAL '2 months'
      AND a.billing_date < DATE_TRUNC('month', :endDate::date) + INTERVAL '1 month'
      ${classification ? `AND a.classification::text IN (:classification)` : ""}
      ${sku ? `AND a.item_code::text IN (:sku)` : ""}
      ${branch ? `AND a.branch_id::text IN (:branch)` : ""}
    GROUP BY a.classification, DATE_TRUNC('month', a.billing_date)
    UNION ALL
    SELECT
        COALESCE(vic.classification, 'Others')      AS classification,
        DATE_TRUNC('month', b.target_date::date) AS month_date,
        TO_CHAR(DATE_TRUNC('month', b.target_date::date), 'FMMonth YYYY') AS month,
        0                   AS amount,
        SUM(value)   AS target_value
    FROM mv_tscl_budget b
    LEFT OUTER JOIN vw_items_class vic ON vic.mapping_code::text = b.item_code::text
    WHERE b.target_date::date >= DATE_TRUNC('month', :endDate::date) - INTERVAL '2 months'
      AND b.target_date::date < DATE_TRUNC('month', :endDate::date) + INTERVAL '1 month'
        ${classification ? `AND COALESCE(vic.classification, 'Others')::text IN (:classification)` : ""}
        ${sku ? `AND b.item_code::text IN (:sku)` : ""}
    --    AND b.item_code  = '1013000071'
    --    AND b.loc_code   = '8001'
    GROUP BY COALESCE(vic.classification, 'Others'), DATE_TRUNC('month', b.target_date::date)
)
SELECT
    COALESCE(a.classification, 'Others')        AS classification,
    a.month,
    SUM(amount)                                 AS amount,
    SUM(target_value)                           AS target_value,
    CASE
        WHEN SUM(amount)       <> 0
         AND SUM(target_value) <> 0
        THEN ROUND(
                (SUM(amount) / SUM(target_value) * 100)::numeric  -- âœ… cast to numeric
             , 2)
        ELSE 0
    END                                         AS pct
FROM sale a
GROUP BY COALESCE(a.classification, 'Others'), a.month_date, a.month
ORDER BY a.month_date DESC, COALESCE(a.classification, 'Others');
    `;

    const replacements = { endDate };
    if (classification) replacements.classification = Array.isArray(classification) ? classification : [classification];
    if (sku) replacements.sku = Array.isArray(sku) ? sku : [sku];
    if (branch) replacements.branch = Array.isArray(branch) ? branch : [branch];

    const results = await db.sequelize.query(sql, {
      replacements,
      type: db.sequelize.QueryTypes.SELECT,
    });
    console.log(`Fetched ${results.length} records from forecast accuracy category monthly`);
    res.json({ success: true, count: results.length, data: results });
  } catch (error) {
    console.error("Error fetching forecast accuracy category monthly:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching data",
      error: error.message,
    });
  }
});

export default router;

