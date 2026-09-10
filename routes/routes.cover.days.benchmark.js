import express from "express";
import db from "../models/index.js";

const router = express.Router();

// Cover-days benchmark (`days`) and inventory-days threshold (`threshold`) per
// classification. cover_days is effective-dated, so each class takes its most
// recent row on or before endDate (today when omitted).
router.get("/", async (req, res) => {
  try {
    const { endDate } = req.query;

    const sql = `
      SELECT DISTINCT ON (classification)
          classification,
          days,
          threshold,
          effective_date
      FROM cover_days
      WHERE effective_date <= COALESCE(CAST(:endDate AS date), CURRENT_DATE)
      ORDER BY classification, effective_date DESC;
    `;

    const results = await db.sequelize.query(sql, {
      replacements: { endDate: endDate || null },
      type: db.sequelize.QueryTypes.SELECT,
    });
    console.log(`Fetched ${results.length} records from cover days benchmark`);
    res.json({ success: true, count: results.length, data: results });
  } catch (error) {
    console.error("Error fetching cover days benchmark:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching data",
      error: error.message,
    });
  }
});

export default router;
