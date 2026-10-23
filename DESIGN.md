# Design

Working name: `invoice-primitives`. Status: prototype of the calculation core, with three country packs. Everything here is open to change before 0.1.

## What it is for

A developer building anything that issues or receives invoices needs the same few hard things: amounts that never drift, tax that rounds the way a tax authority expects, a document that cannot change after it is issued, and output a validator accepts. Today a TypeScript developer gets serializers that expect the totals to be computed already, or a full billing product to adopt wholesale. Correct calculation engines exist in Java (Mustang) and Go (GOBL), but not in TypeScript.

This library is the missing core: small pure functions, one per concern, that any app, ERP, POS or agent can call.

## Laws

These hold for every module. A change that breaks one needs a design discussion, not a review comment.

1. **Exact or explicit.** Amounts are bigint decimals. Addition, subtraction and multiplication are exact. Only `round` and `div` lose information, and both require a rounding mode, so every rounding point is visible in the code. A number passed as an amount fails to typecheck and throws at runtime; amounts travel as strings.
2. **A policy is data with an id, and results carry it.** A result records its policy, the core version and the scale it was computed at. `test/golden` pins the output of every published policy, so a change in behaviour fails CI and needs a new policy id. This is Cynco's `calcVersion`, made public.
3. **Refuse rather than guess.** An input the core does not handle throws `InvoiceError` with a stable `code` and a `path` into the input. It never returns a plausible wrong figure. An independent review found one place where it did (below), and a mutation test now guards it.
4. **Traceable to a written rule.** Every field names its EN 16931 business term (BT-x). A check carries an EN 16931 rule id only when it is that rule; checks that follow the policy instead are named for the policy.
5. **Pure core, I/O at the edges.** `compute`, `verify` and `issue` are synchronous, allocate no ids, and never mutate or freeze what the caller passed in.
6. **The country is data, not a branch.** No `if (country === "MY")` in the core. See "The country seam" for how far this holds today.

## Layers

| Layer | Module | State |
| --- | --- | --- |
| Exact decimal | `decimal.ts`, `allocate.ts` | Built |
| ISO 4217 minor units | `currencies.ts`, generated from the SIX list | Built |
| Calculation (BT-106..117, BT-131) | `compute.ts` | Built |
| Calculation rules as checks | `verify.ts` | Built |
| Errors with codes and paths | `errors.ts` | Built |
| Lifecycle: draft, issued, void, notes | `lifecycle.ts` | Built (minimal) |
| Country packs | `pack.ts`, `packs/{eu,my,jp}.ts` | Policies and void rules only |
| Full document: parties, dates, references | `model.ts` | Not built |
| Codecs: UBL 2.1 (Peppol, PINT, MyInvois), CII | `ubl/`, `cii/` | Not built |
| Transport: MyInvois API, Peppol access points | separate packages | Not built |
| Settlement: payments, credits, ageing | `settlement.ts` | Not built |
| Tax determination: which tax applies | separate layer | Not built |

The calculation was built first because every other layer depends on it. It is also the part where being wrong is invisible until an auditor or a validator finds it.

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

Each item below is reproducible from the repository.

- **Official examples** (`pnpm corpus`, then `pnpm test`). The corpus is 19 CEN TC 434 UBL examples and 9 Peppol BIS 3 examples. They are fetched, not committed: the CEN files are EUPL-1.2 and the Peppol repository declares no license.
  - Given each file's stated line amounts, all 28 match every stated total and tax subtotal.
  - Recomputed from quantity and price, 21 match. The other 7 state line amounts that are not quantity × price (for example 2 × 800.00 stated as 400.00), which Peppol rule R120 forbids. The test checks independently that each mismatch is one of these.
- **Properties** (`test/properties.test.ts`). 2,000 random invoices per property across MYR, JPY, KWD and EUR, including lines returned in full so tax groups can net to zero. Inputs cover both rounding granularities, four modes each for amounts and tax, and line and document allowances.
  - Tax-exclusive results satisfy BR-CO-10..16, the per-category taxable amounts, and the policy's tax rounding.
  - Every figure carries exactly the currency's decimals.
  - Tax-inclusive results charge exactly the shelf price, and no line net takes the opposite sign of its shelf amount.
  - Allocation never gains or loses a unit, and recomputation is byte-identical.
  - The inclusive properties exclude document-level adjustments, which inclusive pricing does not support yet.
- **Mutations** (`node scripts/mutate.mjs`). Six known bugs are planted one at a time, and the suite must fail on each. That includes the zero-sum bug the independent review found, which the first version of the property tests could not see.
- **Golden outputs** (`test/golden/*.json`). The output of every published policy is pinned.
- **Speed** (`node scripts/bench.ts`). One run on an Apple M4 with Node 24 gave a median of 0.04 ms for 10 lines, 0.8 ms for 1,000 lines and 8.9 ms for 10,000 lines. That is linear, about 0.9 µs per line. Nothing guards this number.

## Decisions

- **Own decimal type over decimal.js or Dinero.js.** The core needs about ten operations, and its public types should not belong to another library. The type is 150 lines on bigint, and no amount ever becomes a float.
- **Library first.** A self-hostable server can come later as a thin wrapper, as GOBL's API service wraps GOBL.
- **No runtime dependencies, no framework.** Plain functions and plain objects. An Effect or Zod wrapper can be an adapter package.
- **Erasable TypeScript only.** Node runs the source directly, with no build step to read or debug through.
- **Apache-2.0.** It includes a patent grant, is acceptable to enterprises, and is used by Kill Bill, Polar and GOBL. AGPL suits a hosted product, not a library people embed.

## Known gaps

- `issue` does not yet run a pack's rules or check its tax categories. A line under an EN 16931 policy can carry no tax (BR-CO-04), or carry a category the pack does not know.
- Under line rounding or `"extract"` pricing, `verify` checks totals and taxable amounts but cannot check tax per category. A passing `verify` there means consistent, not EN 16931 arithmetic.
- The Japanese pack reads 切り捨て as truncation toward zero, and the Malaysian pack assumes half away from zero. Neither assumption is sourced.

## Not built yet, in rough order

1. The country seam decision above.
2. The full document: parties, dates, references, payment terms, document types (380, 381, 383, 389 self-billed). `issue` runs pack rules.
3. A UBL codec for Peppol BIS 3 and PINT-MY. The official Schematron goes into the test suite.
4. A MyInvois codec and client: signing, submission, polling, the 72-hour cancel window.
5. Tax currency totals (BT-6, BT-111) for foreign-currency invoices.
6. Settlement: payments and credit notes applied to an invoice, outstanding amount, ageing. All derived, never stored as a status.
7. Price-level discounts (BT-147, BT-148), withholding taxes, inclusive prices with several taxes per line, and document-level adjustments under inclusive prices.
8. A tax determination layer.

## How Cynco adopts it

Cynco stamps every document with `calcVersion`. The library becomes calc version 5: new documents compute through it, old ones keep v1 to v4 forever. Run v5 in shadow first, computing both on every new invoice and logging differences, then switch the stamp.
