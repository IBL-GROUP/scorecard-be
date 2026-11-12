// Small helpers shared by the v2 routes: query-string parsing and the response
// envelope. The envelope matches 1.0: { success, count, data } on success and
// { success: false, message, error } on failure.
import express from "express";
import { randomUUID } from "crypto";

/** Query value → list of non-empty strings (1.0 accepted one value or an array). */
export function list(v) {
  if (v === undefined || v === null || v === "") return [];
  return (Array.isArray(v) ? v : [v]).map((x) => String(x)).filter((x) => x !== "");
}

/** Query value → string or null (BigQuery parameters cannot be undefined). */
export const str = (v) => (v === undefined || v === null || v === "" ? null : String(Array.isArray(v) ? v[0] : v));

/**
 * The dashboard filters every 1.0 route read: classification, sku, branch.
 * Each is a list; an empty list means "not filtered".
 */
export function filters(q) {
  return { classification: list(q.classification), sku: list(q.sku), branch: list(q.branch) };
}

/** `AND <sqlExpr> IN UNNEST(@name)` when the list is non-empty, else "". */
export const inList = (values, sqlExpr, name) => (values.length ? `AND CAST(${sqlExpr} AS STRING) IN UNNEST(@${name})` : "");

/** Registers a GET handler that returns the 1.0 envelope. `fn(query)` returns rows or { data, ...extra }. */
export function get(router, path, label, fn) {
  router.get(path, async (req, res) => {
    try {
      const out = await fn(req.query, label);
      if (Array.isArray(out)) return res.json({ success: true, count: out.length, data: out });
      const { data, ...extra } = out;
      return res.json({ success: true, count: data.length, ...extra, data });
    } catch (e) {
      if (e.code === "SOURCE_PENDING") {
        return res.status(503).json({ success: false, code: e.code, message: e.message, pending: e.pending });
      }
      // Our own 4xx messages (e.g. an invalid date) are safe to show. Anything
      // else may carry BigQuery's text (column names, SQL positions), so the
      // browser gets a reference only and the detail stays in the server log
      // (story S5, AC-S5-8 "no SQL in error responses").
      if (e.status >= 400 && e.status < 500 && e.expose !== false) {
        return res.status(e.status).json({ success: false, message: "Error fetching data", error: e.message });
      }
      const ref = randomUUID().slice(0, 8);
      console.error(`[v2] ${label} failed (ref ${ref}):`, e.message);
      return res.status(500).json({ success: false, message: "Error fetching data", error: `Internal error (ref ${ref})` });
    }
  });
}

export const newRouter = () => express.Router();
