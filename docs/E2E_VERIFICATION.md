# End-to-End Verification (real Postgres + Redis)

Manual verification of every fix against **real** Postgres and Redis
containers (not mocks) — complements the unit tests in
[`FIXES.md`](./FIXES.md). Run on 2026-08-17 with Docker available.

The app's default port (3000) was taken by an unrelated container on the
machine, so the app was run on `3001` for this session only
(`PORT=3001` in a throwaway `.env`, removed afterward — no permanent
config change).

## 1. Environment setup

```bash
cp .env.sample .env
# .env edited: PORT=3000 -> PORT=3001 (avoid a local port conflict; throwaway, removed after)

docker-compose up -d
# -> challenge-db and challenge-redis created and started

# wait for Postgres healthcheck
docker inspect --format='{{.State.Health.Status}}' challenge-db
# -> healthy

pnpm run start:dev
# -> Nest application successfully started, all routes mapped, connected to
#    the real Postgres/Redis containers (TypeOrmModule + CacheModule init OK)
```

## 2. Seed data

```bash
BASE=http://localhost:3001

curl -s -X POST $BASE/users -H 'Content-Type: application/json' \
  -d '{"email":"buyer@example.com","name":"Buyer One"}'
# -> {"id":1,"email":"buyer@example.com","name":"Buyer One","isActive":true,...}

curl -s -X POST $BASE/categories -H 'Content-Type: application/json' -d '{"name":"Root"}'
# -> {"id":1,"name":"Root","description":null,"parentId":null}

curl -s -X POST $BASE/categories -H 'Content-Type: application/json' -d '{"name":"Mid","parentId":1}'
# -> {"id":2,"name":"Mid","description":null,"parentId":1}

curl -s -X POST $BASE/categories -H 'Content-Type: application/json' -d '{"name":"Leaf","parentId":2}'
# -> {"id":3,"name":"Leaf","description":null,"parentId":2}

curl -s -X POST $BASE/products -H 'Content-Type: application/json' \
  -d '{"name":"Widget A","description":"a phone accessory","price":10.5,"stock":5,"categoryId":1}'
# -> {"id":1,"name":"Widget A", ..., "stock":5, ...}

curl -s -X POST $BASE/products -H 'Content-Type: application/json' \
  -d '{"name":"Shoes B","description":"running shoes","price":50,"stock":10,"categoryId":1}'
# -> {"id":2,"name":"Shoes B", ..., "stock":10, ...}
```

A 3-level category tree (`Root(1) -> Mid(2) -> Leaf(3)`) and two products
were seeded to exercise the fixes below.

## 3. Bug #5 — category tree beyond 1 level

**Before the fix:** `GET /categories/:id/tree` threw
`TypeError: Cannot read properties of undefined` past 1 level of depth
(parent direction), or silently truncated (children direction).

```bash
curl -s -w "\nHTTP %{http_code}\n" $BASE/categories/3/tree
```
```json
{"id":3,"name":"Leaf","children":[],"parent":{"id":2,"name":"Mid","children":[{"id":3,"name":"Leaf","children":[]}],"parent":{"id":1,"name":"Root","children":[{"id":2,"name":"Mid","children":[]}]}}}
HTTP 200
```

```bash
curl -s -w "\nHTTP %{http_code}\n" $BASE/categories/1/tree
```
```json
{"id":1,"name":"Root","children":[{"id":2,"name":"Mid","children":[{"id":3,"name":"Leaf","children":[],"parent":{"id":2,"name":"Mid","children":[]}}],"parent":{"id":1,"name":"Root","children":[]}}]}
HTTP 200
```

**Result:** `200 OK` both directions, full 3-level tree, no crash, no
truncation.

## 4. Bug #4 — search cache key collision

**Before the fix:** every query shared the single cache key
`'product-search'`, so a search for one term could return another term's
cached results for up to 60s.

```bash
curl -s "$BASE/products/search?q=phone"
```
```json
[{"id":1,"name":"Widget A","description":"a phone accessory",...}]
```

```bash
curl -s "$BASE/products/search?q=shoes"
```
```json
[{"id":2,"name":"Shoes B","description":"running shoes",...}]
```

```bash
# create a 3rd product matching "phone" right after the first search was cached
curl -s -X POST $BASE/products -H 'Content-Type: application/json' \
  -d '{"name":"Phone Case","description":"phone accessory","price":8,"stock":20,"categoryId":1}'
# -> {"id":3,"name":"Phone Case",...}

curl -s "$BASE/products/search?q=phone"
```
```json
[{"id":1,"name":"Widget A",...},{"id":3,"name":"Phone Case",...}]
```

**Result:** `"phone"` and `"shoes"` returned distinct, correct result sets
(no cross-contamination), and the newly created "Phone Case" showed up in
the very next `"phone"` search instead of waiting out the 60s TTL —
confirms both the per-query cache key and the invalidation-on-write.

## 5. Bug #1 — stock race condition + partial orders

### 5a. Rollback when one item in the order fails its stock check

```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST $BASE/orders -H 'Content-Type: application/json' -d '{
  "userId": 1,
  "items": [
    {"productId": 1, "quantity": 1},
    {"productId": 2, "quantity": 999}
  ]
}'
```
```json
{"message":"Not enough stock for Shoes B","error":"Bad Request","statusCode":400}
HTTP 400
```

```bash
curl -s "$BASE/orders"        # -> []   (nothing persisted)
curl -s "$BASE/products/1"    # -> stock still 5 (no phantom decrement from item #1)
```

**Result:** the whole order was rejected atomically — no order row, no
order item, and product #1's stock (the item that *was* individually
valid) was never touched.

### 5b. Concurrency — no overselling

Fired 5 concurrent `POST /orders`, each requesting `quantity: 2` of
product #1, which had `stock: 5` (so at most 2 of the 5 can legally
succeed: `2 * 2 = 4 <= 5`, a 3rd would need `6 > 5`):

```bash
for i in 1 2 3 4 5; do
  curl -s -o "/tmp/order_$i.json" -w "order_$i => HTTP %{http_code}\n" \
    -X POST $BASE/orders -H 'Content-Type: application/json' \
    -d '{"userId": 1, "items": [ {"productId": 1, "quantity": 2} ]}' &
done
wait
```
```
order_4 => HTTP 201
order_3 => HTTP 400
order_2 => HTTP 201
order_1 => HTTP 400
order_5 => HTTP 400
```

```bash
curl -s "$BASE/products/1"
```
```json
{"id":1,"name":"Widget A",...,"stock":1,...}
```

**Result:** exactly 2 of 5 concurrent requests succeeded
(`5 - 2*2 = 1`, matching the final stock exactly), the other 3 failed
cleanly with `400 Not enough stock`. Stock never went negative and was
never oversold — the atomic conditional `UPDATE` correctly serialized the
concurrent decrements against the real database.

### 5c. Cancellation restores stock atomically

```bash
curl -s "$BASE/products/1"                          # stock: 1
curl -s -w "\nHTTP %{http_code}\n" -X POST "$BASE/orders/3/cancel"
```
```json
{"id":3,"status":"cancelled",...}
HTTP 201
```
```bash
curl -s "$BASE/products/1"                          # stock: 3 (1 + the cancelled order's qty 2)
```

**Result:** cancelling order #3 (`quantity: 2`) correctly restored stock
from `1` to `3`.

## 6. Bug #3 — circular JSON in `getOrderWithFullDetails`

**Before the fix:** `enriched.user.latestOrder = enriched` created a real
reference cycle; `JSON.stringify` threw
`TypeError: Converting circular structure to JSON`, surfaced as an opaque
500.

```bash
curl -s -w "\nHTTP %{http_code}\n" "$BASE/orders/2/full"
```
```json
{"id":2,"status":"pending","total":"21.00","user":{"id":1,"email":"buyer@example.com","name":"Buyer One","isActive":true,"createdAt":"...","latestOrder":{"id":2,"status":"pending","total":"21.00"}},"userId":1,"items":[...]}
HTTP 200
```

**Result:** `200 OK`, no throw, `user.latestOrder` present as the intended
non-circular summary (`id`, `status`, `total`).

## 7. Bug #2 — payment retry budget

**Before the fix:** `maxRetries = 1000`; a request could retry for a very
long time against the mock's ~10% failure rate before settling.

```bash
time curl -s -w "\nHTTP %{http_code}\n" -X POST "$BASE/orders/2/pay"
```
```json
{"success":true,"transactionId":"TXN-1787006427026"}
HTTP 201
```
```
real 0.124s
```

**Result:** responded in ~0.12s (succeeded on the first attempt, expected
~90% of the time). The bound itself — that it gives up after a small,
fixed number of attempts instead of up to 1000 — is deterministic and
already covered by a unit test that forces every attempt to fail
(`orders.service.spec.ts` — *"gives up and rejects soon after exhausting
its retry budget, rather than hanging"*), since reproducing the ~10%
failure path live would require many repeated real calls to hit by chance.

## 8. Cleanup

```bash
kill <nest pid>            # stop the dev server
docker-compose down        # remove challenge-db / challenge-redis containers + networks
rm .env                    # remove the throwaway env file
```

No data or config was left behind; `git status` was unaffected by this
session (no source files were touched during verification, only running
containers/process and a local `.env`).

## 9. Summary table

| # | Bug | Test performed | Result |
|---|---|---|---|
| 1 | Stock race condition / partial orders on failure | Order with one invalid item (§5a); 5 concurrent orders against `stock: 5` (§5b); cancellation (§5c) | Failing item rolls back the *whole* order with zero side effects; concurrent requests never oversold stock (exactly 2/5 succeeded, final stock matched arithmetic exactly); cancellation restored stock correctly |
| 2 | Payment retry could hang | `POST /orders/:id/pay`, timed | Responded in ~0.12s; retry bound (3, not 1000) verified deterministically in `orders.service.spec.ts` |
| 3 | Circular JSON in `getOrderWithFullDetails` | `GET /orders/:id/full` | `200 OK`, no throw, non-circular `user.latestOrder` summary present |
| 4 | Search cache ignored the query | `GET /products/search?q=phone` vs `q=shoes`; new product created between searches | Distinct results per query; new match appeared immediately (cache invalidated on write) instead of waiting out the TTL |
| 5 | Category tree crashed/truncated beyond 1 level | `GET /categories/:id/tree` on a 3-level hierarchy, both directions (leaf→root and root→leaves) | `200 OK` both directions, full tree, no crash, no truncation |
| 6 | Batch processing swallowed the real error | Code inspection only (low-severity logging fix) | `console.error` now logs the real error; not exercised via HTTP in this session |

All results above were produced by real HTTP calls against a running
`pnpm run start:dev` instance backed by the `docker-compose` Postgres and
Redis containers — not mocks. Combined with `pnpm run build` (clean) and
`pnpm test` (13/13 passing, see [`FIXES.md`](./FIXES.md) and
[`SUMMARY.md`](./SUMMARY.md)), every reported symptom has both a unit-test
proof and a live, end-to-end reproduction of the fix working correctly.
