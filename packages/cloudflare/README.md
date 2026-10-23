# @invoice-primitives/cloudflare

`@invoice-primitives/core` on Cloudflare Workers: one Durable Object per tenant, holding that tenant's documents, number sequences, settings and event log in its own SQLite database. It deploys with your Worker; there is no other service to run.

## Install

```sh
npm install @invoice-primitives/cloudflare
```

```jsonc
// wrangler.jsonc
{
  "durable_objects": { "bindings": [{ "name": "INVOICING", "class_name": "InvoicingBooks" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["InvoicingBooks"] }]
}
```

Run `npx wrangler types` afterwards, so `env.INVOICING` and the Durable Object types are known to TypeScript.

## Use

```ts
// src/index.ts
import { booksFor } from "@invoice-primitives/cloudflare";
export { InvoicingBooks } from "@invoice-primitives/cloudflare";

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const books = booksFor(env.INVOICING, tenantOf(request)); // tenantOf is yours, from your auth
        await books.configure({ country: "MY", seller: { name: "Kedai Kopi Sdn Bhd" } }); // once per tenant

        const draft = await books.create({
            buyer: { name: "Acme Trading" },
            lines: [{ name: "Consulting", quantity: "10", price: "150.00", tax: "service-8" }],
        });
        const invoice = await books.issue(draft.id);
        return Response.json(invoice);
    },
};
```

`booksFor` returns core's `Books`, the same object every backend gives, so the quick start in the root README runs here unchanged. A refusal arrives as an `InvoiceError` with its `code`, `path` and `detail`; map it to a 4xx response:

```ts
import { InvoiceError } from "@invoice-primitives/core";

try {
    return Response.json(await books.issue(id));
} catch (e) {
    if (e instanceof InvoiceError) return Response.json({ code: e.code, path: e.path, detail: e.detail }, { status: 422 });
    throw e;
}
```

## How it works

- **One object per tenant.** `booksFor(namespace, tenant)` addresses the object by name, so a tenant's data stays in one place and tenants never share a database or a lock.
- **One command, one transaction.** Each method runs `transactionSync`: load the state, take a number if issuing, run core, save the state and the events. The object handles one request at a time, so there are no locks and no retries. A refused command rolls back and draws no number.
- **Refusals cross RPC as values.** A thrown exception across Durable Object RPC is logged as a crash, so the object returns `{ ok: false, error }` and `booksFor` rethrows it as an `InvoiceError` on your side.
- **Storage.** Tables `documents` (state as JSON, with `number` unique), `events` (positions 1, 2, 3... with no gaps), `sequences` and `settings`.

## Cost

Durable Objects with SQLite are billed per request, per GB-second while handling a request, per row read and written, and per GB stored. Idle objects that can hibernate are not billed for duration. Invoicing is short requests, so a tenant's object is idle almost all the time. See Cloudflare's [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## Develop

```sh
pnpm test        # core's conformance suite, inside workerd, through Durable Object RPC
pnpm typecheck
pnpm build
```
