# Design

Working name: `invoice-primitives`. Status: prototype. The core primitives and three backends work end to end; everything here is open to change before 0.1.

## What it is for

A developer building anything that issues or receives invoices needs the same few hard things: amounts that never drift, tax that rounds the way a tax authority expects, a document that cannot change after it is issued, and output a validator accepts. Today a TypeScript developer gets serializers that expect the totals to be computed already, or a full billing product to adopt wholesale. Correct calculation engines exist in Java (Mustang) and Go (GOBL), but not in TypeScript.

This library is the missing core: small pure functions, one per concern, that any app, ERP, POS or agent can call.

## Laws

These hold for every module. A change that breaks one needs a design discussion, not a review comment.

1. **Exact or explicit.** Amounts are bigint decimals. Addition, subtraction and multiplication are exact. Only `round` and `div` lose information, and both require a rounding mode, so every rounding point is visible in the code. A number passed as an amount fails to typecheck and throws at runtime; amounts travel as strings.
2. **A policy is data with an id, and results carry it.** A result records its policy, the core version and the scale it was computed at. `test/golden` pins the output of every published policy, so a change in behaviour fails CI and needs a new policy id. This is Cynco's `calcVersion`, made public.
3. **Refuse rather than guess.** An input the core does not handle throws `InvoiceError` with a stable `code` and a `path` into the input. It never returns a plausible wrong figure. An independent review found one place where it did (below), and a mutation test now guards it.
4. **Traceable to a written rule.** Every field names its EN 16931 business term (BT-x). A check carries an EN 16931 rule id only when it is that rule; checks that follow the policy instead are named for the policy.
5. **Pure core, I/O at the edges.** `compute`, `verify`, `decide`, `evolve` and `creditInvoice` are synchronous, allocate no ids, and never mutate what the caller passed in. Backends own storage, clocks and numbering.
6. **The country is data, not a branch.** No `if (country === "MY")` in the core. See "The country seam" for how far this holds today.

## Layers

| Layer | Where | State |
| --- | --- | --- |
| Exact decimal, allocation | `core/src/money/` | Built |
| ISO 4217 minor units | `core/src/money/currencies.ts`, generated from the SIX list | Built |
| Calculation (BT-106..117, BT-131) and its checks | `core/src/calc/` | Built |
| Errors with codes and paths | `core/src/errors.ts` | Built |
| Document: draft, issue, void, settle, deliver, as `decide`/`evolve` | `core/src/document/execute.ts` | Built |
| Balance, derived on read | `core/src/document/balance.ts` | Built |
| Credit notes, issued and applied together | `core/src/document/credit.ts` | Built |
| Numbering as data, gapless per series, unique per tenant | `core/src/document/execute.ts`, each backend | Built |
| Presentation: a localised view with replaceable labels, branded HTML | `core/src/present/` | Built |
| `Books`: the backend contract, and its conformance suite | `core/src/books.ts`, `core/src/testing/` | Built |
| Backends | `core/src/memory.ts`, `packages/convex`, `packages/cloudflare` | Built |
| Country packs | `core/src/packs/` | Policies, categories, void rules; no rules written yet |
| Listing and search (by status, buyer, due date) | `Books` | Not built |
| Codecs: UBL 2.1 (Peppol, PINT-MY, MyInvois), CII | `packages/ubl`, ... | Not built |
| Transport: MyInvois API, Peppol access points | separate packages | Not built |
| Tax determination: which tax applies | separate layer | Not built |

## Architecture

```
your app ──▶ backend (Convex mutation │ Durable Object │ memory)
                 │  one transaction:
                 │    load state → take a number if issuing → execute → save state + events
                 ▼
            core: execute(state, command, context) → { state, events }      (pure, synchronous)
```

- **The state machine is two pure functions.** `decide(state, command, context)` returns events or throws an `InvoiceError`. `evolve(state, event)` returns the next state. The rules live once, in core, and run identically on every backend. A backend loads, numbers and saves; that is all it does.
- **State is stored, events are appended.** Each document's current state is saved beside the events that produced it, in the same transaction. Reads are one row; the log is the audit trail, the integration feed, and the proof: replaying it must rebuild every document exactly, and the conformance suite checks that on every backend.
- **Idempotency comes from caller ids, not a key table.** A document id, a settlement id, a delivery id and a credit note id are chosen by the caller. Repeating a command with the same id and the same values returns no events. Repeating it with different values is refused with `duplicate-id` or `already-exists`.
- **Numbers come from the backend, inside the transaction.** `numberingFor(data, context)` names the series; the backend takes its next value and passes the number into `issue`. A refused issue rolls back and draws nothing, so numbers have no gaps. Each backend also refuses a number already held by another document in the tenant (`duplicate-number`), so a change of numbering settings cannot mint a duplicate.
- **Balance is never stored.** "Paid", "partly paid" and "overdue" are computed from the settlements and a date each time, so they cannot drift.
- **A credit note exists only applied.** `create` refuses a credit note. `creditInvoice` creates, issues and applies one in a single transaction, and a credit settlement cannot be reversed on its own. Undoing a credit note is not built, so the pair stays consistent by refusal.
- **Every backend passes the same suite.** `booksConformance(name, makeBooks)` drives a backend only through `Books`: numbering under concurrency, refused commands leaving no trace, idempotent retries, credits, settings, paging, tenant isolation, and event replay.

### The tenant log is gapless, and that costs throughput

Each tenant's events get positions 1, 2, 3... with no gaps, so a consumer pages by position and can never skip an event that committed late. The price is that every write in a tenant reads the log head:

- **Durable Object.** One object per tenant runs one request at a time, so the cost is nil; the object itself bounds the tenant's throughput.
- **Convex.** Two writes in one tenant at the same moment conflict, and Convex reruns the loser. Invoicing is business-paced, and issues in a series are serialised by gapless numbering anyway, so this is the right default. A tenant writing many events per second would want per-document versions plus a commit-ordered cursor instead. The conflict path is not exercised by `convex-test`, which runs mutations one at a time, and the sustained rate is unmeasured.

## The country seam

What varies between countries, found while building the three packs:

| Varies | Example | Where it lives today |
| --- | --- | --- |
| Where tax is rounded | EN 16931, PINT and Japan: once per category per document. Some systems: per line. | `Policy.taxRounding` |
| How tax and amounts round | EN 16931 2026 revision: half away from zero (second-hand summary, not the CEN text). Japan: the business chooses for tax only. | `Policy.rounding.tax`, `Policy.rounding.amounts` |
| Whether prices include tax | Japan and most retail: tax extracted from the shelf price. EN 16931: net prices. | `Policy.pricesIncludeTax` |
| Cash rounding of the amount due | Malaysia: nearest 5 sen, recorded in BT-114. | `Policy.cashIncrement` |
| Taxes that are not a rate | Malaysian tourism tax: a fixed amount per room per night. | `TaxInput.perUnit` |
| Tax on tax | Some provincial and excise taxes. | `TaxInput.compound` (line rounding only) |
| Tax categories | UNCL5305 in the EU. PINT MY: SA, SE, HVG, LVG, TTX, E, O. | `CountryPack.taxCategories` (not yet enforced) |
| Whether an issued document can be voided | MyInvois: within 72 hours of validation. EN 16931: never, issue a credit note. | `CountryPack.canVoid` |
| Required fields and local rules | MSIC code, TIN formats, self-billing rules. | `CountryPack.rules` (empty in all three packs) |
| Wire format | Peppol BIS, PINT-MY, MyInvois UBL, CII, Factur-X. | codecs (not built) |

### The open decision: a closed policy or composed strategies

Today a pack chooses values for fields that `compute` interprets. That is a closed set: a country whose arithmetic needs a value `compute` does not know cannot be added without changing the core. The independent review named three such cases, which I have not yet checked against their sources:

- **India.** The reviewer cites CGST s.170 for rounding the tax total to the whole rupee across categories. That would be a third tax-rounding point.
- **Brazil.** ICMS "por dentro" taxes a base that includes the tax itself: base = price ÷ (1 − rate).
- **US sales tax.** Stacked jurisdictions often round the combined rate once and then split it. Withholding taxes, which reduce the amount due but not BT-112, also have no slot today.

The alternative is to make a policy a composition of a few named steps, each a small function with a registry entry: `lineAmount`, `taxBase`, `taxRounding`, `payableRounding`. `compute` then runs the steps in a fixed order. A country that needs new arithmetic adds a step implementation in its pack, and the core stays closed to edits but open to extension.

The cost is that a policy is no longer plain JSON, and a step is code that can be wrong in ways the core's properties no longer cover. One mitigation is to make every step obey a property contract (`verify` must pass, and the amount due equals the sum of what the steps said). Then any contributed step runs through the same 2,000-invoice property suite.

This is the most consequential decision before 0.1. It decides whether "any country can plug in" is true or aspirational. The fields stay as they are until the step boundaries are designed against at least India and one US state, from their sources.

### Inclusive prices are a real choice, not a detail

For ¥1,099 tax-inclusive at 10%, Japanese practice extracts tax as floor(1,099 × 10 ÷ 110) = ¥99, leaving ¥1,000 taxable. EN 16931 rule BR-CO-17 requires tax = round(taxable × 10%). With floor rounding, no whole-yen taxable amount satisfies both: ¥999 gives 999 + 99 = 1,098, and ¥1,000 gives 1,100. So the policy names its choice:

- `"extract"` follows the shelf-price method. BR-CO-17 can be one unit off.
- `"reconcile"` picks the taxable amount that satisfies BR-CO-17 and records any residual in BT-114 (the rounding amount). The amount due is still the shelf price. A stated BT-114 cannot be combined with a nonzero residual; that is refused.

Line nets in a group are each line's own extraction, plus the few units the group-level rounding moved, spread by line size. A sale and its full return in one group keep opposite nets.

### Calculation is not determination

The core calculates tax from the taxes a line carries. Deciding which taxes a line carries is determination: place of supply, reverse charge, product taxability, registration thresholds, dated rate changes. That knowledge is large, per country, and changes often. It will be a separate layer, so the calculation core stays small enough to read in one sitting.

## Data model

The model follows the EN 16931 semantic model. It is the only internationally agreed invoice model. Peppol BIS 3 and PINT (the international Peppol model, specialised per country, for example Malaysia's PINT-MY) are built on it, and MyInvois uses the same UBL syntax. Names are plain English (`lineNet`, `taxExclusive`) with the BT number beside each field, so a reader can check the norm without learning UBL tag names.

Two departures from EN 16931:

- A line may carry several taxes, because per-unit and compound taxes exist outside the EU. An EN 16931 codec will refuse a line with more than one.
- A percentage allowance or charge must state its base. The norm defines no default, so the core does not invent one. The type `{ amount } | { percent, base }` makes the missing base a compile error.

Under tax-inclusive prices, a line's allowances and charges are tax-inclusive as well, while its net (BT-131) is always tax-exclusive.

## Evidence

Each item is reproducible from the repository (`pnpm -r test` from the root).

- **Backends.** The 19-scenario conformance suite passes on memory, on Convex (through the component, with `convex-test`) and on Cloudflare (inside `workerd`, through Durable Object RPC). Convex and Cloudflare add their own tests for tenants and the component boundary.
- **Official examples.** 19 CEN TC 434 UBL examples and 9 Peppol BIS 3 examples, fetched by `pnpm corpus` in `packages/core` (EUPL-1.2 and unlicensed, so not committed). Given each file's stated line amounts, all 28 match every stated total and tax subtotal. From quantity and price, 21 match; the other 7 state line amounts that are not quantity × price, which Peppol rule R120 forbids, and the test checks that independently.
- **Properties.** 2,000 random invoices per property across MYR, JPY, KWD and EUR, both rounding granularities, four modes each for amounts and tax, with lines returned in full. Results satisfy BR-CO-10..16, the per-category taxable amounts and the policy's tax rounding; every figure carries the currency's decimals; tax-inclusive invoices charge exactly the shelf price; allocation never gains or loses a unit; recomputation is byte-identical.
- **Mutations.** `node scripts/mutate.mjs` in `packages/core` plants known bugs one at a time (tax a unit high, allocation dropping its residual, a sale and its return zeroing out, overpayment accepted, a refused issue keeping its number, reversed payments still counted, a retried payment applied twice, and others) and requires the suite to fail on each.
- **Golden outputs.** The output of every published policy is pinned in `test/golden`.
- **Independent reviews.** Two adversarial reviews by another model found real defects: a sale and its return zeroing out, a credit that could be reversed while its note stood, credit notes created around their invoice, retried payments refused, dates that crashed, and numbers unique only per series. Each is fixed and has a test.
- **Speed.** One run on an Apple M4 with Node 24: `compute` takes a median 0.8 ms for 1,000 lines and 8.9 ms for 10,000, about 0.9 µs per line. Nothing guards this number.

## Decisions

- **Own decimal type over decimal.js or Dinero.js.** The core needs about ten operations, and its public types should not belong to another library. The type is 150 lines on bigint, and no amount ever becomes a float.
- **Library first.** A self-hostable server can come later as a thin wrapper, as GOBL's API service wraps GOBL.
- **No runtime dependencies, no framework.** Plain functions and plain objects. An Effect or Zod wrapper can be an adapter package.
- **Erasable TypeScript only.** Node runs the source directly, with no build step to read or debug through.
- **Apache-2.0.** It includes a patent grant, is acceptable to enterprises, and is used by Kill Bill, Polar and GOBL. AGPL suits a hosted product, not a library people embed.

## Known gaps

- `verify` cannot check tax per category under line rounding or `"extract"` pricing; a passing `verify` there means consistent, not EN 16931 arithmetic.
- No pack writes `rules` yet; the seam runs them at issue, but MyInvois's required fields (TIN, MSIC, classification codes) are not modelled.
- A document's settlements and deliveries live inside its state. A document with thousands of payments would outgrow a Convex row (1 MB).
- The Japanese pack reads 切り捨て as truncation toward zero, and the Malaysian pack assumes half away from zero. Neither is sourced.

## Not built yet, in rough order

1. **Listing.** `list({ status, kind, buyer, dueBefore }, cursor)` on `Books`, so apps do not build a shadow index; with a buyer key on the draft to make it indexable.
2. **Payments across invoices.** One receipt settling several invoices in one transaction, with a check that the allocations sum to the receipt.
3. **Richer numbering.** Fiscal years, branches and separate series per document type (self-billed), with the series chosen per document from a tenant's allowed list.
4. **Undoing a credit note, and refunds.** Today a credit is final and a credit larger than what is owed is refused.
5. The country seam decision above.
6. A UBL codec for Peppol BIS 3 and PINT-MY, with the official Schematron in the test suite; then MyInvois (signing, submission, the 72-hour cancel window).
7. Tax currency totals (BT-6, BT-111), price-level discounts, withholding taxes, inclusive prices with several taxes per line.
8. A tax determination layer.

## How Cynco adopts it

Cynco stamps every document with `calcVersion`. The library becomes calc version 5: new documents compute through it, old ones keep v1 to v4 forever. Run v5 in shadow first, computing both on every new invoice and logging differences, then switch the stamp.
