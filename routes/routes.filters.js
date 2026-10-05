import express from "express";
import db from "../models/index.js";

const router = express.Router();
// ${sku ? 'AND t01.sap_mapping_code::text IN (:sku)' : ''}
// ${classification ? 'AND t01.classification::text IN (:classification)' : ''}
router.get("/", async (req, res) => {
  try {
    const { classification, sku } = req.query;
    // The SKU / Classification / Division filters, from vw_items_class. Every
    // column of the view is returned (division, team, brands, …), plus the three
    // names the filter bar has always read: item_code, item_description and
    // classification — so the response shape it depends on is unchanged.
    // Every row is returned, mapping_code 0 included.
    const sql = `
      select vic.*,
             vic.mapping_code::text                  as item_code,
             vic."PRD"                               as item_description,
             coalesce(vic.classification, 'Others') as classification
      from vw_items_class vic order by vic."PRD";
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

router.get("/branches", async (req, res) => {
  try {
    const { classification, sku } = req.query;
    // The Branches filter: hub branches from mv_scoreboard_hub_mapping, with
    // 8210 and 8206 left out for now. One row per storage location, so a hub
    // branch repeats — the filter bar dedupes by hub_branch_code.
    const sql = `
      select *
      from mv_scoreboard_hub_mapping mshm
      where mshm.hub_branch_code not in ('8210', '8206');
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
