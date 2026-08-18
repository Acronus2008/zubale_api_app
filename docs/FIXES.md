# Fix Log

Each entry: the reported symptom it explains, the root cause found by
reading the code, the fix applied, why that fix (not a different one), and
how it's verified. Reviewed against a backend checklist (transaction
boundaries, error semantics, API-contract stability), a data-engineering
checklist (cache-key design, invalidation, atomicity of writes), and a QA
checklist (does the test capture symptom → repro → fix → verification).

---

## 1. Stock race condition + partial orders on failure

**Symptom:** "Data is sometimes inconsistent or missing", "intermittent errors occur in certain flows".

**File:** `src/orders/orders.service.ts`, `create()` (and `cancel()`).

**Root cause:**
```ts
// before
await this.orderItemsRepository.save(orderItem);
total += product.price * itemDto.quantity;
this.productsService.updateStock(product.id, product.stock - itemDto.quantity); // ← not awaited
```
Two separate bugs stacked on the same line:
1. `updateStock` was **never awaited** — the response could return before
   the stock write landed, and a failure inside it became an unhandled
   rejection.
2. `updateStock(id, quantity)` computed the new value from a `product`
   object read *before* the loop started (`product.stock - itemDto.quantity`)
   and wrote it as an **absolute** value. Two concurrent orders for the
   same product both read the same starting stock, both compute their own
   "final" value, and the second write clobbers the first — a classic
   lost-update race that can oversell stock.

On top of that, `create()` had no transaction: if item #2 in the loop
failed its stock check, item #1's `OrderItem` row and its stock decrement
were already committed, leaving a half-created order behind.

**Fix:**
- `ProductsService.updateStock(id, delta, manager?)` replaces `updateStock`.
  For a decrement it issues one conditional SQL statement —
  `UPDATE products SET stock = stock - :n WHERE id = :id AND stock >= :n`
  — via TypeORM's query builder. This is atomic at the database level: the
  row lock taken by the `UPDATE` serializes concurrent decrements on the
  same product, and the `WHERE stock >= :n` clause makes "not enough
  stock" a zero-affected-rows result instead of a race window. An optional
  `manager` parameter lets the caller run it inside an existing transaction.
- `OrdersService.create()` now opens a `QueryRunner` transaction: order
  creation, each `updateStock` call, and each `OrderItem` save all go
  through `queryRunner.manager`. Any failure triggers
  `rollbackTransaction()`, so a bad item can no longer leave a partial
  order or an already-applied stock decrement behind.
- `cancel()` mirrors this with a transaction and positive stock deltas.

**Why this approach and not, say, an optimistic-lock version column:**
the conditional `UPDATE` gives the same correctness guarantee with one
round trip and no schema change, which fits "fix the root cause, don't
redesign the system."

**Verified by:** `src/orders/orders.service.spec.ts` — *"rolls back the
whole order when a later item has insufficient stock"* and *"commits once,
and only once, when every item has enough stock"*; `src/products/products.service.spec.ts` —
*"decrements stock with a single conditional UPDATE..."* and *"throws
instead of allowing stock to go negative..."*.

---

## 2. Payment retry loop could hang for a very long time

**Symptom:** "Some requests are extremely slow or never complete."

**File:** `src/orders/orders.service.ts`, `processPayment()`.

**Root cause:** `private maxRetries = 1000;`, retrying every ~200ms
(100ms mock latency + 100ms backoff) against a mock that fails ~10% of the
time. Worst case is a request retrying for a very long time before
settling either way — and even the *expected* case (retrying until the
~90% success roll hits) adds unpredictable multi-second latency under bad
luck.

**Fix:** `maxRetries = 3`. Keeps the retry-with-backoff behavior described
in the README (`payment processing: simulated payment with retry logic`)
while bounding worst-case latency to ~3 round trips (~600ms) instead of up
to 1000.

**Why 3 and not, say, exponential backoff or a circuit breaker:** those
are legitimate production patterns but are new behavior, not a fix to the
reported symptom — the ask was "extremely slow or never complete," which a
small fixed retry budget directly resolves without adding machinery the
brief didn't call for.

**Verified by:** `orders.service.spec.ts` — *"configures a small retry
budget instead of the previous 1000"* (asserts the field directly) and
*"gives up and rejects soon after exhausting its retry budget, rather than
hanging"* (asserts wall-clock time stays under 5s with real timers, forcing
every attempt to fail via a `Math.random` spy).

---

## 3. Circular JSON in `getOrderWithFullDetails`

**Symptom:** "Some failures produce vague or misleading error messages."

**File:** `src/orders/orders.service.ts`, `getOrderWithFullDetails()`.

**Root cause:**
```ts
// before
const enriched: any = { ...order };
enriched.user = { ...order.user };
enriched.user.latestOrder = enriched; // enriched.user.latestOrder === enriched
return JSON.parse(JSON.stringify(enriched)); // throws
```
`enriched.user.latestOrder` is assigned `enriched` itself — a real
reference cycle (`enriched → user → latestOrder → enriched`).
`JSON.stringify` throws `TypeError: Converting circular structure to JSON`
on any object graph with a cycle, which NestJS surfaces to the client as
an opaque 500 with a stack trace instead of a domain error.

**Fix:** `enriched.user.latestOrder` is now a small, non-circular summary
(`{ id, status, total }`) instead of the whole object graph. The endpoint
still tells the caller "here's the user's latest order," just without
looping back on itself.

**Why not remove `latestOrder` entirely:** the field's intent (surface
the order's own identity/status/total on the nested `user`) is preserved;
only the part that caused the crash — pointing back at the container
object — is removed.

**Verified by:** `orders.service.spec.ts` — *"returns a JSON-safe payload
without throwing"*, which also asserts `user.latestOrder` matches the
expected `{id, status, total}` shape.

---

## 4. Product search cache ignored the query

**Symptom:** "Cache behavior does not match expectations."

**File:** `src/products/products.service.ts`, `searchProducts()`.

**Root cause:**
```ts
// before
const cacheKey = 'product-search'; // same key for every query string
```
Searching `"phone"` populates the cache under `product-search`. Searching
`"shoes"` 5 seconds later reads the **same** key and gets the phone
results back for up to 60 seconds — cache behavior that has nothing to do
with what was actually asked for. Writes (`create`, `remove`, stock
changes) never invalidated this key either, so even same-query results
could go stale after a catalog change.

**Fix:**
- Cache key is now `` `product-search:${query.trim().toLowerCase()}` `` —
  one entry per normalized query.
- `ProductsService` keeps an in-memory `Set<string>` of issued search
  cache keys and clears all of them (`cacheManager.del` for each,
  `Promise.all`'d) whenever a product is created, removed, or has its
  stock adjusted — so a catalog change can't be served stale search
  results for the remainder of the TTL.

**Why track keys instead of a single "products changed" flag:** cache-manager's
API (backed by `cache-manager-ioredis-yet`) doesn't expose key-pattern
deletion in a store-agnostic way; a small in-process registry is the
simplest correct fix for a single-instance deployment. Noted in
`ARCHITECTURE.md` §8 as a follow-up if the service is ever scaled
horizontally (a Redis-side registry or `SCAN`-based invalidation would be
needed then).

**Verified by:** `products.service.spec.ts` — *"uses a distinct cache
entry per query instead of one shared key"* and *"invalidates previously
cached searches when a product is created"*.

---

## 5. Category tree crashed or silently truncated beyond 1 level

**Symptom:** "Vague or misleading error messages" + "data sometimes
inconsistent or missing."

**File:** `src/products/products.service.ts`, `getCategoryTree()` /
`buildCategoryTree()`.

**Root cause:** `findCategory()` loads
`relations: ['parent', 'children', 'products']` — one level deep only.
`buildCategoryTree` recursed into `category.parent` and `category.children`
assuming those were populated at *every* depth:
- **Parent direction:** for a category two or more levels from the root,
  `category.parent` on the recursed-into object is `undefined` (TypeORM
  never loaded it), so `this.buildCategoryTree(category.parent)` immediately
  threw `TypeError: Cannot read properties of undefined` — a raw 500 with
  an unhelpful message.
- **Children direction:** the same missing-relation problem meant
  `category.children` on grandchildren was `undefined`, so the recursion
  just stopped there — the tree silently omitted anything past 2 levels
  instead of erroring, i.e. "missing data" with no indication anything
  was wrong.

**Fix:** `getCategoryTree()` now loads **all** categories with a single
`find()`, builds an `id → Category` map and a `parentId → children[]`
index in memory, and `buildCategoryTree` walks those maps instead of
relying on ORM-populated nested relations. Same output shape as before,
correct at any depth. A `visiting` set guards against unbounded recursion
if the data ever contains a parent/child cycle (defensive — ties back to
the "never complete" symptom class, since unbounded recursion on bad data
would otherwise hang/crash the request).

**Why load-everything-once instead of deeper `relations` strings:**
TypeORM's `relations` option can't express "however deep the tree
actually goes" — you'd have to guess a max depth (`'children.children.children'`, ...).
Loading the category table once (it's small, unbounded-depth trees are
rare) and building the tree in memory is both correct at any depth and a
single query instead of N recursive ones.

**Verified by:** `products.service.spec.ts` — *"builds a full parent chain
and children list at 3+ levels without throwing"* and *"does not recurse
infinitely if category data contains a cycle"*.

---

## 6. Batch processing swallowed the real error

**Symptom:** "Vague or misleading error messages" (in server logs, making
failed batch items unactionable).

**File:** `src/products/products.service.ts`, `processProductBatch()`.

**Root cause:**
```ts
} catch (error) {
  console.log('Error processing product'); // `error` never used
}
```

**Fix:** `console.error(\`Error processing product #${id}:\`, error);` —
logs which product failed and why. No behavior change (still a
best-effort batch that reports `processed` count), just makes failures
diagnosable instead of silent.

**Verified by:** code inspection; low-severity logging fix, not exercised
by a dedicated test.
