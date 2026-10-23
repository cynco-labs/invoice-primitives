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
import { Invoicing, refusalOf } from "@invoice-primitives/convex";
import { v } from "convex/values";
import { components } from "./_generated/api";
import { mutation } from "./_generated/server";

const invoicing = new Invoicing(components.invoicing, { timeZone: "Asia/Kuala_Lumpur" });

export const issue = mutation({
    args: { id: v.string() },
    returns: v.string(),
    handler: async (ctx, { id }) => {
        const tenant = await tenantOf(ctx); // your own: derived from ctx.auth, never from args
        const doc = await invoicing.issue(ctx, tenant, id);
        return doc.status === "issued" ? doc.number : "";
    },
});
```

The client offers core's `Books` methods, each with `ctx` and `tenant` first: `create`, `update`, `discard`, `issue`, `void`, `settle`, `reverseSettlement`, `requestDelivery`, `completeDelivery`, `credit`, and the queries `get`, `getByNumber`, `events`. Mutations need a mutation or action `ctx`; queries take any `ctx`.

A refused command throws a `ConvexError` whose `data` is core's refusal, `{ code, path, detail }`. It reaches your React client intact if you let it propagate. Use `refusalOf(error)` to read it on the server.

## Tenants and time zones

- **Tenant.** Every function takes a `tenant` string, and everything is scoped by it: documents, numbering sequences, and the event log and its positions. Two tenants can use the same document ids, and each has its own `INV-2026-00001`. The component trusts the tenant it is given. Derive it from `ctx.auth` in your own functions, never from a client argument.
- **Time zone.** `timeZone` is the seller's IANA zone. It dates a document issued without an `issueDate`. The client holds the time zone and passes it on every call. If your tenants are in different zones, create one `Invoicing` per zone. The object is cheap.

## Storage

| Table | Holds | Index |
| --- | --- | --- |
| `documents` | The current state of each document, plus `number` copied out for lookup | `by_tenant_and_documentId`, `by_tenant_and_number` |
| `events` | Each tenant's log, at positions 1, 2, 3... with no gaps | `by_tenant_and_position` |
| `sequences` | The last number taken in each series | `by_tenant_and_series` |

State and events are stored as Convex objects and checked against validators that mirror core's types. `test/types.ts` fails to typecheck if the validators and core's types drift apart.

## Codegen

The component's `src/component/_generated/` is written by hand to match `npx convex codegen` output, so the package typechecks and tests without a deployment. `component.ts` derives `ComponentApi` from the function modules' types, not from a deployment's analysis. When an app that installs this package runs `npx convex dev`, the CLI regenerates these files from the deployment.

## Develop

```sh
pnpm test        # core's books conformance suite, run against the component with convex-test
pnpm typecheck
```
