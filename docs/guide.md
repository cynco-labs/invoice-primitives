# Guide

Everything you need to integrate invoicing: the short path, backends, storage choices, credit notes, errors and presentation. For the reasoning behind the design, read [DESIGN.md](../DESIGN.md).

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

**Install.** `npm install @invoice-primitives/core`, plus `@invoice-primitives/convex` or `@invoice-primitives/cloudflare` for a backend. The packages ship compiled JavaScript with type declarations and have no runtime dependencies beyond core. Until they are published, `pnpm pack` in each package gives you tarballs to install.

**Good to know:**
- `balance(doc, asOf)` counts the payments dated on or before `asOf`. Leave `asOf` out to count all of them.
- A credit note takes the same short lines as `create`, with positive quantities: `books.credit(invoiceId, { id: "cn_1", input: { lines: [{ name: "Refund: 1 hour", quantity: "1", price: "150.00", tax: "service-8" }] } })`. It is issued and applied to the invoice in one step.
- A party's address is `{ lines: ["Lot 12, Jalan Ampang"], city: "Kuala Lumpur", postalCode: "50450", country: "MY" }`.

**Lists.** Give a document your id for the buyer as `customer`, and the books index it for you:

```ts
await books.list({ status: "overdue" });               // open and past due, in the seller's time zone
await books.list({ customer: "cus_42", limit: 20 });    // one buyer's documents, newest first
const page = await books.list({ kind: "invoice", status: "open" });
if (page.next) await books.list({ kind: "invoice", status: "open", cursor: page.next });
```

`status` is `draft`, `open` (including partly paid and overdue), `overdue`, `settled`, `void` or `discarded`; without one, every document but discarded drafts. "Overdue" is judged on today in the seller's time zone, or on `asOf: "2026-10-31"`; `asOf` goes only with `status: "overdue"`, because the other statuses count every payment recorded. For one document on a date, use `balance(doc, date)`. In a Convex query that a client subscribes to, pass `asOf` from the client, because a cached query is not rerun when the date changes. A credit note keeps its invoice's `customer`. Keep paging while `next` is present: a page can come back short, or empty, before the end.

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

`tenantOf` is yours: derive the tenant from `ctx.auth`, never from a client argument. See [packages/convex/README.md](../packages/convex/README.md).

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

The Durable Object deploys with your Worker (`wrangler deploy`); there is nothing else to run. See [packages/cloudflare/README.md](../packages/cloudflare/README.md). Why a Durable Object and not D1: issuing needs read → decide → write in one transaction, so that numbers are gapless. A Durable Object gives that directly. D1's API commits statements as they run, or in a `batch()` fixed up front.

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

Every command runs in `createBooks`, in core, on the backend's `Store`. The state machine inside it is two pure functions: `decide(state, command) → events` and `evolve(state, event) → state`. A store only reads and writes rows, so the rules are identical everywhere. To add a backend, implement `Store` from `@invoice-primitives/core/backend` and run `booksConformance` from `@invoice-primitives/core/testing` against it; `memoryStore` is the reference.

## Your own jurisdiction

A country pack is JSON: policies, tax categories, named taxes, rules and voiding. Pass yours with the bundled ones on any backend:

```ts
import { bundledPacks, type CountryPack } from "@invoice-primitives/core";

const zz: CountryPack = {
    id: "ZZ",
    policies: { standard: { id: "zz-standard@1", taxRounding: "document", rounding: { amounts: "half-away-from-zero", tax: "half-away-from-zero" }, pricesIncludeTax: false } },
    taxCategories: { S: { label: "Standard", levies: true }, E: { label: "Exempt", levies: false } },
    taxes: { "vat-7": { label: "VAT 7%", taxes: [{ category: "S", rate: "7" }], source: "https://…", checked: "2026-10-23" } },
    rules: [{ id: "ZZ-1", message: "the buyer has a TIN", source: "https://…", check: { require: "data.buyer.ids[scheme=TIN].value" } }],
    defaults: { policy: "standard", currency: "MYR", timeZone: "Asia/Kuala_Lumpur" },
    voiding: { allowed: true },
};

const books = createMemoryBooks({ packs: [...bundledPacks, zz] }); // or { packs } on Convex and Cloudflare
await books.configure({ country: "ZZ", seller: { name: "Zed Ltd" } });
```

A pack is checked when the books are built: its shape, its time zone and currency, that every named tax uses a category the pack has, and that every rule path can be read. A malformed one is refused with a path (`packs[0].rules[1].check.require`). `require` counts a value as given only when it is not blank and not an empty list. A rule checks a path into `{ data, figures }` with `require`, `match` (a regular expression) or `oneOf`. Policies are named values that `compute` implements; publishing a new policy id is how figures change.

## Other languages

`@invoice-primitives/core/schema.json` is the JSON Schema of every shape: documents, events, packs, settings, list queries. `packages/core/vectors/` holds calculation and document test vectors, inputs with the outputs this library gives, for an implementation in another language to check itself against.
