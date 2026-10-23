# Design

Working name: `invoice-primitives`. Status: prototype of the calculation core, with three country packs. Everything here is open to change before 0.1.

## What it is for

A developer building anything that issues or receives invoices needs the same few hard things: amounts that never drift, tax that rounds the way a tax authority expects, a document that cannot change after it is issued, and output a validator accepts. Today a TypeScript developer gets serializers that expect the totals to be computed already, or a full billing product to adopt wholesale. Correct calculation engines exist in Java (Mustang) and Go (GOBL), but not in TypeScript.

This library is the missing core: small pure functions, one per concern, that any app, ERP, POS or agent can call. A country is a pack of data plugged into the core, not a branch inside it.

## Laws

These hold for every module. A change that breaks one needs a design discussion, not a review comment.

1. **Exact or explicit.** Amounts are bigint decimals. Addition, subtraction and multiplication are exact. Only `round` and `div` lose information, and both require a rounding mode, so every rounding point is visible in the code. Numbers are refused at the boundary: `dec(0.1)` fails to typecheck and throws at runtime, and amounts travel as strings.
2. **A policy is data with an id, and results carry it.** An issued document recomputes identically for as long as its policy id exists. Behaviour changes by publishing a new id, never by editing one. This is Cynco's `calcVersion`, made public.
3. **Refuse rather than guess.** An input the core does not handle throws `UnsupportedError` with the reason. It never produces a plausible wrong figure.
4. **Traceable to a written rule.** Every field names its EN 16931 business term (BT-x). Every check names its rule (BR-CO-x) and every pack rule names its source URL.
5. **Pure core, I/O at the edges.** `compute`, `verify` and `issue` are synchronous and allocate no ids. Numbering, clocks, storage and networks belong to the caller or an adapter.
6. **The country is a pack.** No `if (country === "MY")` in the core.

## Layers

| Layer | Module | State |
| --- | --- | --- |
| Exact decimal | `decimal.ts`, `allocate.ts` | Built |
| ISO 4217 minor units | `currencies.ts`, generated from the SIX list | Built |
| Calculation (BT-106..117, BT-131) | `compute.ts` | Built |
| Calculation rules as checks | `verify.ts` | Built |
| Lifecycle: draft, issued, void, notes | `lifecycle.ts` | Built (minimal) |
| Country pack seam | `pack.ts`, `packs/{eu,my,jp}.ts` | Built (minimal) |
| Full document: parties, dates, references | `model.ts` | Not built |
| Codecs: UBL 2.1 (Peppol, PINT, MyInvois), CII | `ubl/`, `cii/` | Not built |
| Transport: MyInvois API, Peppol access points | separate packages | Not built |
| Settlement: payments, credits, ageing | `settlement.ts` | Not built |
| Tax determination: which tax applies | separate layer | Not built |

The calculation was built first because it is the part every other layer depends on. It is also the part where being wrong is invisible until an auditor or a validator finds it.

## The country seam

What varies between countries, found while building the three packs:

| Varies | Example | Where it lives |
| --- | --- | --- |
| Where tax is rounded | EN 16931, PINT and Japan: once per category per document. Some systems: per line. | `Policy.taxRounding` |
| How tax is rounded | EN 16931:2026: half away from zero. Japan: the business chooses, often down. | `Policy.mode` |
| Whether prices include tax | Japan and most retail: tax extracted from the shelf price. EN 16931: net prices. | `Policy.pricesIncludeTax` |
| Cash rounding of the amount due | Malaysia: nearest 5 sen, recorded in BT-114. | `Policy.cashIncrement` |
| Taxes that are not a rate | Malaysian tourism tax: a fixed amount per room per night. | `TaxInput.perUnit` |
| Tax on tax | Some provincial and excise taxes. | `TaxInput.compound` (line rounding only) |
| Tax categories | UNCL5305 in the EU. PINT MY: SA, SE, HVG, LVG, TTX, E, O. | `CountryPack.taxCategories` |
| Whether an issued document can be voided | MyInvois: within 72 hours of validation. EN 16931: never, issue a credit note. | `CountryPack.canVoid` |
| Required fields and local rules | MSIC code, TIN formats, self-billing rules. | `CountryPack.rules` |
| Wire format | Peppol BIS, PINT-MY, MyInvois UBL, CII, Factur-X. | codecs (not built) |

### Inclusive prices are a real choice, not a detail

For ¥1,099 tax-inclusive at 10%, Japanese practice extracts tax as floor(1,099 × 10 ÷ 110) = ¥99, leaving ¥1,000 taxable. EN 16931 rule BR-CO-17 requires tax = round(taxable × 10%), and ¥1,000 gives ¥100. No whole-yen taxable amount satisfies both: ¥999 gives 999 + 99 = 1,098, and ¥1,000 gives 1,100. So the policy names its choice:

- `"extract"` follows the shelf-price method. BR-CO-17 can be one unit off.
- `"reconcile"` picks the taxable amount that satisfies BR-CO-17 and records any residual in BT-114 (the rounding amount). The amount due is still the shelf price.

`test/scenarios.test.ts` covers both, and the property tests check that both always charge exactly the shelf price.

### Calculation is not determination

The core calculates tax from the taxes a line carries. Deciding which taxes a line carries is determination: place of supply, reverse charge, product taxability, registration thresholds, dated rate changes. That knowledge is large, per country, and changes often. It will be a separate layer, so the calculation core stays small enough to read in one sitting.

## Data model

The model follows the EN 16931 semantic model. It is the only internationally agreed invoice model. Peppol BIS 3 and PINT (the international Peppol model, specialised per country, for example Malaysia's PINT-MY) are built on it, and MyInvois uses the same UBL syntax. Names are plain English (`lineNet`, `taxExclusive`) with the BT number beside each field, so a reader can check the norm without learning UBL tag names.

The core departs from EN 16931 in one place. A line may carry several taxes, because per-unit and compound taxes exist outside the EU. An EN 16931 codec will refuse a line with more than one.

## Evidence

- **Official examples.** `pnpm corpus` fetches the 19 CEN TC 434 UBL examples and the 9 Peppol BIS 3 examples. They are fetched, not committed: the CEN files are EUPL-1.2 and the Peppol repository declares no license. All 28 match every stated total and tax subtotal when recomputed from their line amounts. Recomputed from quantity and price, 21 match. The other 7 state line amounts that are not quantity × price (for example 2 × 800.00 stated as 400.00), which Peppol rule R120 forbids. The test checks that each mismatch is one of these.
- **Properties.** 2,000 random invoices per property across MYR, JPY, KWD and EUR, both rounding granularities, four rounding modes, line and document allowances. Every result satisfies BR-CO-10..17 and the per-category taxable amounts. Every figure carries exactly the currency's decimals. Tax-inclusive invoices charge exactly the shelf price. Allocation never gains or loses a unit, and recomputation is byte-identical.
- **Mutations.** Two deliberately planted bugs (document tax rounded per line, and allocation dropping its residual) each fail several tests.
- **Speed.** Measured on an Apple M4 with Node 24: median 0.04 ms for 10 lines, 0.8 ms for 1,000 lines, and 8.9 ms for 10,000 lines. That is linear, about 0.9 µs per line.

## Decisions

- **Own decimal type over decimal.js or Dinero.js.** The core needs about ten operations, and its public types should not belong to another library. The type is 150 lines on bigint, and no amount ever becomes a float.
- **Library first.** A self-hostable server can come later as a thin wrapper, as GOBL's API service wraps GOBL.
- **No runtime dependencies, no framework.** Plain functions and plain objects. An Effect or Zod wrapper can be an adapter package.
- **Erasable TypeScript only.** Node runs the source directly, with no build step to read or debug through.
- **Apache-2.0.** It includes a patent grant, is acceptable to enterprises, and is used by Kill Bill, Polar and GOBL. AGPL suits a hosted product, not a library people embed.

## Not built yet, in rough order

1. The full document: parties, dates, references, payment terms, document types (380, 381, 383, 389 self-billed).
2. A UBL codec for Peppol BIS 3 and PINT-MY. The official Schematron goes into the test suite.
3. A MyInvois codec and client: signing, submission, polling, the 72-hour cancel window.
4. Tax currency totals (BT-6, BT-111) for foreign-currency invoices.
5. Settlement: payments and credit notes applied to an invoice, outstanding amount, ageing. All derived, never stored as a status.
6. Price-level discounts (BT-147, BT-148), withholding taxes, and inclusive prices with several taxes per line.
7. A tax determination layer.

## How Cynco adopts it

Cynco stamps every document with `calcVersion`. The library becomes calc version 5: new documents compute through it, old ones keep v1 to v4 forever. Run v5 in shadow first, computing both on every new invoice and logging differences, then switch the stamp.
