# Contributing

Thank you for helping. Invoice Primitives handles money and legal documents, so
the bar for a change is that it is correct, tested and traceable to a written
rule. This guide covers setup, the rules the code keeps, and the two most
common contributions: a country pack and a backend.

## Setup

1. **Node.** Use the version in `.node-version`; any version manager that reads
   it works (`fnm`, `nvm`, `mise`, `volta`).
2. **pnpm.** The version is pinned in `package.json`. Enable it with Corepack:

   ```bash
   corepack enable
   ```

3. **Install and fetch the test corpus.**

   ```bash
   git clone git@github.com:cynco-labs/invoice-primitives.git
   cd invoice-primitives
   pnpm install
   pnpm corpus
   ```

   `pnpm corpus` downloads the official EN 16931 and Peppol example invoices
   into `packages/core/corpus/`. They are fetched rather than committed because
   of their licenses.

## Layout

| Path                  | What it holds                                                                 |
| --------------------- | ----------------------------------------------------------------------------- |
| `packages/core`       | The primitives: money, calculation, documents, settings, presentation, packs  |
| `packages/convex`     | The Convex component                                                          |
| `packages/cloudflare` | The Durable Object backend                                                    |
| `docs/`               | The integration guide                                                         |
| `skills/`             | The agent skill for people integrating the library                            |
| `DESIGN.md`           | The rules, the decisions and the open questions                               |

## Tasks

Run these from the repository root, or inside a package for that package alone.

```bash
pnpm test        # all packages
pnpm typecheck
pnpm build       # compiled JavaScript and declarations in each package's dist/
pnpm mutate      # plant known bugs one at a time; the suite must catch each
```

Packages point at their TypeScript source inside the workspace, and Node runs
it directly. `publishConfig` switches the published entry points to `dist/`.

## The rules

These come from [DESIGN.md](DESIGN.md). A pull request that breaks one needs a
design discussion first.

- **Exact or explicit.** No floats. Only `round` and `div` lose precision, and
  both take a rounding mode.
- **Refuse rather than guess.** An input the core cannot handle correctly throws
  an `InvoiceError` with a code and a path. It never returns a plausible wrong
  figure.
- **Traceable.** Every field names its EN 16931 business term, every check
  names its rule, and every tax rate names its source and the date it was
  checked.
- **Pure core.** `decide`, `evolve`, `compute` and friends do no I/O. Backends
  own storage, clocks and numbering.
- **The country is data.** No `if (country === "MY")` in the core.
- **Published policies never change.** A change in calculated figures needs a
  new policy id. The golden files in `packages/core/test/golden` fail if a
  published policy's output moves.

## Adding a country

A country pack is a file in `packages/core/src/packs/`. `my.ts` is a complete
example.

1. Declare the policies (where and how tax rounds), the tax categories, the
   defaults (policy, currency, time zone), the named taxes and the void rule.
2. Give every rate a `source` URL and a `checked` date. Prefer the tax
   authority's own publication. If you can only find a secondary source, say so
   in a comment.
3. Add the pack to `bundledPacks` in `packages/core/src/packs/index.ts`.
4. Add scenario tests with worked examples from the source, and run the golden
   tests once to record the new policies.

## Adding a backend

A backend implements `Books` from `packages/core/src/books.ts`. Read
`packages/core/src/memory.ts` first; it is the whole pattern:

```
in one transaction: load settings and state → expand → take a number if issuing → execute → save state + events
```

Then pass the shared suite:

```ts
import { booksConformance } from "@invoice-primitives/core/testing";

booksConformance("my-backend", async () => makeFreshBooks());
```

## Pull requests

- Keep one change per pull request.
- A bug fix comes with a test that fails without the fix.
- If you touch `calc/`, `money/` or `document/`, run `pnpm mutate`. If you add
  a guard, add a mutant that removes it.
- Say how AI was used. The pull request template asks; it helps us decide how
  to review.

## Reporting a vulnerability

Do not open a public issue. Follow [SECURITY.md](.github/SECURITY.md).
