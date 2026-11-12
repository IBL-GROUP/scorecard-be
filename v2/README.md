# Supply Chain Pulse 2.0 API (BigQuery, read-only)

Branch `api-refresh-2.0` of scorecard-be: story S2 of Supply Chain Pulse 2.0.

Everything for 2.0 lives in this `v2/` folder. It serves the same endpoints,
with the same response shapes and the same SQL logic, as the 1.0 API. The
difference is that it reads from BigQuery (`data-light-house-prod.EDW`) instead
of PostgreSQL. The 1.0 server (`server.js`, `routes/`, `config/`) is unchanged
and still runs with `npm start`.

## Run

```bash
npm install
npm run start:v2      # http://localhost:3012/api · health at /api/health
npm run test:v2       # read-only guard, 401/405, CORS, no SQL in errors (no BigQuery calls)
npm run smoke:v2      # every endpoint on live BigQuery, checked against the contract
node v2/scripts/s2-report.mjs   # story S2 test report → v2/reports/S2-test-report-<date>.md
```

**Rollback:** 2.0 runs beside 1.0. To go back, point the frontend's
`VITE_API_BASE_URL` at the 1.0 server again and redeploy it. 2.0 never writes,
so there is no data to restore (`TECHNICAL_DOCUMENT.md` §13).

| Setting | Where it comes from |
|---|---|
| BigQuery project, location, service account | **Only** `GCP_PROJECT_ID`, `BIGQUERY_LOCATION`, `GCP_SERVICE_ACCOUNT_BASE64` / `GOOGLE_APPLICATION_CREDENTIALS`, read from `BQ_ENV_FILE` (default `../Version 2/DSR-test-be/.env`). Nothing else in that file is loaded. |
| `JWT_ACCESS_SECRET` | this repo's `.env`, same as 1.0 |
| `V2_PORT` (3012), `V2_CORS_ORIGINS` (falls back to `CORS_ORIGIN`), `V2_CACHE_TTL_SECONDS` (600), `BQ_MAX_BYTES_BILLED` (3 GB), `BQ_DATASET` (`<project>.EDW`), `V2_TIMEZONE` (UTC, used for "today") | this repo's `.env`, all optional |

| File | What it does |
|---|---|
| `v2/start.js`, `v2/server.js` | Express app: CORS, GET-only, JWT auth on `/api/*`, health, routes |
| `v2/routes/*.js` | The 22 endpoints and their SQL, grouped as sales, inventory, operations, filters |
| `v2/sources.js` | **The only place table names live.** 1.0 table → BigQuery table and its status |
| `v2/sql.js` | SQL fragments the 1.0 routes repeat (business lines, storage locations, code mapping…) |
| `v2/bq.js` | BigQuery client, read-only runner, bytes cap, cache, bytes-billed log |
| `v2/readonly.js` | The read-only guard |
| `v2/http.js` | Query parsing and the 1.0 response envelope |
| `v2/SOURCE_MAP.md` | Evidence for every table mapping |
| `v2/scripts/` | `smoke.mjs`, `s2-report.mjs`, `spotcheck.mjs` (KPIs straight from BigQuery for the 2.0 spot check), `branch-check.mjs` (endpoints with and without a `branch` filter), `loadtest.mjs` (story S5: N users for M minutes; errors, latency, BigQuery jobs and bytes), `job-audit.mjs` (story S5: every job SELECT-only; needs `bigquery.jobs.list`, so the cloud admin runs it), `dryrun.mjs`, `peek.mjs`, `columns.mjs`, `source-map.mjs`, `list-tables.mjs` (all read-only) |

## Endpoint status

| Endpoint | Status |
|---|---|
| `/sales-summary`, `/total-sku`, `/filters`, `/filters/branches` | Live |
| `/cover-days`, `/cover-days/total`, `/tgt-vs-actual` (with and without `branch`) | Live |
| `/cover-days/closing-inv`, `/cover-days/benchmarks`, `/above-below-threshold` | Live |
| `/inventory-days`, `/service-measure` | Live (`sales_inv_locations` = `EDW.hub_mapping`, 12 Nov 2026) |
| `/forecast-accuracy-monthly`, `/daysgone`, `/forecast-accuracy-yearly`, `/forecast-accuracy-category-monthly`, `/forecast-accuracy-category-yearly`, `/ibl-vs-tscl` | Live |
| `/dispatch-vs-order`, `/rpm` | Live. `/rpm` totals are wrong while `vw_sap_tpkg_traw_data` is still being loaded (question F6) |
| `/wip` | Ported. **503** until the data team creates `EDW.vw_wip_sap_data` (question F2); then it works with no change |
| `/rd-status` | **503** until branch code and name are added to `EDW.vw_primaray_secondary_stock` (question F3) |

A 503 looks like `{ success: false, code: "SOURCE_PENDING", message, pending: [...] }`.
`/api/health` lists the sources not ready yet (pending, or awaiting a table).
When the data team answers, change the line in `v2/sources.js` and fill in the
route marked with the question number.

## How the port stays faithful

- Each route is the 1.0 SQL rewritten in BigQuery syntax: same tables, joins,
  filters, groupings, rounding and column names.
- Known 1.0 gaps are **kept on purpose** (story S2 decision, 11 Nov 2026):
  GAP-001 (April 2026 hard-coded), GAP-004 (budget accuracy stops the day
  before endDate), GAP-005 (ignored filters), GAP-006 (`date` ignored),
  GAP-007 (no date validation; March 2026 default).
- PostgreSQL behaviour that BigQuery does differently is written out:
  - `x = x` predicates (which drop NULLs) → `x IS NOT NULL`;
  - `DISTINCT ON` → `QUALIFY ROW_NUMBER() … = 1`;
  - `LEFT JOIN LATERAL … LIMIT 1` → `ARRAY_AGG(… ORDER BY … LIMIT 1)`;
  - `TO_CHAR(d, 'Month YYYY')` keeps PostgreSQL's 9-character padding;
  - `ORDER BY … NULLS LAST` where PostgreSQL sorts NULLs last;
  - INT64 codes in BigQuery (`mapping_code`, `storage_location_code`, `plant`)
    are compared and returned as text, as 1.0 did.
- Column names BigQuery cannot use as aliases (`"No Of SKUs > Threshold"`) are
  renamed back in JavaScript.
- Three BigQuery tables refuse queries without a filter on their partition
  column. Where 1.0 had none, the filter added keeps every row:
  `(col IS NULL OR col >= '1900-01-01')` (`recorddate`, `order_date`). On
  `tscl_efp` the filter covers exactly the months the join can match.

### Points the parity run (TC-S2-03) must check

1. `sales_inv_locations` is read from `EDW.hub_mapping` (`storage_location_code`
   → `inv_sloc`, `location` → `inv_sloc_desc`). Check that `/service-measure`
   branch names match 1.0 (1.0 removed " SELL" from `inv_sloc_desc`; `location`
   has no suffix), and that 1.0's table had the same storage locations.
2. `/forecast-accuracy-yearly` with a `branch` filter reads `tscl_efp.branch_id`
   as 1.0 does. BigQuery's `tscl_efp` has no such column, so it answers 500.
   1.0 probably fails the same way; confirm.
3. "Today" (`/forecast-accuracy-yearly` target-to-date) uses `V2_TIMEZONE`
   (UTC). 1.0 used the PostgreSQL server's time zone.
4. `tscl_efp.sales_efp` is read as 1.0's `"SALE E.F.P"` (question F4).
5. In `vw_sap_tpkg_traw_data` one `executiondate` can have several
   `recorddate` loads (e.g. 29 Jun 2026 has 5). `/rpm` sums every row of the
   latest `executiondate`, as 1.0 does, so such a day counts each load (question F6).

## Data freshness seen on 11 Nov 2026

| Source | Latest date |
|---|---|
| Sales, stock, dispatch | 10 Nov 2026 |
| Targets | Nov 2026 |
| **Budget (`vw_tscl_budget`)** | **Jun 2026**: Budget Accuracy TSCL has no target after June (question F5) |
| **Raw & packing materials** | **30 Jun 2026**: `/rpm` is empty for later windows (question F6) |
| EFP prices | Sep 2026 |
| Cover-days benchmarks | first set 29 Jul 2026, latest 10 Sep 2026 |

## Safety

- The service account should hold only **BigQuery Data Viewer + Job User**,
  so BigQuery itself refuses writes (AC-S2-6). Check with the data team.
- `readonly.js` refuses anything but one SELECT/WITH statement before it
  reaches BigQuery (TC-S2-07, `npm run test:v2`).
- Only `createQueryJob` is used, never a load, copy, extract, insert or
  table-create API, and no destination table is set (AC-S2-7).
- Every job has `maximumBytesBilled` (3 GB). The largest endpoint at the MTD
  window bills about 0.5 GB (`/forecast-accuracy-category-monthly`). Bytes are
  logged per job.
- Browser values only travel as named query parameters, never in SQL text.
- Every `/api` route needs the authenticator JWT (`middleware/auth.js`, as in 1.0).
  Non-GET methods get 405.
- Unexpected errors answer `500` with `Internal error (ref xxxxxxxx)` only; the BigQuery
  message stays in the server log under that reference (S5, AC-S5-8).
- A table that is named but not created yet (`/wip`) is asked about at most
  every 5 minutes, not on every request (S5 load test).
- Secrets are never logged. The service-account key stays in DSR-test-be's
  `.env`, which is git-ignored.
