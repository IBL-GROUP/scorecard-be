// Supply Chain Pulse API: read-only, from BigQuery. `npm run dev` → http://localhost:3005/api (PORT).
//
// Every /api route needs the authenticator JWT (middleware/auth.js). /health and
// /api/health stay open for uptime checks.
import net from "node:net";
import express from "express";
import cors from "cors";
import { env, bqSettingsFile } from "./lib/env.js";
import { run, bqInfo, clearCache } from "./lib/bq.js";
import { T, notReady, dataset } from "./lib/sources.js";
import { authenticate } from "./middleware/auth.js";
import { salesSummary, faMonthly, faYearly, faCategoryMonthly, faCategoryYearly, iblVsTscl } from "./routes/sales.js";
import { coverDays, inventoryDays, aboveBelow, serviceMeasure, tgtVsActual } from "./routes/inventory.js";
import { wip, rpm, dispatchVsOrder, rdStatus } from "./routes/operations.js";
import { filterLists, totalSku } from "./routes/filters.js";

// Node tries each of a host's addresses (IPv6, then IPv4) for only 250 ms
// before moving on. Reaching Google from the office takes ~0.5 s, so every
// attempt was cut off and every BigQuery call failed ("request to
// https://bigquery.googleapis.com/... failed") while curl, which waits, got
// through. 2 s per attempt is ample and still fails fast when a host is really
// unreachable. Same fix as dsr-be.
net.setDefaultAutoSelectFamilyAttemptTimeout(2000);

const ROUTE_GROUPS = [
  ["/sales-summary", salesSummary],
  ["/cover-days", coverDays],
  ["/forecast-accuracy-monthly", faMonthly],
  ["/forecast-accuracy-yearly", faYearly],
  ["/forecast-accuracy-category-monthly", faCategoryMonthly],
  ["/forecast-accuracy-category-yearly", faCategoryYearly],
  ["/inventory-days", inventoryDays],
  ["/above-below-threshold", aboveBelow],
  ["/ibl-vs-tscl", iblVsTscl],
  ["/service-measure", serviceMeasure],
  ["/tgt-vs-actual", tgtVsActual],
  ["/wip", wip],
  ["/rpm", rpm],
  ["/dispatch-vs-order", dispatchVsOrder],
  ["/filters", filterLists],
  ["/total-sku", totalSku],
  ["/rd-status", rdStatus],
];

function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors({ origin: env.corsOrigins, methods: ["GET"], credentials: false }));

  app.use((req, _res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
  });

  // GET only (AC-S2-5). CORS preflight is answered above.
  app.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    res.set("Allow", "GET").status(405).json({ success: false, message: "Method not allowed" });
  });

  const health = async (_req, res) => {
    try {
      const [r] = await run(
        `SELECT CAST(MAX(billing_date) AS STRING) AS data_end FROM ${T("vw_mv_tscl_data_")}
         WHERE billing_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 10 DAY)`,
        {},
        "health",
      );
      const pending = notReady();
      res.json({ status: "OK", success: true, source: "bigquery", dataset, data_end: r?.data_end ?? null, pending_sources: pending });
    } catch (e) {
      res.status(500).json({ status: "ERROR", success: false, message: "BigQuery not reachable", error: e.message });
    }
  };
  app.get("/health", health);
  app.get("/api/health", health);

  app.use("/api", authenticate);
  // Local-only cache reset (after a data refresh). GET because the server is GET-only.
  app.get("/api/cache/clear", (req, res) => {
    const ip = req.socket.remoteAddress || "";
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip)) return res.status(403).json({ success: false });
    clearCache();
    res.json({ success: true });
  });
  for (const [path, router] of ROUTE_GROUPS) app.use(`/api${path}`, router);

  app.use((req, res) => res.status(404).json({ error: "Route not found", path: req.path }));
  return app;
}

createApp().listen(env.port, () => {
  console.log(`Supply Chain Pulse API (BigQuery, read-only) on http://localhost:${env.port}/api`);
  console.log(`  BigQuery: ${bqInfo.projectId} (${bqInfo.location}), dataset ${dataset}; settings from ${bqSettingsFile}`);
  console.log(`  CORS: ${env.corsOrigins.join(", ")} · cache ${env.cacheTtlSeconds}s · bytes cap ${env.maxBytesBilled}`);
});
