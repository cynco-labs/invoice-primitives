# @invoice-primitives/convex

`@invoice-primitives/core` as a Convex component: invoices and credit notes with gapless numbering, settlements, deliveries and a per-tenant event log. Each command runs in one Convex mutation.

## Install

```sh
pnpm add @invoice-primitives/convex
```

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import invoicing from "@invoice-primitives/convex/convex.config";

const app = defineApp();
app.use(invoicing);
export default app;
```

## Use

```ts
// convex/invoices.ts
import { Invoicing } from "@invoice-primitives/convex";
import { v } from "convex/values";
import { components } from "./_generated/api";
import { mutation } from "./_generated/server";

const invoicing = new Invoicing(components.invoicing);

export const issue = mutation({
    args: { id: v.string() },
    returns: v.string(),
    handler: async (ctx, { id }) => {
        const books = invoicing.books(ctx, await tenantOf(ctx)); // tenantOf is yours: from ctx.auth, never from args
        const doc = await books.issue(id);
        return doc.status === "issued" ? doc.number : "";
    },
});
```

`invoicing.books(ctx, tenant)` returns core's `Books`, the same object every backend gives, so code written against the root README's quick start runs here unchanged. The client also offers each method directly, with `ctx` and `tenant` first: `configure`, `create`, `update`, `discard`, `issue`, `void`, `settle`, `reverseSettlement`, `requestDelivery`, `completeDelivery`, `credit`, `rebuildListings`, and the queries `get`, `getByNumber`, `list`, `events`. A query a client subscribes to is not rerun when the date changes, so pass `asOf` to `list` from the client when it asks for overdue documents. Mutations need a mutation or action `ctx`; queries take any `ctx`.

Through `books()`, a refused command throws core's `InvoiceError`, as on every backend, and malformed arguments are refused with a code and a path before they reach the component. The direct methods throw a `ConvexError` whose `data` is the refusal, `{ code, path, detail }`; it reaches your React client intact if you let it propagate, and `refusalOf(error)` turns it back into an `InvoiceError` on the server.

## Your own country packs

`new Invoicing(components.invoicing, { packs: [...bundledPacks, mine] })` sends the packs, as JSON, with every call; Convex checks each against the generated `vCountryPack` validator and core checks it again. A pack is data, so it crosses the component boundary like any other argument.

## Tenants and time zones

- **Tenant.** Every function takes a `tenant` string, and everything is scoped by it: documents, numbering sequences, and the event log and its positions. Two tenants can use the same document ids, and each has its own `INV-2026-00001`. The component trusts the tenant it is given. Derive it from `ctx.auth` in your own functions, never from a client argument.
- **Settings.** `invoicing.configure(ctx, tenant, { timeZone, numbering })` stores a tenant's settings in the component. `timeZone` is the seller's IANA zone and dates a document issued without an `issueDate` (default UTC). `numbering` sets each kind's prefix and width, with `{yyyy}` for the issue year (default `INV-{yyyy}-00001`, `CN-{yyyy}-00001`). A number already taken in the tenant is refused with `duplicate-number`, whatever series produced it.

## Storage

| Table | Holds | Index |
| --- | --- | --- |
| `documents` | The current state of each document, plus `number` copied out for lookup | `by_tenant_and_documentId`, `by_tenant_and_number` |
| `listings` | Each document's listing (kind, stage, customer, due date) and `seq`, for `list` | `by_tenant_and_seq`, and by kind, stage or customer then `seq` |
| `events` | Each tenant's log, at positions 1, 2, 3... with no gaps, each with its `format` | `by_tenant_and_position`, `by_tenant_and_documentId_and_position` |
| `sequences` | The last number taken in each series | `by_tenant_and_series` |
| `settings` | Each tenant's time zone and numbering | `by_tenant` |

State and events are stored as Convex objects and checked against validators that mirror core's types. `test/types.ts` fails to typecheck if the validators and core's types drift apart.

## Codegen

The component's `src/component/_generated/` is written by hand to match `npx convex codegen` output, so the package typechecks and tests without a deployment. `component.ts` derives `ComponentApi` from the function modules' types, not from a deployment's analysis. When an app that installs this package runs `npx convex dev`, the CLI regenerates these files from the deployment.

## Throughput

Each command that records events reads the tenant's log head, so a tenant's writes are serialised by Convex's optimistic concurrency: two commands for one tenant at the same moment conflict, and Convex reruns the loser. That buys a gapless log every consumer can page through by position without missing an event. Issues in one series are serialised anyway, because numbers must be gapless. The tests run on `convex-test`, which executes mutations one at a time, so the conflict path itself is not exercised there; how many commands per second one tenant can sustain on a real deployment is unmeasured.

## Develop

```sh
pnpm test        # core's books conformance suite, run against the component with convex-test
pnpm typecheck
```
