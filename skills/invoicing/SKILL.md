---
name: invoicing
description:
  Use when an app issues or tracks invoices with @invoice-primitives/core,
  @invoice-primitives/convex or @invoice-primitives/cloudflare, including
  configuring a seller and country, creating and issuing invoices, recording
  payments, credit notes, numbering, rendering HTML, and mapping refusals to
  responses.
---

# Invoice Primitives

`@invoice-primitives/core` keeps a tenant's invoices: drafts, issue with
gapless numbers, payments, credit notes and an event log. Every backend returns
the same `Books` object.

## Install

```bash
pnpm add @invoice-primitives/core
pnpm add @invoice-primitives/convex      # on Convex
pnpm add @invoice-primitives/cloudflare  # on Cloudflare Workers
```

## Get a tenant's books

| Runtime       | Code                                                                                   |
| ------------- | -------------------------------------------------------------------------------------- |
| Tests, Node   | `const books = createMemoryBooks()`                                                    |
| Convex        | `const books = new Invoicing(components.invoicing).books(ctx, tenant)` inside a mutation |
| Cloudflare    | `const books = booksFor(env.INVOICING, tenant)`                                         |

Derive `tenant` from authentication. Never take it from a request body.

Each takes `packs` for a jurisdiction the bundled packs do not cover:
`createMemoryBooks({ packs })`, `new Invoicing(components.invoicing, { packs })`,
`booksFor(env.INVOICING, tenant, { packs })`, with
`packs: [...bundledPacks, myPack]`. A pack is plain JSON (policies, tax
categories, named taxes, rules, voiding); copy the shape of `my` from
`@invoice-primitives/core/packs/my`.

Convex setup: `app.use(invoicing)` in `convex/convex.config.ts`, importing
`invoicing` from `@invoice-primitives/convex/convex.config`.

Cloudflare setup: export `InvoicingBooks` from the Worker entry, and add the
binding `INVOICING` with class `InvoicingBooks` and a migration with
`new_sqlite_classes: ["InvoicingBooks"]` to `wrangler.jsonc`.

## Configure once per tenant

```ts
await books.configure({
  country: "MY", // "MY", "JP" or "EU": policy, currency, time zone and named taxes
  seller: { name: "Kedai Kopi Sdn Bhd", ids: [{ scheme: "TIN", value: "C1234567890" }] },
});
```

Optional: `currency`, `timeZone`, and `numbering`
(`{ invoice: { prefix: "INV-{yyyy}-", digits: 5 }, "credit-note": { ... } }`).

## Invoice lifecycle

```ts
const draft = await books.create({
  id: "inv_123", // optional; pass one to make a retried create harmless
  buyer: { name: "Acme Trading", email: "ap@acme.example" },
  due: { days: 30 },
  lines: [{ name: "Consulting", quantity: "10", price: "150.00", tax: "service-8" }],
});
await books.update(draft.id, { ...sameShapeAsCreate }); // drafts only
const invoice = await books.issue(draft.id); // number taken here; figures fixed
await books.settle(draft.id, { id: "pay_1", kind: "payment", amount: "620.00", date: "2026-10-25" });
await books.credit(draft.id, { id: "cn_1", input: { lines: [{ name: "Refund", quantity: "1", price: "150.00", tax: "service-8" }] } });
```

Named taxes by country:

- MY: `sales-10`, `sales-5`, `service-8`, `service-6`, `tourism`, `exempt`,
  `outside-scope`
- JP: `standard-10`, `reduced-8`, `exempt`, `outside-scope`
- EU: `exempt`, `zero`, `reverse-charge`, `intra-community`, `export`,
  `outside-scope`

For an EU standard rate, spell it out: `taxes: [{ category: "S", rate: "21" }]`.

## Read

```ts
import { balance, present, renderHtml } from "@invoice-primitives/core";

const doc = await books.get(id);
if (doc?.status === "issued") {
  balance(doc, today); // { outstanding, status: "open" | "partial" | "settled", overdue, daysOverdue }
  const html = renderHtml(present(doc, { locale: "en-MY", asOf: today }), { logoUrl, accent: "#0f766e", footer });
}
```

`present` takes `labels` to translate every printed word.

```ts
const page = await books.list({ status: "overdue", customer: "cus_42" }); // newest first
// status: draft | open | overdue | settled | void | discarded (left out unless asked for)
// kind: invoice | credit-note; asOf: only with status overdue, the date it is judged on (default today, seller's time zone)
// more: books.list({ ...sameQuery, cursor: page.next }) while page.next is set; pages can be short
```

Pass `customer` (your id for the buyer) on `create` to list a buyer's documents.

## Rules

- Amounts and quantities are decimal strings: `"150.00"`, `"10"`. Never pass
  numbers.
- Do not store "paid" or "overdue" yourself, or keep your own index of
  invoices. Call `balance(doc, date)` for one document and `books.list` for
  many.
- An issued invoice never changes. To correct one, call `books.credit`. A draft
  can be discarded with `books.discard`.
- Payment, credit note and delivery ids are yours. Reuse the same id when you
  retry the same action.
- A credit cannot exceed what is still owed, and an invoice with a live payment
  or credit cannot be voided.

## Errors

A refusal throws `InvoiceError` with `code`, `path` and `detail`, on every
backend. On Convex, the client's direct methods (not `books()`) throw a
`ConvexError` instead; `refusalOf(error)` turns it into the `InvoiceError`.

```ts
import { InvoiceError } from "@invoice-primitives/core";

try {
  await books.issue(id);
} catch (e) {
  if (e instanceof InvoiceError) return Response.json({ code: e.code, path: e.path, detail: e.detail }, { status: 422 });
  throw e;
}
```

Common codes: `missing-field` (configure a seller or country),
`invalid-tax` (unknown named tax; the detail lists the valid ones),
`invalid-amount` (a number or a non-positive amount), `invalid-transition`
(the document is not in a state that allows the action), `overpayment`,
`credit-exceeds-outstanding`, `has-settlements`.

## More

The full guide is `docs/guide.md` in the repository, and the design is
`DESIGN.md`.
