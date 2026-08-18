# Submission Summary — Zubale Product Engineer Challenge

## What was asked

`INSTRUCTIONS.md`: find and fix the root causes behind five reported
symptoms in a deployed NestJS/Postgres/Redis e-commerce API — slow/hanging
requests, intermittent errors, inconsistent/missing data, cache behavior
that doesn't match expectations, and vague error messages — without adding
features or redesigning the system.

## Approach

Read every source file (`app.module.ts`, both services in full, all
entities, controllers, DTOs) end to end and matched each reported symptom
to a concrete, reproducible root cause in the code, rather than guessing
or applying speculative hardening. Six root causes were found across two
services; all six are fixed, tested, and documented. Full narrative in
[`FIXES.md`](./FIXES.md); system-level view (diagrams, request flows,
explicit scope boundaries) in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Symptom → root cause → fix

| Symptom | Root cause | Fix |
|---|---|---|
| Data inconsistent/missing; intermittent errors | Stock update not awaited, written as a stale absolute value, no transaction around order creation | Atomic conditional `UPDATE` for stock (`ProductsService.updateStock`) + `QueryRunner` transaction in `create()`/`cancel()` |
| Requests extremely slow / never complete | Payment retry loop: `maxRetries = 1000` | Bounded to `3` |
| Vague/misleading errors | `getOrderWithFullDetails` built a real circular reference before `JSON.stringify` | Non-circular `latestOrder` summary |
| Cache doesn't match expectations | Product search cache used one hardcoded key for every query, never invalidated | Query-scoped cache key + invalidation on product writes |
| Vague errors / missing data | `getCategoryTree` recursed into ORM relations only loaded 1 level deep | Tree built from an in-memory map of all categories |
| Vague errors (logs) | Batch processing swallowed the caught error | Logs the real error |

## Testing performed

- `pnpm run build` (`nest build`) — clean, no type errors.
- `pnpm test` — **13/13 passing**, including 2 pre-existing plus 11 new
  targeted specs added for this work:
  - `src/orders/orders.service.spec.ts` — transactional rollback on a
    failing item, single-commit on success, bounded payment retry budget
    (both a direct assertion on the config and a wall-clock-bounded
    rejection test), non-circular `getOrderWithFullDetails` output.
  - `src/products/products.service.spec.ts` — per-query search cache
    keys, cache invalidation on write, atomic stock decrement
    success/failure, 3-level category tree correctness, cycle safety.
- `pnpm run lint` — clean on every file touched by this work (both new
  spec files, `products.service.ts`, `orders.service.ts`). It still
  reports ~10 pre-existing `@typescript-eslint` errors in code paths this
  work didn't need to change (e.g. the unexported `paymentService` mock's
  unused params, `any`-typed returns on `getOrderWithFullDetails`/
  `buildCategoryTree` that predate this fix). Left alone deliberately —
  retyping those return values is a real cleanup but not a fix for any of
  the five reported symptoms, and doing it anyway would cut against "don't
  redesign the system."
- **Manual end-to-end verification against real Postgres + Redis**
  (`docker-compose up -d && pnpm run start:dev`): every fix was exercised
  with live HTTP calls, including firing 5 concurrent `POST /orders`
  requests at a low-stock product to confirm no oversell under real
  contention. Full commands, raw responses, and a per-bug results table
  are in [`E2E_VERIFICATION.md`](./E2E_VERIFICATION.md).
- **Not run:** `pnpm run test:e2e` (the repo's Jest e2e suite) — the manual
  verification above covered the same ground against the same real
  services.

## Explicitly out of scope

Per the brief's "do not add new features or redesign the system," several
things that would normally draw comment in a code review were **not**
touched — see `ARCHITECTURE.md` §8 for the full list and reasoning: the
eager-loading relation strategy, the lack of an auth layer,
`synchronize: true` instead of migrations, and the
`JSON.parse(JSON.stringify(...))` deep-clone pattern (kept; only the
circular input feeding it was fixed).

## Deliverables in this submission

- Code fixes: `src/products/products.service.ts`, `src/orders/orders.service.ts`
- Tests: `src/products/products.service.spec.ts`, `src/orders/orders.service.spec.ts`
- `docs/ARCHITECTURE.md` — low-level design + where-it-broke/what-changed map
- `docs/FIXES.md` — per-bug symptom → root cause → fix → why → verification
- `docs/E2E_VERIFICATION.md` — manual end-to-end verification against real Postgres/Redis: commands, raw results, summary table
- `docs/SUMMARY.md` — this document
