// Where each 1.0 PostgreSQL source lives in BigQuery (story S2).
//
// One place for every table name, so a confirmation from the data team is a
// one-line change. A source is used only when its status is "confirmed" or
// "same-name" (same table name and every column 1.0 reads is present).
// "pending" sources make the endpoints that need them answer 503
// SOURCE_PENDING instead of guessing. See v2/SOURCE_MAP.md and the data-team
// questions (F1–F4) for the evidence behind each line.
import { env } from "./env.js";
import { bqSettings } from "./env.js";

const DATASET = env.dataset || `${bqSettings.GCP_PROJECT_ID || "data-light-house-prod"}.EDW`;
if (!/^[\w-]+\.[\w-]+$/.test(DATASET)) throw new Error("BQ_DATASET must be project.dataset");

/** 1.0 name → { table, status, note }. */
export const SOURCES = {
  mv_tscl_spl_targets: { table: "vw_tscl_spl_targets", status: "confirmed" },
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
  // "SALE E.F.P" is read as sales_efp (question F4, not yet confirmed).
  tscl_efp: { table: "tscl_efp", status: "same-name" },

  // Data team, Question 7 (12 Nov 2026): EDW.hub_mapping. Read only through
  // sql.js#SIL, which gives 1.0's column names: storage_location_code → inv_sloc,
  // location → inv_sloc_desc. storage_location_code is unique there (checked).
  sales_inv_locations: { table: "hub_mapping", status: "confirmed" },
  // Data team, F2 (12 Nov 2026): will be created under this name with the old
  // columns. Until it exists, BigQuery answers "Not found" and the route turns
  // that into 503 SOURCE_PENDING (awaitTable); once created, it is used as is.
  sap_wip_data: { table: "vw_wip_sap_data", status: "awaiting", note: "EDW.vw_wip_sap_data is not created yet (question F2)" },
  // Data team, Question 10 (12 Nov 2026): branch code and name will be added to
  // EDW.vw_primaray_secondary_stock. Column names not known yet (question F3).
  primary_secondary_stock: { table: "vw_primaray_secondary_stock", status: "pending", note: "branch code and name not yet added to EDW.vw_primaray_secondary_stock (question F3)" },
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
  return `\`${DATASET}.${s.table}\``;
}

export const dataset = DATASET;
