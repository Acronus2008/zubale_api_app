# Before/After Metrics

Quantitative evidence that each of the 6 root causes in [`FIXES.md`](./FIXES.md)
existed and is resolved — same experiment, run unchanged against the
**pristine baseline** (`product-engineer-challenge.zip`, the exact code
from commit `1b6b7d7`) and the **fixed** code in this repo, back to back
against a freshly reset Postgres/Redis on `2026-08-17`.

This complements [`E2E_VERIFICATION.md`](./E2E_VERIFICATION.md) (which
demonstrates the fixed behavior with real requests) by also reproducing
the **broken** behavior on the original code, so the fix is proven by
contrast rather than by inspection alone.

## Methodology

- The baseline was run from `../product-engineer-challenge.zip` unzipped
  into a sibling directory, **not** from this repo — so none of this
  repo's uncommitted fixes were at risk of being touched.
- Both instances expose the identical REST API (only the two service
  files changed — verified with `diff -rq` before running anything), so
  one script (`run-metrics.js`) was run **unmodified** against both,
  changing only `BASE_URL`.
- Sequential runs, not concurrent: both apps default to the same ports
  (`3001` app / `5432` Postgres / `6379` Redis, `3000` was already taken
  by an unrelated local container), so Postgres/Redis were reset
  (`docker-compose down -v && up -d`) between the baseline and fixed run
  to guarantee a clean, comparable starting state (no leftover rows, no
  stale Redis keys).
- Raw output: `baseline-results.json` / `fixed-results.json` (HTTP-driven
  metrics), `baseline-retry-sim.json` / `fixed-retry-sim.json` (bug #2),
  `baseline-server.log` / `fixed-server.log` (bug #6 log evidence).

---

## #1 — Stock race condition / oversell

**Test:** seed a product with `stock: 10`, fire 20 concurrent
`POST /orders` for `quantity: 1` each, then read final stock.

| Metric | Baseline (broken) | Fixed | Expected |
|---|---|---|---|
| Concurrent requests | 20 | 20 | 20 |
| Orders that returned success | **20** | **10** | 10 |
| Orders correctly rejected (400) | 0 | 10 | 10 |
| Final stock in DB | **9** | **0** | 0 |
| Stock actually consumed | 1 | 10 | 10 |
| **Phantom sold units** (sold on paper, not reflected in stock) | **19** | **0** | 0 |

The baseline told 20 different callers "your order succeeded" while the
database only ever recorded a single unit of decrement — a lost-update
race compounded by the un-awaited, non-atomic stock write. The fixed
atomic conditional `UPDATE` inside a transaction caps successes exactly
at available stock, every time.

## #2 — Payment retry budget (worst-case latency bound)

**Test:** the exact retry-loop logic from `processPayment` /
`paymentService`, run standalone with `Math.random` forced to always fail
(payment "unavailable" every attempt), to measure the deterministic
**worst-case** bound. (Natural 10% failure practically never chains this
long — P(1000 consecutive failures) ≈ 1e-1000 — so this isolates the
bound the old code exposed callers to, rather than a typical-case number
that would look identical either way.)

| Metric | Baseline (`maxRetries=1000`) | Fixed (`maxRetries=3`) |
|---|---|---|
| Attempts before giving up | 1000 | 3 |
| Wall-clock time to give up | **203.2s** | **0.61s** |
| Worst-case latency reduction | — | **~333x** |

## #3 — Circular JSON in `getOrderWithFullDetails`

**Test:** `GET /orders/:id/full` called 5 times on a normal order.

| Metric | Baseline (broken) | Fixed |
|---|---|---|
| Requests | 5 | 5 |
| `500` errors | **5 / 5 (100%)** | **0 / 5 (0%)** |
| Response body | `{"statusCode":500,"message":"Internal server error"}` | full order incl. non-circular `user.latestOrder` summary |

Every single call crashed on the baseline (`enriched.user.latestOrder`
pointing back at `enriched` itself, `JSON.stringify` throwing on the
cycle) — an opaque 500 on a read-only, no-input-dependent endpoint. 100%
resolved after the fix.

## #4 — Product search cache key collision + no invalidation

**Test A — cross-query contamination:** create two products with
distinct names, search for the first term, then immediately search for
the second.

| Metric | Baseline (broken) | Fixed |
|---|---|---|
| Second search wrongly returned first search's data | **true** | false |
| Second search returned its own matching data | false | **true** |

**Test B — staleness after a write:** search a query (populates cache),
create a new product that matches the same query, repeat the search.

| Metric | Baseline (broken) | Fixed |
|---|---|---|
| Results before the new product | 1 | 1 |
| Results after the new product | **1 (stale)** | **2 (fresh)** |
| New product visible in the very next search | false | **true** |

Both stem from the same root cause: one hardcoded cache key
(`'product-search'`) shared by every query, never invalidated on writes.

## #5 — Category tree crashed / truncated beyond 1 level

**Test:** 3-level hierarchy `Root -> Mid -> Leaf`. Fetch the tree from
the leaf (exercises the parent direction) and from the root (exercises
the children direction).

| Metric | Baseline (broken) | Fixed |
|---|---|---|
| `GET /categories/:leafId/tree` status | **500** | **200** |
| Full parent chain reconstructed (Leaf → Mid → Root) | false | true |
| `GET /categories/:rootId/tree` status | **500** | **200** |
| Distinct categories reachable from the root tree | **0** | **3 / 3** |

The baseline crashed in *both* directions past the 1-level-deep relations
TypeORM populated (`Cannot read properties of undefined`), not just the
parent direction — since `buildCategoryTree` unconditionally tried to
recurse into `category.parent` for any node with a `parentId`, including
nodes reached via the children array that hadn't had their own relations
loaded.

## #6 — Batch processing swallowed the real error

**Test:** `POST /products/batch` with one valid product ID and one
nonexistent ID; grep the server log for the resulting line.

| Metric | Baseline (broken) | Fixed |
|---|---|---|
| Log line for the failed item | `Error processing product` | `Error processing product #999999999: NotFoundException: Product #999999999 not found` |
| Which product failed is diagnosable from the log | **no** | **yes** |
| Why it failed is diagnosable from the log | **no** | **yes** |

Behavior (`{"success":true,"processed":1}`) is identical in both — this
is purely an observability fix, but the log line is the difference
between "something silently failed" and "product 999999999 doesn't
exist" for whoever's on call.

---

## Reproducing this

```bash
# from a sibling directory containing product-engineer-challenge.zip
unzip product-engineer-challenge.zip -d product-engineer-challenge-baseline
cd product-engineer-challenge-baseline && pnpm install && pnpm run build

# run once against the baseline, once against this repo — same script both times
BASE_URL=http://localhost:3001 LABEL=baseline node run-metrics.js > baseline-results.json
BASE_URL=http://localhost:3001 LABEL=fixed    node run-metrics.js > fixed-results.json

node payment-retry-sim.js 1000   # baseline maxRetries
node payment-retry-sim.js 3      # fixed maxRetries
```

`run-metrics.js` and `payment-retry-sim.js`, plus the raw output referenced
throughout this doc (`*-results.json`, `*-retry-sim.json`, `*-server.log`),
live in [`docs/metrics-raw/`](./metrics-raw/) — harness scripts and
evidence, not part of the application (not added to `src/`).
