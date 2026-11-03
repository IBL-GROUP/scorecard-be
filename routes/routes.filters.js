import express from "express";
import db from "../models/index.js";

const router = express.Router();

/**
 * The Others division, as the DSR dashboard has it: items whose SALES carry no
 * division. Shaped like vw_items_class rows so the Division filter can offer
 * Others and pick them by SKU, as it does for every other division.
 *
 * Twelve months back. The scan takes ~30s, so it runs once at startup and is
 * kept for 12 hours; a request during a refresh waits for that same run.
 */
const UNMAPPED_ITEMS_SQL = `
  SELECT TRIM(a.item_code::text)                                       AS mapping_code,
         TRIM(a.item_code::text)                                       AS item_code,
         COALESCE(NULLIF(TRIM(MAX(a.item_description::text)), ''),
                  TRIM(a.item_code::text))                             AS item_description,
         COALESCE(NULLIF(TRIM(MAX(a.item_description::text)), ''),
                  TRIM(a.item_code::text))                             AS "PRD",
         'Others'                                                      AS division,
         COALESCE(NULLIF(TRIM(MAX(a.classification::text)), ''), 'Others') AS classification
    FROM vw_mv_tscl_data_ a
   WHERE a.billing_date >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '12 months'
     AND NULLIF(TRIM(a.item_code::text), '') IS NOT NULL
     AND COALESCE(NULLIF(UPPER(TRIM(a.division::text)), 'OTHERS'), '') = ''
   GROUP BY TRIM(a.item_code::text)
   ORDER BY 3;
`;
const UNMAPPED_TTL_MS = 12 * 60 * 60 * 1000;
let unmapped = { rows: null, at: 0, pending: null };

function getUnmappedItems() {
  const fresh = unmapped.rows && Date.now() - unmapped.at < UNMAPPED_TTL_MS;
  if (fresh) return Promise.resolve(unmapped.rows);
  if (!unmapped.pending) {
    unmapped.pending = db.sequelize
      .query(UNMAPPED_ITEMS_SQL, { type: db.sequelize.QueryTypes.SELECT })
      .then((rows) => {
        unmapped = { rows, at: Date.now(), pending: null };
        console.log(`Cached ${rows.length} unmapped items for the Others division`);
        return rows;
      })
      .catch((error) => {
        unmapped.pending = null;
        console.error("Error fetching unmapped items:", error);
        // Keep serving the last list rather than dropping Others altogether.
        return unmapped.rows ?? [];
      });
  }
  return unmapped.pending;
}
void getUnmappedItems();

// A division that is blank, null or any spelling of "others" is Others.
const toDivision = (value) => {
  const text = String(value ?? "").trim();
  return !text || text.toUpperCase() === "OTHERS" ? "Others" : text;
};

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
    const [mapped, unmappedRows] = await Promise.all([
      db.sequelize.query(sql, {
        replacements,
        type: db.sequelize.QueryTypes.SELECT,
      }),
      getUnmappedItems(),
    ]);
    // An item sold with no division is Others even if vw_items_class names one,
    // so it sits under Others alone rather than under both.
    const othersCodes = new Set(unmappedRows.map((row) => row.item_code));
    const mappedCodes = new Set(mapped.map((row) => String(row.item_code)));
    const results = [
      ...mapped.map((row) => ({
        ...row,
        division: othersCodes.has(String(row.item_code))
          ? "Others"
          : toDivision(row.division),
      })),
      ...unmappedRows.filter((row) => !mappedCodes.has(row.item_code)),
    ];
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
