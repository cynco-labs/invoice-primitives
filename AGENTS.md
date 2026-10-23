# Invoice Primitives

Instructions for coding agents working in this repository. People integrating
the library should use the agent skill in `skills/invoicing/` instead.

## Toolchain

- Node from `.node-version`; pnpm from `packageManager` in `package.json`, via
  Corepack. Use pnpm for every package operation, never npm or yarn.
- Tests are Vitest. The Cloudflare package runs its tests inside `workerd`
  through `@cloudflare/vitest-plugin`.
- Source is erasable TypeScript with `.ts` import extensions: no enums, no
  namespaces, no parameter properties. Node runs it directly.

## Commands

```bash
pnpm corpus      # once, before the core tests
pnpm test
pnpm typecheck
pnpm build
pnpm mutate      # after touching calc/, money/ or document/
```

## Rules

- Read `DESIGN.md` before changing `packages/core`. Its rules are binding.
- Never introduce a float into an amount. Amounts are decimal strings at the
  boundary and `Decimal` inside.
- A refusal is an `InvoiceError` with a code from `INVOICE_ERROR_CODES` and a
  path. Add a new code to that list rather than throwing a plain `Error` for
  bad input.
- Backends hold no business rules. A rule belongs in `decide`, `evolve` or
  `expand`, where every backend gets it.
- A new behaviour gets a scenario in `packages/core/src/testing/conformance.ts`,
  so that every backend is held to it.
- Never edit the published output of a policy. The golden tests guard it; a
  change in figures needs a new policy id.
- Tax rates come from a source you have read, recorded with the date you
  checked it. Do not write rates from memory.
- Keep comments for the non-obvious why. Preserve trailing newlines.

## Licensing

Every package is Apache 2.0, with a `LICENSE.md` at its root. A new package
copies one.
