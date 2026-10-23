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

## Quick start

Configure a tenant once. After that, an invoice is a buyer and lines.

```ts
import { createMemoryBooks, balance, present, renderHtml } from "@invoice-primitives/core";

const books = createMemoryBooks();
await books.configure({ country: "MY", seller: { name: "Kedai Kopi Sdn Bhd" } });

const draft = await books.create({
    buyer: { name: "Acme Trading", email: "ap@acme.example" },
    due: { days: 30 },
    lines: [{ name: "Consulting", quantity: "10", price: "150.00", tax: "service-8" }],
});
const invoice = await books.issue(draft.id); // INV-2026-00001, payable "1620.00"
await books.settle(draft.id, { id: "fpx_123", kind: "payment", amount: "620.00", date: "2026-10-25" });

const doc = await books.get(draft.id);
balance(doc, "2026-10-25"); // { outstanding: "1000.00", status: "partial", overdue: false, ... }
const html = renderHtml(present(doc, { locale: "en-MY", asOf: "2026-10-25" }), { logoUrl: "https://…", accent: "#0f766e" });
```

`packages/core/test/readme.test.ts` runs this example as written, with the clock pinned to 23 October 2026.

**What `country: "MY"` gives you.** The calculation policy (PINT-MY), the currency (MYR), the time zone (Asia/Kuala_Lumpur) and named taxes: `sales-10`, `sales-5`, `service-8`, `service-6`, `tourism`, `exempt` and `outside-scope`. Each named tax records its source and the date it was checked. Japan (`"JP"`) and the EU (`"EU"`) ship too. Any of these can be overridden in `configure` or on a single document. A line can also spell its taxes out (`taxes: [{ category: "SE", rate: "8" }]`) instead of naming one.

**What you can rely on:**
- Amounts are strings in and out (`"150.00"`), so nothing passes through a float.
- A command that repeats what already happened changes nothing, so a retried request is safe. Pass your own `id` to `create` for the same guarantee on creation.
- A refused command throws an `InvoiceError` with a stable `code` and a `path` into your input, and a message that says what to do: `lines[0].tax: MY has no tax named vat-20; it has sales-10, sales-5, service-8, ...`.

## Pick a backend

The code above runs unchanged on every backend. Only the first line changes.

| You run on | First line | Data lives in |
| --- | --- | --- |
| Tests, scripts, prototypes | `createMemoryBooks()` | Memory |
| Convex | `invoicing.books(ctx, tenant)` | The component's own tables in your deployment |
| Cloudflare Workers | `booksFor(env.INVOICING, tenant)` | One Durable Object per tenant, with its own SQLite |

### Convex

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import invoicing from "@invoice-primitives/convex/convex.config";

const app = defineApp();
app.use(invoicing);
export default app;
```

```ts
// convex/invoices.ts
import { Invoicing } from "@invoice-primitives/convex";
import { components } from "./_generated/api";

const invoicing = new Invoicing(components.invoicing);

export const issue = mutation({
    args: { id: v.string() },
    handler: async (ctx, { id }) => invoicing.books(ctx, await tenantOf(ctx)).issue(id),
});
```

`tenantOf` is yours: derive the tenant from `ctx.auth`, never from a client argument. See `packages/convex/README.md`.

### Cloudflare

```jsonc
// wrangler.jsonc
"durable_objects": { "bindings": [{ "name": "INVOICING", "class_name": "InvoicingBooks" }] },
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["InvoicingBooks"] }]
```

```ts
// src/index.ts
export { InvoicingBooks } from "@invoice-primitives/cloudflare";
import { booksFor } from "@invoice-primitives/cloudflare";

export default {
    async fetch(request, env) {
        const books = booksFor(env.INVOICING, tenantOf(request)); // yours, from your auth
        // ... books.create(...), books.issue(...)
    },
};
```

The Durable Object deploys with your Worker (`wrangler deploy`); there is nothing else to run. Why a Durable Object and not D1: issuing needs read → decide → write in one transaction, so that numbers are gapless. A Durable Object gives that directly. D1's API commits statements as they run, or in a `batch()` fixed up front.

### What about R2, D1, KV?

- **R2.** Not needed. Invoices are rows, not files. When you want to keep a rendered copy of each issued invoice (an archive, or a PDF to attach), store `renderHtml(...)` or your PDF in R2 yourself. The event log tells you when (`issued`).
- **D1.** Not needed. A D1 backend is possible; it would pass the same conformance suite, but it needs retries for what a Durable Object does in one transaction.
- **KV.** Not suitable. It is eventually consistent, so two requests could take the same number.

## How it fits together

```
your app ──▶ backend (Convex mutation │ Durable Object │ memory)
                 │  one transaction:
                 │    load settings and state → expand the short document
                 │    → take a number if issuing → execute → save state + events
                 ▼
            core: execute(state, command, context) → { state, events }      (pure, synchronous)
```

The whole state machine is two pure functions in `core`: `decide(state, command) → events` and `evolve(state, event) → state`. A backend only loads, numbers and saves. So the rules are identical everywhere, and a new backend is about 150 lines.

## Proof

Run these from the repository root:

```sh
pnpm -r test
```

- The same 21-scenario conformance suite passes against all three backends: memory, Convex (`convex-test`) and Cloudflare (inside `workerd`). It covers the short path, settings, numbering under concurrency, gapless numbers after a refused issue, overpayment, idempotent retries, credit notes, tenant isolation, paging, and rebuilding every document from the event log.
- The calculation matches all 28 official EN 16931 and Peppol BIS 3 example invoices (`pnpm --filter @invoice-primitives/core corpus` fetches them first).
- 2,000 random invoices per property never break the EN 16931 rules and never gain or lose a cent.

This one runs inside the core package:

```sh
cd packages/core && node scripts/mutate.mjs
```

It plants known bugs one at a time and requires the tests to catch each.

## Hacking on it

- **A new backend.** Implement `Books` and pass `booksConformance("my-backend", makeBooks)` from `@invoice-primitives/core/testing`. Read `packages/core/src/memory.ts` first; it is the whole pattern.
- **A new country.** Write a `CountryPack` (`packages/core/src/packs/my.ts` is under 80 lines): policies, tax categories, defaults and named taxes, each with its source. A policy you publish is pinned by a golden file, so its figures never change silently.
- **Your own look.** `present()` gives every string already formatted, so a React component or a PDF template never formats money itself.

## Status

This is a prototype. `DESIGN.md` covers the laws the code keeps, the decisions behind it, what is not built yet, and the open questions.

## License

Apache-2.0
