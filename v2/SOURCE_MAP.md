# Supply Chain Pulse 2.0: PostgreSQL → BigQuery source map (story S2, step 1)

BigQuery project `data-light-house-prod`, location `europe-west6`, dataset `EDW`.
First checked on 11 November 2026 with read-only `INFORMATION_SCHEMA` queries
(`node v2/scripts/source-map.mjs`, `list-tables.mjs`, `columns.mjs`).
Updated on 11 November 2026 with the data team's answers. Each table they named
was re-checked with `node v2/scripts/columns.mjs <table…>`.

"Columns 1.0 uses" lists only the columns the 1.0 SQL in `routes/` reads.
Per story S2, no table is used until the data team has confirmed it.

## Summary

| Status | Count | Sources |
|---|---|---|
| **Confirmed by the data team**, columns present | 10 | `mv_tscl_spl_targets`, `vw_mv_tscl_data_`, `mv_tscl_budget`, `mv_scoreboard_hub_mapping`, `active_rds_list`, `vw_dispatch_vs_orders`, `sap_tpkg_traw_data`, `cover_days`, `vw_daily_stock_movement_history`, `sales_inv_locations` (→ `hub_mapping`, 12 Nov 2026) |
| Same name, columns present, not yet confirmed (low risk) | 3 | `vw_items_class`, `sap_items_detail`, `tscl_efp` (column renamed) |
| **Waiting for the data team** | 2 | `sap_wip_data` (`EDW.vw_wip_sap_data` will be created with the old columns; route ready), `primary_secondary_stock` (branch code and name will be added to `EDW.vw_primaray_secondary_stock`; column names not known yet) |
| Not a real dependency | 2 | `vw_invoice_productmap` (only in log text), `frg_dist_metric_prod_mapping` (only in commented-out code) |

`organization.*` (used only by `/me`) is out of scope: the frontend never calls
`/me`, and identity data stays with the authenticator.

Partition filters: `tscl_efp` (`first_date`), `vw_dispatch_vs_order`
(`order_date`) and `vw_sap_tpkg_traw_data` (`recorddate`) refuse queries
without a filter on that column. See README "How the port stays faithful".

Data freshness and new questions F5 (budget stops at June 2026) and F6
(materials stop at 30 June 2026; several loads per day): see README.

## Detail

| 1.0 source (PostgreSQL) | Columns 1.0 uses | BigQuery table | Status | Port notes | Used by endpoints |
|---|---|---|---|---|---|
| `mv_tscl_spl_targets` | item_code, loc_code, target_date, target_value | `EDW.vw_tscl_spl_targets` | **Confirmed** | `target_date` is TIMESTAMP | cover-days, above-below, service-measure, tgt-vs-actual, forecast-accuracy-monthly(+daysgone), category-monthly, ibl-vs-tscl |
| `vw_mv_tscl_data_` | billing_date, item_code, amount, sold_qty, classification, branch_id, … | `EDW.vw_mv_tsc_data` | **Confirmed** | `billing_date` is DATE | sales-summary, forecast-accuracy-monthly/yearly, category-monthly/yearly |
| `mv_tscl_budget` | item_code, target_date, value, classification | `EDW.vw_tscl_budget` | **Confirmed** | `target_date` is TIMESTAMP | forecast-accuracy-yearly, category-yearly, ibl-vs-tscl |
| `mv_scoreboard_hub_mapping` | `*` → hub_branch_code, hub_branch_desc, storage_location_code | `EDW.hub_mapping` | **Confirmed** | `storage_location_code` is INT64: cast before comparing with text codes | filters/branches; branch filter |
| `active_rds_list` | ibl_distributor_code | `EDW.active_rds` | **Confirmed** | `ibl_distributor_code` is INT64: cast before joining text codes | rd-status |
| `vw_dispatch_vs_orders` | material_no, material_name, so_quantity, deliverd_qty, actual_gm_date | `EDW.vw_dispatch_vs_order` | **Confirmed** | Same column names as the 1.0 view (incl. `deliverd_qty`), so it is the same view: no extra aggregation to copy. Dates are TIMESTAMP | dispatch-vs-order |
| `sap_tpkg_traw_data` | materialname, producttype, plant, plantname, storagelocation(name), executiondate, unrestricted…, value… | `EDW.vw_sap_tpkg_traw_data` | **Confirmed** (the view, not the table) | Columns identical to the table; `plant`, `product` are INT64 | rpm |
| `cover_days` | classification, days, threshold, effective_date | `EDW.cover_days` | **Confirmed** (first check missed it) | `effective_date` is DATE | cover-days/benchmarks, above-below, service-measure, tgt-vs-actual |
| `vw_daily_stock_movement_history` | item_code, subinventory_code, busline_code, qty, trade_price, item_cost, stock_closing_date, stock_opening_date | `EDW.vw_daily_stock_movement_history` | **Confirmed** | dates are TIMESTAMP | cover-days ×3, inventory-days, above-below, service-measure, tgt-vs-actual |
| `vw_items_class` | mapping_code, classification, division, … | `EDW.vw_items_class` | Same name | — | Almost all |
| `sap_items_detail` | matnr, mapping_code | `EDW.sap_items_detail` | Same name | — | stock and target joins, rd-status |
| `tscl_efp` | item_code, first_date, `"SALE E.F.P"` | `EDW.tscl_efp` | Same name; **column renamed** `"SALE E.F.P"` → `sales_efp` (not yet confirmed) | — | forecast-accuracy-yearly, category-yearly |
| `sales_inv_locations` | inv_sloc, inv_sloc_desc, sale_loc | `EDW.hub_mapping` | **Confirmed** 12 Nov 2026 (Question 7). Checked: `storage_location_code` is unique (108 rows), and all 13 storage locations in the stock data are in it | read through `sql.js#SIL`: `storage_location_code` (INT64, cast to text) → `inv_sloc`, `location` → `inv_sloc_desc`. `sale_loc` is not read by 1.0 | cover-days, cover-days/total, tgt-vs-actual (branch filter), inventory-days, service-measure |
| `sap_wip_data` | order_number, item_code, plant, plnt_desc, storage_loc(_desc), material_type_description, type_description, item_qty, good_received_qty, wip, wip_value, record_created_date | `EDW.vw_wip_sap_data` | **Waiting: not created yet.** Data team (F2, 12 Nov 2026): same name, same columns as the old table | Route written against the old column names (SQL checked on a stand-in); answers 503 while BigQuery says "Not found", then works without a change | wip (and the WIP part of working capital) |
| `primary_secondary_stock` (secondary DB) | ibl_distributor_code, distributor_desc, **ibl_branch_code, branch_desc**, ibl_item_code, stock_qty, stock_value, dated, data_flag | `EDW.vw_primaray_secondary_stock` | **Waiting.** Data team (Question 10, 12 Nov 2026): branch code and name will be added to this view. Column names and date not known | qty is `QTY`, item is `item_code` | rd-status (RD table, Branch filters) |
