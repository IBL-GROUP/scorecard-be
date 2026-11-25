// Where each 1.0 PostgreSQL source lives in BigQuery (story S2).
//
// One place for every table name, so a confirmation from the data team is a
// one-line change. A source is used only when its status is "confirmed" or
// "same-name" (same table name and every column 1.0 reads is present).
// "pending" sources make the endpoints that need them answer 503
// SOURCE_PENDING instead of guessing.
import { env } from "./env.js";
import { bqSettings } from "./env.js";

const DATASET = env.dataset || `${bqSettings.GCP_PROJECT_ID || "data-light-house-prod"}.EDW`;
if (!/^[\w-]+\.[\w-]+$/.test(DATASET)) throw new Error("BQ_DATASET must be project.dataset");

/** Searle's five business lines (P07 Bio Sciences, P08 Core, P12 Momentum, P01 IV Solution, P35 Nextar Pharma). */
export const BUSLINES = "('P07','P08','P12','P01','P35')";

/** 1.0 name → { table, status, note, where }. `where` keeps only the rows 1.0's view kept. */
export const SOURCES = {
  // 1.0's mv_tscl_spl_targets keeps the five business lines; EDW's view has that line
  // commented out, which added 60 other-line SKUs (672M in Nov 2026) to Others.
  mv_tscl_spl_targets: { table: "vw_tscl_spl_targets", status: "confirmed", where: `busline_id IN ${BUSLINES}` },
  vw_mv_tscl_data_: { table: "vw_mv_tsc_data", status: "confirmed" },
  mv_tscl_budget: { table: "vw_tscl_budget", status: "confirmed" },
  mv_scoreboard_hub_mapping: { table: "hub_mapping", status: "confirmed" },
  active_rds_list: { table: "active_rds", status: "confirmed" },
  vw_dispatch_vs_orders: { table: "vw_dispatch_vs_order", status: "confirmed" },
  sap_tpkg_traw_data: { table: "vw_sap_tpkg_traw_data", status: "confirmed" },
  cover_days: { table: "cover_days", status: "confirmed" },
  vw_daily_stock_movement_history: { table: "vw_daily_stock_movement_history", status: "confirmed" },
  vw_items_class: { table: "vw_items_class", status: "same-name" },
  sap_items_detail: { table: "sap_items_detail", status: "same-name" },
  // "SALE E.F.P" is read as sales_efp (data team, F4, 12 Nov 2026).
  tscl_efp: { table: "tscl_efp", status: "confirmed" },

  // Data team, Question 7 (12 Nov 2026): EDW.hub_mapping. Read only through
  // sql.js#SIL, which gives 1.0's column names: storage_location_code → inv_sloc,
  // location → inv_sloc_desc. storage_location_code is unique there (checked).
  sales_inv_locations: { table: "hub_mapping", status: "confirmed" },
  // F2 answered (user, 17 Nov 2026): the view is EDW.vw_sap_wip_data (not
  // vw_wip_sap_data as first announced). Every column 1.0 reads is present
  // (checked); plant, order_number (INT64) and storage_loc (FLOAT64) are cast
  // to text in routes/operations.js#wip, as the contract and 1.0 return them.
  sap_wip_data: { table: "vw_sap_wip_data", status: "confirmed" },
  // Data team, Question 10 / F3 (12 Nov 2026): EDW.vw_primaray_secondary_stock,
  // with the branch taken from EDW.hub_mapping through SUBINVENTORY_CODE
  // (hub branch, decided 12 Nov 2026). See routes/operations.js#rdStatus.
  primary_secondary_stock: { table: "vw_primaray_secondary_stock", status: "confirmed" },
  // New in 2.0 (user, 19 Nov 2026), as in Sales Pulse 2.0: zone and region per
  // branch, from cities mapped to branch codes. Read only through
  // routes/filters.js#branchGeo.
  zone_region: { table: "vw_zone_region_data", status: "confirmed" },
};

/** Sources not usable yet: "pending", plus "awaiting" tables that may not exist yet. */
export const notReady = () =>
  Object.entries(SOURCES)
    .filter(([, s]) => s.status === "pending" || s.status === "awaiting")
    .map(([n]) => n);

/** How long "table not created yet" is remembered before BigQuery is asked again. */
export const MISSING_RECHECK_MS = 5 * 60_000;
const missingSince = new Map(); // source name → time BigQuery last said "Not found"

/**
 * Runs `fn`. If BigQuery says the "awaiting" source's table does not exist,
 * answers 503 SOURCE_PENDING instead of 500, and keeps answering it for
 * MISSING_RECHECK_MS without starting another job (the S5 load test showed a
 * failed job per request otherwise). Once the table exists, `fn` runs as usual.
 */
export async function awaitTable(name, fn, now = Date.now) {
  const seen = missingSince.get(name);
  if (seen !== undefined && now() - seen < MISSING_RECHECK_MS) throw new SourcePendingError([name]);
  try {
    const out = await fn();
    missingSince.delete(name);
    return out;
  } catch (e) {
    const table = SOURCES[name]?.table;
    const msg = String(e?.message ?? "");
    if (table && /not found/i.test(msg) && msg.includes(table)) {
      missingSince.set(name, now());
      throw new SourcePendingError([name]);
    }
    throw e;
  }
}

export class SourcePendingError extends Error {
  constructor(names) {
    const notes = names.map((n) => SOURCES[n]?.note || n);
    super(`Data not available yet: ${notes.join("; ")}`);
    this.status = 503;
    this.code = "SOURCE_PENDING";
    this.pending = names;
  }
}

/** Throws SourcePendingError if any of the named sources is still pending. */
export function requireSources(...names) {
  const pending = names.filter((n) => SOURCES[n]?.status === "pending");
  if (pending.length) throw new SourcePendingError(pending);
}

/** Backtick-quoted, fully qualified BigQuery table for a 1.0 source name. */
export function T(name) {
  const s = SOURCES[name];
  if (!s) throw new Error(`Unknown source ${name}`);
  if (s.status === "pending") throw new SourcePendingError([name]);
  const table = `\`${DATASET}.${s.table}\``;
  return s.where ? `(SELECT * FROM ${table} WHERE ${s.where})` : table;
}

export const dataset = DATASET;
