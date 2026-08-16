import express from "express";
import { QueryTypes } from "sequelize";
import { getSecondaryDb } from "../config/database.secondary.js";

const router = express.Router();

// RD stock position as of a given date, read from the second database
// (franchise schema). An RD that uploaded on :asOf reports under stock_qty;
// one that did not carries its last known figures under last_stock_* plus
// day_diff, the age of that upload.
// Kept verbatim as supplied — the only edit is the two hardcoded dates
// swapped for the :asOf bind param. Do not reformat or "improve" it.
const RD_STATUS_SQL = `
select
ibl_distributor_code,distributor_desc,branch_code,branch_desc
,stock_qty,stock_value,last_stock_qty,last_stock_value
,last_stock_date,day_diff
from(
with active_rd as (select ibl_distributor_code,ud.username distributor_desc,ud.branch_code ,ud.location_name branch_desc
from franchise.active_rds_list rl
left outer join  user_details ud on (ud.distributor_id=rl.ibl_distributor_code) )
,maxdat as (select t.ibl_distributor_code ,max(dated)dated
           from franchise.franchise_stock t
           inner join active_rd rd on (rd.ibl_distributor_code=t.ibl_distributor_code)
           where dated< :asOf
           group by  t.ibl_distributor_code
           )
,maxrd as (select ibl_distributor_code ,dated,sum(stock_qty )stock_qty,sum(stock_value)stock_value
from franchise.franchise_stock
where (ibl_distributor_code ,dated)in (select ibl_distributor_code ,dated from maxdat )
group by ibl_distributor_code ,dated
)
,crd as (
select fs.ibl_distributor_code ,dated,sum(stock_qty )stock_qty ,sum(stock_value)stock_value
from franchise.franchise_stock fs
inner join active_rd rd on (rd.ibl_distributor_code =fs.ibl_distributor_code)
where dated=:asOf
group by fs.ibl_distributor_code ,dated
)
select
rd.ibl_distributor_code,rd.distributor_desc,rd.branch_code,rd.branch_desc
,crd.dated curren_date,coalesce(crd.stock_qty,0)stock_qty,coalesce(crd.stock_value,0)stock_value
,case when crd.dated is null then maxrd.dated else null end  last_stock_date
,case when crd.dated is null then maxrd.stock_qty else 0 end  last_stock_qty
,case when crd.dated is null then maxrd.stock_value else 0 end  last_stock_value
,coalesce (current_date-case when crd.dated is null then maxrd.dated else null end,0) day_diff
from active_rd rd
left outer join crd on (crd.ibl_distributor_code =rd.ibl_distributor_code)
left outer join maxrd on (maxrd.ibl_distributor_code =rd.ibl_distributor_code)
)a
`;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

router.get("/", async (req, res) => {
  try {
    const { date } = req.query;

    if (date && !ISO_DATE.test(String(date))) {
      return res.status(400).json({
        success: false,
        message: "Invalid `date` — expected YYYY-MM-DD",
      });
    }

    const asOf = date ? String(date) : new Date().toISOString().slice(0, 10);
    const sequelize = getSecondaryDb();

    // Returns every active RD for the date — branch/distributor filtering is
    // applied client-side, which also feeds the filter bar's option lists.
    const data = await sequelize.query(RD_STATUS_SQL, {
      replacements: { asOf },
      type: QueryTypes.SELECT,
    });

    console.log(`Fetched ${data.length} RD status records (asOf=${asOf})`);
    res.json({ success: true, count: data.length, asOf, data });
  } catch (error) {
    console.error("Error fetching RD status:", error);
    res.status(error.status || 500).json({
      success: false,
      message: "Error fetching data",
      error: error.message,
    });
  }
});

export default router;
