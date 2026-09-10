import express from 'express';
import salesSummary from './routes.sales.summary.js';
import coverDays from './routes.cover.days.js';
import coverDaysBenchmark from './routes.cover.days.benchmark.js';
import forcastAccuracyMonthly from './routes.forcast.accuracy.monthly.js';
import forcastAccuracyYearly from './routes.forcast.accuracy.yearly.js';
import inventoryDays from './routes.inventory.days.js';
import aboveBelowThreshold from './routes.above-below-threshold.js';
import forcastAccuracyCategoryMonthly from './routes.forcast.accuracy.category.monthly.js';
import forcastAccuracyCategoryYearly from './routes.forcast.accuracy.category.yearly.js';
import iblVsTscl from './routes.ibl.vs.tscl.js';
import wip from './routes.wip.js';
import rpm from './routes.rpm.js';
import serviceMeasure from './routes.service.measure.js';
import dispatchVsOrder from './routes.dispatch.vs.order.js';
import tgtVsActual from './routes.tgt.vs.actual.js';
import filters from './routes.filters.js';
import totalSku from './routes.total.sku.js';
import rdStatus from './routes.rd.status.js';

const router = express.Router();

// Single source of truth for the mounted API groups. Used both to mount the
// routers and to advertise every endpoint on the root route, so the two can
// never drift apart.
const routeGroups = [
  { path: '/sales-summary', router: salesSummary },
  { path: '/cover-days', router: coverDays },
  { path: '/cover-days-benchmark', router: coverDaysBenchmark },
  { path: '/forecast-accuracy-monthly', router: forcastAccuracyMonthly },
  { path: '/forecast-accuracy-yearly', router: forcastAccuracyYearly },
  { path: '/forecast-accuracy-category-monthly', router: forcastAccuracyCategoryMonthly },
  { path: '/forecast-accuracy-category-yearly', router: forcastAccuracyCategoryYearly },
  { path: '/inventory-days', router: inventoryDays },
  { path: '/above-below-threshold', router: aboveBelowThreshold },
  { path: '/ibl-vs-tscl', router: iblVsTscl },
  { path: '/service-measure', router: serviceMeasure },
  { path: '/tgt-vs-actual', router: tgtVsActual },
  { path: '/wip', router: wip },
  { path: '/rpm', router: rpm },
  { path: '/dispatch-vs-order', router: dispatchVsOrder },
  { path: '/filters', router: filters },
  { path: '/total-sku', router: totalSku },
  { path: '/rd-status', router: rdStatus },
];

// Mount routers
for (const { path, router: groupRouter } of routeGroups) {
  router.use(path, groupRouter);
}

export function listApiEndpoints(base = '/api') {
  const endpoints = {};
  for (const { path, router: groupRouter } of routeGroups) {
    const group = path.replace(/^\//, '');
    const items = [];
    for (const layer of groupRouter.stack) {
      if (!layer.route) continue;
      const sub = layer.route.path === '/' ? '' : layer.route.path;
      const methods = Object.keys(layer.route.methods)
        .filter((m) => layer.route.methods[m])
        .map((m) => m.toUpperCase());
      for (const method of methods) {
        items.push(`${method} ${base}${path}${sub}`);
      }
    }
    endpoints[group] = items;
  }
  return endpoints;
}

export default router;
