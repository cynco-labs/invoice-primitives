# Invoice Primitives, from Cynco Labs

Invoice Primitives is an open source invoicing library for TypeScript: exact
money, tax that rounds the way tax authorities expect, gapless numbering,
payments, credit notes and an event log, as small pure functions with no
dependencies. Run it in memory, as a [Convex](https://convex.dev) component, or
on Cloudflare with a Durable Object per tenant. Made by
[Cynco Labs](https://github.com/cynco-labs).

> [!NOTE]
> Invoice Primitives is pre-release. The API can change before 0.1, and the
> packages are not on npm yet.

## Features

- Exact decimal money on `bigint`. Amounts never pass through a float.
- Calculation checked against all 28 official EN 16931 and Peppol example
  invoices, with rounding per tax category or per line, tax-inclusive prices
  and cash rounding
- Invoices that cannot change after issue. Corrections are credit notes, issued
  and applied in one step.
- Gapless numbering per series, unique per tenant, safe under concurrent issues
- Payments, partial payments and reversals. "Paid" and "overdue" are derived,
  never stored.
- Country packs for Malaysia (PINT-MY, MyInvois), Japan (qualified invoices) and
  the EU (EN 16931), with named taxes like `tax: "service-8"`. A pack is plain
  JSON, so you can bring your own jurisdiction to any backend.
- An event log per tenant that rebuilds every document exactly
- Localised, brandable HTML in any language
- One `Books` interface on every backend, held to one shared conformance suite.
  A new backend implements a small `Store`; core runs every rule.
- A JSON Schema of every shape and language-neutral test vectors, for callers
  and implementations in other languages

## Install

```bash
pnpm add @invoice-primitives/core
```

Add a backend when you need one: `@invoice-primitives/convex` or
`@invoice-primitives/cloudflare`.

## Quick start

```ts
import { createMemoryBooks } from "@invoice-primitives/core";

const books = createMemoryBooks();
await books.configure({ country: "MY", seller: { name: "Kedai Kopi Sdn Bhd" } });

const draft = await books.create({
  buyer: { name: "Acme Trading" },
  lines: [{ name: "Consulting", quantity: "10", price: "150.00", tax: "service-8" }],
});

const invoice = await books.issue(draft.id); // INV-2026-00001, payable "1620.00"
```

Swap the first line for `invoicing.books(ctx, tenant)` on Convex or
`booksFor(env.INVOICING, tenant)` on Cloudflare. The rest stays the same.

## Documentation

- [Guide](docs/guide.md): settings, backends, credit notes, errors,
  presentation, and when to use R2, D1 or KV
- [Design](DESIGN.md): the rules the code keeps, the decisions behind it, and
  what is not built yet
- Packages: [core](packages/core), [convex](packages/convex),
  [cloudflare](packages/cloudflare)

## Agent skill

Teach your coding agent to integrate Invoice Primitives with the
[Skills CLI](https://skills.sh/docs/cli):

```bash
npx skills add cynco-labs/invoice-primitives --skill invoicing
```

## Development

We use pnpm workspaces and Vitest. The Node version is pinned in
`.node-version`.

```bash
pnpm install
pnpm corpus      # fetch the official EN 16931 and Peppol example invoices
pnpm test        # every package; Cloudflare's suite runs inside workerd
pnpm typecheck
pnpm build
pnpm mutate      # plant known bugs one at a time; the suite must catch each
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

[Apache 2.0](LICENSE.md)
