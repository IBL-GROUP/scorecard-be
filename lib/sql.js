// SQL fragments the 1.0 routes repeat, written once in BigQuery syntax.
// Each is a straight translation of the PostgreSQL text it replaces.
import { T } from "./sources.js";

/**
 * 1.0's sales_inv_locations, read from EDW.hub_mapping (data team, Question 7),
 * with 1.0's column names: inv_sloc (storage location code, as text) and
 * inv_sloc_desc (location name). One row per storage location.
 */
export const SIL = () =>
  `(SELECT CAST(storage_location_code AS STRING) AS inv_sloc, location AS inv_sloc_desc FROM ${T("sales_inv_locations")})`;

/** The five business lines the stock queries keep. */
export const BUSLINES = "('P07','P08','P12','P01','P35')";

/** Storage locations the stock queries keep: 80xx plus 8206 and 8210. */
export const SLOC = "(dsmh.subinventory_code LIKE '80%' OR dsmh.subinventory_code = '8206' OR dsmh.subinventory_code = '8210')";

/**
 * 1.0: CASE WHEN item_code ~ '^[0-9]+$' THEN (item_code::bigint)::TEXT ELSE item_code END
 * Numeric codes lose their leading zeros; mapped SAP codes pass through.
 */
export const DSMH_CODE =
  "CASE WHEN REGEXP_CONTAINS(dsmh.item_code, r'^[0-9]+$') THEN CAST(CAST(dsmh.item_code AS INT64) AS STRING) ELSE dsmh.item_code END";

/** 1.0: CASE WHEN sid.mapping_code = '' OR sid.mapping_code IS NULL THEN sid.matnr ELSE sid.mapping_code END */
export const SID_CODE = "(CASE WHEN sid.mapping_code = '' OR sid.mapping_code IS NULL THEN sid.matnr ELSE sid.mapping_code END)";

/** vw_items_class.mapping_code is INT64 in BigQuery; 1.0 compared it as text. */
export const vic = (alias) => `CAST(${alias}.mapping_code AS STRING)`;

export const END = "CAST(@endDate AS DATE)";
export const START = "CAST(@startDate AS DATE)";
/** First day of endDate's month, and of the month after it. */
export const END_MONTH = `DATE_TRUNC(${END}, MONTH)`;
export const NEXT_MONTH = `DATE_ADD(DATE_TRUNC(${END}, MONTH), INTERVAL 1 MONTH)`;
/** 1.0: EXTRACT(DAY FROM DATE_TRUNC('month', endDate) + INTERVAL '1 month - 1 day') */
export const DAYS_IN_MONTH = `EXTRACT(DAY FROM LAST_DAY(${END}))`;

/** 1.0 `stock_<kind>_date = (SELECT MAX(...) ... BETWEEN start AND end AND busline IN (...))`. */
export const latestStockDate = (col, T, from = "TIMESTAMP(@startDate)", to = "TIMESTAMP(@endDate)") =>
  `dsmh.${col} = (
      SELECT MAX(d.${col}) FROM ${T} d
      WHERE d.${col} BETWEEN ${from} AND ${to}
        AND d.busline_code IN ${BUSLINES}
    )`;

/** 1.0 `SELECT DISTINCT ON (classification) … WHERE effective_date <= endDate ORDER BY classification, effective_date DESC`. */
export const thresholdsInForce = (T, cols, asOf = END) => `
    SELECT ${cols}
    FROM ${T} cd
    WHERE cd.effective_date <= ${asOf}
    QUALIFY ROW_NUMBER() OVER (PARTITION BY cd.classification ORDER BY cd.effective_date DESC) = 1`;

/** PostgreSQL TO_CHAR(d, 'Month YYYY'): the month name is blank-padded to 9 characters. */
export const pgMonthLabel = (d) => `CONCAT(RPAD(FORMAT_DATE('%B', ${d}), 9, ' '), ' ', FORMAT_DATE('%Y', ${d}))`;
/** PostgreSQL TO_CHAR(d, 'FMMonth YYYY'): no padding. */
export const pgFmMonthLabel = (d) => `FORMAT_DATE('%B %Y', ${d})`;
