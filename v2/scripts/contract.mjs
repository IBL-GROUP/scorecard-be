// The scorecard-be OpenAPI contract and a small validator, shared by smoke.mjs
// and s2-report.mjs. Contract: OPENAPI_FILE, or
// ../scorecard-fe/specs/api/scorecard-be.openapi.json.
import fs from "fs";
import path from "path";

export const specFile = path.resolve(process.env.OPENAPI_FILE || "../scorecard-fe/specs/api/scorecard-be.openapi.json");
export const spec = JSON.parse(fs.readFileSync(specFile, "utf8"));

const resolve = (s) => (s && s.$ref ? resolve(s.$ref.split("/").slice(1).reduce((o, k) => o[k], spec)) : s);
const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);

/** OpenAPI 3.0 subset: $ref, allOf, oneOf, anyOf, type, nullable, enum, required, properties, items. */
export function validate(schema, v, at, errs) {
  const s = resolve(schema);
  if (!s || Object.keys(s).length === 0) return;
  if (s.allOf) return s.allOf.forEach((x) => validate(x, v, at, errs));
  if (s.oneOf || s.anyOf) {
    if (v === null && s.nullable) return;
    const ok = (s.oneOf || s.anyOf).some((o) => {
      const e = [];
      validate(o, v, at, e);
      return e.length === 0;
    });
    if (!ok) errs.push(`${at}: ${JSON.stringify(v)?.slice(0, 40)} matches none of oneOf`);
    return;
  }
  if (v === null || v === undefined) {
    if (v === null && !s.nullable && s.type) errs.push(`${at}: null but not nullable`);
    return;
  }
  if (s.type) {
    const t = typeOf(v);
    if (!(s.type === t || (s.type === "number" && t === "integer"))) return errs.push(`${at}: expected ${s.type}, got ${t} (${JSON.stringify(v).slice(0, 30)})`);
  }
  if (s.enum && !s.enum.includes(v)) errs.push(`${at}: ${JSON.stringify(v)} not in enum`);
  if (s.required) for (const k of s.required) if (!(k in v)) errs.push(`${at}: missing ${k}`);
  if (s.properties && typeof v === "object") for (const [k, ps] of Object.entries(s.properties)) if (k in v) validate(ps, v[k], `${at}.${k}`, errs);
  if (s.items && Array.isArray(v)) v.forEach((x, i) => i < 400 && validate(s.items, x, `${at}[${i}]`, errs));
}

/** Contract errors for a 200 body of GET `p` (an empty list means it conforms). */
export function check(p, body) {
  const schema = spec.paths[p]?.get?.responses?.["200"]?.content?.["application/json"]?.schema;
  if (!schema) return ["no contract for this path"];
  const errs = [];
  validate(schema, body, "body", errs);
  return errs;
}

/** Every GET the 1.0 frontend calls, with the parameters it sends. */
export const CALLS = [
  ["/sales-summary", "range"],
  ["/total-sku", ""],
  ["/cover-days", "range"],
  ["/cover-days/total", "range"],
  ["/cover-days/closing-inv", ""],
  ["/cover-days/benchmarks", "end"],
  ["/forecast-accuracy-monthly", "range"],
  ["/forecast-accuracy-monthly/daysgone", "range"],
  ["/forecast-accuracy-yearly", "range"],
  ["/forecast-accuracy-category-monthly", "range"],
  ["/forecast-accuracy-category-yearly", "range"],
  ["/ibl-vs-tscl", "range"],
  ["/inventory-days", "range"],
  ["/above-below-threshold", "range"],
  ["/service-measure", "range"],
  ["/tgt-vs-actual", "range"],
  ["/dispatch-vs-order", "range"],
  ["/wip", "range"],
  ["/rpm", "range"],
  ["/rd-status", "date"],
  ["/filters", ""],
  ["/filters/branches", ""],
];

export const queryFor = (kind, startDate, endDate) =>
  kind === "range" ? `?startDate=${startDate}&endDate=${endDate}` : kind === "end" ? `?endDate=${endDate}` : kind === "date" ? `?date=${endDate}` : "";
