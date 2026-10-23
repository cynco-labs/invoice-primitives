# invoice-primitives

Invoicing primitives for TypeScript: exact money, tax that rounds the way tax authorities expect, documents that cannot change after they are issued, gapless numbering, payments, credit notes and an event log. It runs on Convex, Cloudflare Durable Objects, Node, Bun, Deno and in the browser.

Working name. Not published yet.

## Why

Every product that bills someone rebuilds the same few hard things, and most get at least one of them wrong:

- **Money drifts.** `0.1 + 0.2`, rounding each line instead of each tax category, and a cent lost when a discount is split across lines.
- **Issued invoices change.** An edit after issue rewrites a legal document.
- **Numbers have gaps or repeats.** Two requests issue at once, or a failed issue burns a number.
- **Status lies.** A stored "paid" or "overdue" flag drifts from the payments behind it.

This library makes each of those impossible by construction, and proves it with tests anyone can rerun.

## Packages

| Package | What it is |
| --- | --- |
| `@invoice-primitives/core` | The primitives as pure functions. No dependencies, no I/O. |
| `@invoice-primitives/convex` | A Convex component: `app.use(invoicing)`, then call it from your mutations. |
| `@invoice-primitives/cloudflare` | A Durable Object per tenant, with SQLite. |

## The primitives

| Primitive | What you get |
| --- | --- |
| Money | `Decimal` on bigint. Only `round` and `div` lose precision, and both make you name a rounding mode. Currency decimals come from ISO 4217 (JPY 0, MYR 2, KWD 3). |
| Calculation | `compute(input, policy)` gives every EN 16931 total and tax subtotal. Policies cover rounding per line or per tax category, prices with or without tax, and cash rounding. |
| Document | Invoice and credit note as plain JSON: `draft → issued → void`. Figures are fixed at issue. |
| Numbering | Gapless sequences per series, such as `INV-{yyyy}-00001`, taken in the same transaction as the issue. |
| Settlement | Payments, credits and write-offs against an issued document. Balance, "paid" and "overdue" are derived, never stored. |
| Credit notes | `credit(invoice, note)` issues the note and applies it to the invoice in one step. |
| Delivery | A record of each delivery request and its outcome. `present()` gives a localised view with replaceable labels for any language, and `renderHtml()` turns it into branded, email-safe HTML. |
| Event log | Every change as an event, at gapless positions per tenant. Replaying the log rebuilds every document exactly. |
| Country packs | Tax categories, rounding policies and void rules as data. EU (EN 16931), Malaysia (PINT-MY, MyInvois 72-hour cancel) and Japan (qualified invoices) ship today. |

## How it fits together

```
your app ──▶ backend (Convex mutation │ Durable Object │ memory)
                 │  one transaction:
                 │    load state → take a number if issuing → execute → save state + events
                 ▼
            core: execute(state, command, context) → { state, events }      (pure, synchronous)
```

The whole state machine is two pure functions in `core`: `decide(state, command) → events` and `evolve(state, event) → state`. A backend only loads, numbers and saves. So the rules are identical everywhere, and a new backend is about 150 lines.

## Quick start (in memory)

```ts
import { createMemoryBooks, createRegistry, bundledPacks, balance, present, renderHtml } from "@invoice-primitives/core";

const books = createMemoryBooks({ registry: createRegistry(bundledPacks), timeZone: "Asia/Kuala_Lumpur" });

await books.create("inv_1", {
    kind: "invoice",
    policy: "my-pint@1",
    currency: "MYR",
    issueDate: "2026-10-23",
    due: { days: 30 },
    seller: { name: "Kedai Kopi Sdn Bhd" },
    buyer: { name: "Acme Trading", email: "ap@acme.example" },
    lines: [{ id: "1", name: "Consulting", quantity: "10", price: "150.00", taxes: [{ category: "SE", rate: "8" }] }],
});
const invoice = await books.issue("inv_1"); // INV-2026-00001, payable "1620.00"
await books.settle("inv_1", { id: "fpx_123", kind: "payment", amount: "620.00", date: "2026-10-25" });

const doc = await books.get("inv_1");
balance(doc, "2026-10-25"); // { outstanding: "1000.00", status: "partial", overdue: false, ... }
renderHtml(present(doc, { locale: "en-MY", asOf: "2026-10-25" }), { logoUrl: "https://…", accent: "#0f766e" });
```

`packages/core/test/readme.test.ts` runs this example as written.

Amounts are strings in and out. Commands that repeat what already happened change nothing, so a retried request is safe. A refused command throws an `InvoiceError` with a stable `code` and a `path` into your input.

## Convex

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import invoicing from "@invoice-primitives/convex/convex.config";

const app = defineApp();
app.use(invoicing);
export default app;
```

```ts
const invoicing = new Invoicing(components.invoicing);
await invoicing.configure(ctx, tenant, { timeZone: "Asia/Kuala_Lumpur" });
await invoicing.issue(ctx, tenant, "inv_1");
```

See `packages/convex/README.md`.

## Cloudflare

```jsonc
// wrangler.jsonc
"durable_objects": { "bindings": [{ "name": "INVOICING", "class_name": "InvoicingBooks" }] },
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["InvoicingBooks"] }]
```

```ts
export { InvoicingBooks } from "@invoice-primitives/cloudflare";
import { booksFor } from "@invoice-primitives/cloudflare";

const books = booksFor(env.INVOICING, tenantId); // one Durable Object per tenant
await books.configure({ timeZone: "Asia/Kuala_Lumpur" });
await books.issue("inv_1");
```

## Proof

Run these from the repository root:

```sh
pnpm -r test
```

- The same 19-scenario conformance suite passes against all three backends: memory, Convex (`convex-test`) and Cloudflare (inside `workerd`). It covers numbering under concurrency, gapless numbers after a refused issue, overpayment, idempotent retries, credit notes, and rebuilding every document from the event log.
- The calculation matches all 28 official EN 16931 and Peppol BIS 3 example invoices (`pnpm --filter @invoice-primitives/core corpus` fetches them first).
- 2,000 random invoices per property never break the EN 16931 rules and never gain or lose a cent.

This one runs inside the core package:

```sh
cd packages/core && node scripts/mutate.mjs
```

It plants known bugs one at a time and requires the tests to catch each.

## Hacking on it

- **A new backend.** Implement `Books` and pass `booksConformance("my-backend", makeBooks)` from `@invoice-primitives/core/testing`. Read `packages/core/src/memory.ts` first; it is the whole pattern.
- **A new country.** Write a `CountryPack` (`packages/core/src/packs/my.ts` is about 40 lines). A policy you publish is pinned by a golden file, so its figures never change silently.
- **Your own look.** `present()` gives every string already formatted, so a React component or a PDF template never formats money itself.

## Status

This is a prototype. `DESIGN.md` covers the laws the code keeps, the decisions behind it, what is not built yet, and the open questions.

## License

Apache-2.0
