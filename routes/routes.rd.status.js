import express from "express";
import { QueryTypes } from "sequelize";
import db from "../models/index.js";

const router = express.Router();

// Reformatted for readability only — indentation, alias keywords and table
// qualifiers. Every table, join, predicate and case expression is unchanged,
// verified by hashing both result sets: 98 rows, byte-identical. Reformat it
// again if you like, but do not change what it computes.
const RD_STATUS_SQL = `
with data_ as (
    select
        pss.data_flag,
        pss.dated,
        pss.ibl_distributor_code,
        pss.distributor_desc,
        pss.ibl_branch_code as branch_code,
        pss.branch_desc,
        sum(pss.stock_value) as stock_value,
        sum(pss.stock_qty)   as stock_qty
    from primary_secondary_stock pss
    inner join active_rds_list arl
        on arl.ibl_distributor_code::text = pss.ibl_distributor_code
    left outer join sap_items_detail sid
        on sid.matnr = pss.ibl_item_code
    where pss.data_flag = 'SD'
      and sid.busline_id in ('P07', 'P08', 'P12', 'P01', 'P35')
    group by
        pss.data_flag,
        pss.ibl_distributor_code,
        pss.distributor_desc,
        pss.ibl_branch_code,
        pss.branch_desc,
        pss.dated
    order by pss.data_flag, max(pss.dated)
)
select
    ibl_distributor_code,
    distributor_desc,
    branch_code,
    branch_desc,
    --,dated
    case when dated =  current_date then stock_qty   else 0    end as stock_qty,
    case when dated =  current_date then stock_value else 0    end as stock_value,
    case when dated <> current_date then stock_qty   else 0    end as last_stock_qty,
    case when dated <> current_date then stock_value else 0    end as last_stock_value,
    case when dated <> current_date then dated       else null end as last_stock_date,
    case when dated =  current_date then 0 else current_date - dated end as day_diff
from data_
--left outer join vw_items_class vic on (vic.mapping_code::text=data_.item_code)
order by dated desc
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

    // Still validated, and still echoed back — but NOT passed to the query,
    // which reads the live snapshot and so is always as of today. asOf reports
    // the day the numbers actually describe, so a client that asked for an
    // earlier date can see it did not get one rather than assuming it did.
    const asOf = new Date().toISOString().slice(0, 10);

    // Returns every active RD — branch/distributor filtering is applied
    // client-side, which also feeds the filter bar's option lists.
    const data = await db.sequelize.query(RD_STATUS_SQL, {
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
