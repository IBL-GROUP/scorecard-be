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
WITH ibl_target AS (
    SELECT
        COALESCE(b.classification, 'Others') AS classification,
        SUM(target_value)              AS target_value
    FROM mv_tscl_spl_targets b
     WHERE DATE_TRUNC('month', b.target_date::date) = DATE_TRUNC('month', CAST(:endDate AS date))
    ${classification ? `AND COALESCE(b.classification, 'Others')::text IN (:classification)` : ""}
    ${sku ? `AND b.item_code::text IN (:sku)` : ""}
    ${branch ? `AND b.loc_code::text IN (:branch)` : ""}
    and COALESCE(b.classification, 'Others')  = COALESCE(b.classification, 'Others')  
	and b.loc_code  = b.loc_code and  b.item_code = b.item_code
    GROUP BY COALESCE(b.classification, 'Others')
),
tscl_target AS (
    SELECT
        COALESCE(vic.classification, 'Others') AS classification,
        SUM(value)                           AS target_value
    FROM mv_tscl_budget b
    LEFT OUTER JOIN vw_items_class vic ON vic.mapping_code::text = b.item_code::text
    WHERE DATE_TRUNC('month', b.target_date::date) = DATE_TRUNC('month', CAST(:endDate AS date))
       ${classification ? `AND COALESCE(vic.classification, 'Others')::text IN (:classification)` : ""}
       ${sku ? `AND b.item_code::text IN (:sku)` : ""}
	 and  b.item_code = b.item_code
    GROUP BY COALESCE(vic.classification, 'Others')
),
combined AS (
    SELECT
        COALESCE(i.classification, t.classification, 'Others') AS classification,
        COALESCE(i.target_value, 0)                            AS ibl_target,
        COALESCE(t.target_value, 0)                            AS tscl_target
    FROM ibl_target  i
    FULL OUTER JOIN tscl_target t
        ON i.classification = t.classification
)
SELECT
    classification,
    ibl_target,
    tscl_target,
    CASE
        WHEN tscl_target <> 0
        THEN ROUND((ibl_target / tscl_target * 100)::numeric, 2)
        ELSE 0
    END AS ibl_vs_tscl_pct
FROM combined
UNION ALL
SELECT
    'Total'                          AS classification,
    SUM(ibl_target)                  AS ibl_target,
    SUM(tscl_target)                 AS tscl_target,
    CASE
        WHEN SUM(tscl_target) <> 0
        THEN ROUND((SUM(ibl_target) / SUM(tscl_target) * 100)::numeric, 2)
        ELSE 0
    END                              AS ibl_vs_tscl_pct
FROM combined;
    `;

    const replacements = { startDate, endDate };
    if (branch) replacements.branch = Array.isArray(branch) ? branch : [branch];
    if (classification) replacements.classification = Array.isArray(classification) ? classification : [classification];
    if (sku) replacements.sku = Array.isArray(sku) ? sku : [sku];

    const results = await db.sequelize.query(sql, {
      replacements,
      type: db.sequelize.QueryTypes.SELECT,
    });
    console.log(`Fetched ${results.length} records from ibl vs tscl`);
    res.json({ success: true, count: results.length, data: results });
  } catch (error) {
    console.error("Error fetching ibl vs tscl:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching data",
      error: error.message,
    });
  }
});

export default router;

