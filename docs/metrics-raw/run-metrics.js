// Shared metrics harness — run UNCHANGED against baseline and fixed instances.
// Usage: BASE_URL=http://localhost:3001 LABEL=baseline node run-metrics.js > baseline.json
'use strict';

const BASE = process.env.BASE_URL || 'http://localhost:3001';
const LABEL = process.env.LABEL || 'run';

async function jpost(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, body: json };
}

async function jget(path) {
  const res = await fetch(BASE + path);
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, body: json };
}

function ok(status) {
  return status >= 200 && status < 300;
}

function collectIds(node, seen = new Set()) {
  if (!node || typeof node !== 'object') return seen;
  if (Object.prototype.hasOwnProperty.call(node, 'id')) seen.add(node.id);
  if (Array.isArray(node.children)) {
    for (const c of node.children) collectIds(c, seen);
  }
  if (node.parent) collectIds(node.parent, seen);
  return seen;
}

async function main() {
  const report = { label: LABEL, base: BASE, timestamp: new Date().toISOString() };

  // ---- seed ----
  const uniq = Date.now();
  const user = await jpost('/users', {
    email: `metrics_${uniq}@test.com`,
    name: 'Metrics Tester',
  });
  const userId = user.body && user.body.id;
  if (!userId) {
    report.fatal = `could not create seed user: ${JSON.stringify(user)}`;
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  // =========================================================
  // Bug #1 — stock race condition / oversell
  // =========================================================
  {
    const initialStock = 10;
    const concurrency = 20;
    const p = await jpost('/products', {
      name: 'Oversell Test Widget',
      price: 10,
      stock: initialStock,
    });
    const productId = p.body.id;

    const results = await Promise.all(
      Array.from({ length: concurrency }, () =>
        jpost('/orders', { userId, items: [{ productId, quantity: 1 }] }),
      ),
    );
    const succeeded = results.filter((r) => ok(r.status));
    const failed = results.filter((r) => !ok(r.status));

    const finalProduct = await jget(`/products/${productId}`);
    const finalStock = finalProduct.body.stock;
    const stockConsumed = initialStock - finalStock;
    const phantomUnits = succeeded.length - stockConsumed;

    report.bug1_oversell = {
      description:
        'Fire N concurrent orders (qty 1 each) against a product with fixed initial stock.',
      initialStock,
      concurrentRequests: concurrency,
      succeededOrders: succeeded.length,
      rejectedOrders: failed.length,
      finalStock,
      stockActuallyConsumed: stockConsumed,
      phantomSoldUnits: phantomUnits,
      correct: succeeded.length === initialStock && finalStock === 0 && phantomUnits === 0,
    };
  }

  // =========================================================
  // Bug #3 — circular JSON in getOrderWithFullDetails
  // =========================================================
  {
    const p = await jpost('/products', {
      name: 'FullDetails Test Item',
      price: 5,
      stock: 100,
    });
    const productId = p.body.id;
    const order = await jpost('/orders', {
      userId,
      items: [{ productId, quantity: 1 }],
    });
    const orderId = order.body && order.body.id;

    const attempts = 5;
    const calls = [];
    for (let i = 0; i < attempts; i++) {
      calls.push(await jget(`/orders/${orderId}/full`));
    }
    const errors = calls.filter((c) => !ok(c.status));
    const successes = calls.filter((c) => ok(c.status));
    const sample = successes[0] || errors[0];

    report.bug3_circular_json = {
      description: `GET /orders/:id/full called ${attempts} times on a normal order.`,
      orderId,
      attempts,
      errorCount: errors.length,
      errorRate: errors.length / attempts,
      sampleStatus: sample && sample.status,
      sampleBody: sample && sample.body,
      correct: errors.length === 0,
    };
  }

  // =========================================================
  // Bug #4 — product search cache key collision + no invalidation
  // =========================================================
  {
    // 4a: cross-query contamination via a single shared cache key
    const alphaName = `MetricAlpha-${uniq}`;
    const betaName = `MetricBeta-${uniq}`;
    await jpost('/products', { name: alphaName, price: 1, stock: 1 });
    await jpost('/products', { name: betaName, price: 1, stock: 1 });

    const searchAlpha = await jget(`/products/search?q=${encodeURIComponent('metricalpha-' + uniq)}`);
    const searchBeta = await jget(`/products/search?q=${encodeURIComponent('metricbeta-' + uniq)}`);

    const alphaNames = (searchAlpha.body || []).map((x) => x.name);
    const betaNames = (searchBeta.body || []).map((x) => x.name);
    const betaSearchReturnedAlpha = betaNames.some((n) => n.includes('MetricAlpha'));
    const betaSearchReturnedBeta = betaNames.some((n) => n.includes('MetricBeta'));

    // 4b: staleness after write (same query, before/after a new matching product is created)
    const gammaQuery = `metricgamma-${uniq}`;
    const gamma1 = `MetricGamma-${uniq}-One`;
    await jpost('/products', { name: gamma1, price: 1, stock: 1 });
    const searchGammaBefore = await jget(`/products/search?q=${encodeURIComponent(gammaQuery)}`);
    const countBefore = (searchGammaBefore.body || []).length;

    const gamma2 = `MetricGamma-${uniq}-Two`;
    await jpost('/products', { name: gamma2, price: 1, stock: 1 });
    const searchGammaAfter = await jget(`/products/search?q=${encodeURIComponent(gammaQuery)}`);
    const countAfter = (searchGammaAfter.body || []).length;

    report.bug4_cache = {
      crossQueryContamination: {
        description:
          'Search for "beta" right after searching "alpha" — do the beta results wrongly contain alpha data?',
        betaSearchReturnedAlphaData: betaSearchReturnedAlpha,
        betaSearchReturnedOwnData: betaSearchReturnedBeta,
        correct: !betaSearchReturnedAlpha && betaSearchReturnedBeta,
      },
      staleAfterWrite: {
        description:
          'Search the same query before/after creating a new product that matches it — does the second search see the new product?',
        resultCountBeforeNewProduct: countBefore,
        resultCountAfterNewProduct: countAfter,
        sawNewProduct: countAfter > countBefore,
        correct: countAfter === countBefore + 1,
      },
    };
  }

  // =========================================================
  // Bug #5 — category tree truncated/crashing beyond 1 level
  // =========================================================
  {
    const root = await jpost('/categories', { name: `Root-${uniq}` });
    const rootId = root.body.id;
    const mid = await jpost('/categories', { name: `Mid-${uniq}`, parentId: rootId });
    const midId = mid.body.id;
    const leaf = await jpost('/categories', { name: `Leaf-${uniq}`, parentId: midId });
    const leafId = leaf.body.id;

    const leafTree = await jget(`/categories/${leafId}/tree`);
    const parentChainOk =
      ok(leafTree.status) &&
      leafTree.body &&
      leafTree.body.parent &&
      leafTree.body.parent.parent &&
      leafTree.body.parent.parent.id === rootId;

    const rootTree = await jget(`/categories/${rootId}/tree`);
    const distinctIds = ok(rootTree.status) ? collectIds(rootTree.body) : new Set();

    report.bug5_category_tree = {
      description:
        '3-level hierarchy (Root -> Mid -> Leaf). Fetch tree from the leaf (parent direction) and from the root (children direction).',
      leafTreeStatus: leafTree.status,
      leafTreeParentChainCorrect: !!parentChainOk,
      rootTreeStatus: rootTree.status,
      rootTreeDistinctCategoriesReachable: distinctIds.size,
      expectedDistinctCategories: 3,
      correct: !!parentChainOk && distinctIds.size === 3,
    };
  }

  // =========================================================
  // Bug #6 — swallowed error in processProductBatch (log diagnosability)
  // =========================================================
  {
    const good = await jpost('/products', { name: 'Batch Good Item', price: 1, stock: 1 });
    const goodId = good.body.id;
    const badId = 999999999; // guaranteed nonexistent

    const before = Date.now();
    const batch = await jpost('/products/batch', { productIds: [goodId, badId] });

    report.bug6_batch_log = {
      description:
        `POST /products/batch with one valid id (${goodId}) and one nonexistent id (${badId}). ` +
        'Check the server log for a diagnosable line (see *_server.log, grepped separately).',
      requestTimestamp: before,
      responseStatus: batch.status,
      responseBody: batch.body,
      badProductId: badId,
    };
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
