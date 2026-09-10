import express from "express";
import db from "../models/index.js";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const { classification, sku } = req.query;
    const sql = `
      select vic.classification, count(vic.mapping_code)::int as count
      from vw_items_class vic
      group by vic.classification
      order by vic.classification;
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
