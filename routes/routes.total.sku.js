import express from "express";
import db from "../models/index.js";

const router = express.Router();
// ${sku ? 'AND t01.sap_mapping_code::text IN (:sku)' : ''}
// ${classification ? 'AND t01.classification::text IN (:classification)' : ''}
router.get("/", async (req, res) => {
  try {
    const { classification, sku } = req.query;
    // The Benchmark's "No. of SKUs", counted from vw_items_class — the
    // classification every other card on the Summary page reads — so it
    // includes N and agrees with the rest of the page. dist_metric_prod_mapping,
    // used before, has no N and a different product list (A 13 / B 40 / C 175).
    const sql = `
      select vic.classification, count(vic.mapping_code) as count
      from vw_items_class vic
      group by vic.classification;
    `;
    const replacements = {};
    if (classification) replacements.classification = Array.isArray(classification) ? classification : [classification];
    if (sku) replacements.sku = Array.isArray(sku) ? sku : [sku];
    const results = await db.sequelize.query(sql, {
      replacements,
      type: db.sequelize.QueryTypes.SELECT,
    });
    console.log(`Fetched ${results.length} records from filters`);
    res.json({ success: true, count: results.length, data: results });
  } catch (error) {
    console.error("Error fetching filters:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching data",
      error: error.message,
    });
  }
});

export default router;
