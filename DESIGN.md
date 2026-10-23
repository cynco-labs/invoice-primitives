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
5. **Pure core, I/O at the edges.** `compute`, `verify`, `decide`, `evolve` and `creditInvoice` are synchronous, allocate no ids, and never mutate what the caller passed in. A backend is a `Store`: rows in, rows out, and no rules.
6. **The country is data, not a branch.** No `if (country === "MY")` in the core. A country pack is JSON, so any backend, and any language, can take one.
7. **One definition per shape.** Every JSON shape is defined once, in `core/src/schema/shapes.ts`. Its TypeScript type, its runtime check, its JSON Schema and its Convex validator all come from that definition, so they cannot disagree.

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
| Shapes: types, `parse`, JSON Schema and Convex validators from one definition | `core/src/schema/` | Built |
| `Books` on a `Store`: every command, once, for every backend | `core/src/books.ts`, `core/src/store.ts` | Built |
| Conformance suite and language-neutral test vectors | `core/src/testing/`, `core/vectors/` | Built |
| Stores | `core/src/memory.ts`, `packages/convex`, `packages/cloudflare` | Built |
| Country packs, as data: policies, categories, named taxes, rules, voiding | `core/src/packs/` | Built; no bundled pack writes rules yet |
| Listing by kind, status and customer, newest first | `core/src/document/listing.ts`, each backend | Built |
| Codecs: UBL 2.1 (Peppol, PINT-MY, MyInvois), CII | `packages/ubl`, ... | Not built |
| Transport: MyInvois API, Peppol access points | separate packages | Not built |
| Tax determination: which tax applies | separate layer | Not built |

## Architecture

```
your app ──▶ Books (createBooks, in core)
                 │  store.transaction:
                 │    parse input → load → take a number if issuing → execute
                 │    → check number, size → write state, listing, events
                 ▼
             Store (memory │ Convex tables │ Durable Object SQLite): rows in, rows out
```

- **Core owns the command; a backend owns rows.** `createBooks(store, { packs })` is the only place a command runs: it parses the input, opens the store's transaction, loads, takes a number, runs the state machine, refuses a duplicate number or an oversized document, and writes the state, its listing and its events. A `Store` (`core/src/store.ts`) offers a transaction and a dozen row operations, and holds no rules. The memory store is under 100 lines; the Convex and Durable Object stores are their table layouts plus those operations. A new backend implements `Store` and runs `booksConformance`.
- **The state machine is two pure functions.** `decide(state, command, context)` returns events or throws an `InvoiceError`. `evolve(state, event)` returns the next state.
- **State is stored, events are appended.** Each document's current state is saved beside the events that produced it, in the same transaction. Reads are one row; the log is the audit trail, the integration feed, and the proof: replaying it must rebuild every document exactly, and the conformance suite checks that on every backend.
- **Idempotency comes from caller ids, not a key table.** A document id, a settlement id, a delivery id and a credit note id are chosen by the caller. Repeating a command with the same id and the same values returns no events. Repeating it with different values is refused with `duplicate-id` or `already-exists`.
- **Numbers come from the backend, inside the transaction.** `numberingFor(data, context)` names the series; the backend takes its next value and passes the number into `issue`. A refused issue rolls back and draws nothing, so numbers have no gaps. Each backend also refuses a number already held by another document in the tenant (`duplicate-number`), so a change of numbering settings cannot mint a duplicate.
- **Balance is never stored.** "Paid", "partly paid" and "overdue" are computed from the settlements and a date each time, so they cannot drift.
- **A list reads an index, not the documents.** On every save a backend copies `listingOf(state)` (kind, stage, customer, due date) beside the state, with `seq`, the log position of the document's first event. The stage is derived from the state in the same transaction, counting every recorded settlement whatever its date, so it cannot drift from the settlements. "Overdue" is never stored, only compared: `listFilter` turns it into "open and due before `asOf`", which defaults to today in the seller's time zone. `asOf` with any other status is refused, because a stored stage cannot honour a date. `conditions(filter)` states the comparisons as data, so the SQLite backend builds its query from them, and the others call `listed`, which evaluates the same list. Unless asked for, discarded drafts are left out. The list is newest first by `seq`, the cursor is a `seq`, and a document's place in the order never changes, so paging never repeats one. Convex keeps the listing in its own small table, reads the narrowest index the filter allows, filters the rest through core's `collect` and loads only the documents it returns; it reads at most 2,000 listings a page, so its pages can be short. The memory backend stores its listings the same way and pages through `collect`; SQLite fills every page.
- **A credit note exists only applied.** `create` refuses a credit note. `creditInvoice` creates, issues and applies one in a single transaction, and a credit settlement cannot be reversed on its own. Undoing a credit note is not built, so the pair stays consistent by refusal.
- **Configure once, then a buyer and lines.** A tenant's settings (country, seller, currency, time zone, numbering) live in the backend. `expand` fills a short document from them, and turns named taxes (`tax: "service-8"`) into categories and rates from the country pack, each with its source and the date it was checked. The event records the full draft, so a later settings change never rewrites a document. Malformed JSON from an untyped caller is refused with a path and a hint, not a `TypeError`.
- **One `Books` object on every backend.** `createMemoryBooks()`, `invoicing.books(ctx, tenant)` on Convex and `booksFor(env.INVOICING, tenant)` on Cloudflare return the same interface, so application code moves between them by changing one line. Each takes `packs`: the country packs, as data, sent with each call, so a jurisdiction no one ships works on every backend.
- **Every backend passes the same suite.** `booksConformance(name, makeBooks)` drives a backend only through `Books`: numbering under concurrency, refused commands leaving no trace, idempotent retries, credits, settings, listing and paging, a pack passed as data, the size limit, rebuilding listings, tenant isolation, and event replay.
- **A store can declare a read budget.** `Store.maxDocuments` cuts a page of `list`, `events` or `rebuildListings` to that many documents or events, and the page continues from its cursor. Convex declares 16: at 512 KiB each, that stays within a function's read budget whatever the documents weigh. So `events` can return fewer than `limit`; a consumer continues from the last position until a page is empty.
- **What was checked is what is stored.** `parse` returns a fresh copy holding only the shape's fields, so a caller changing its object later, or a getter returning something else, changes nothing stored, on every backend. The memory store copies on the way in and out as a serialising backend does, and undoes a refused transaction from a journal, so a command costs the same however large the tenant.
- **One refusal on every backend.** `Books` refuses with `InvoiceError` everywhere. Across a boundary that carries no classes the refusal travels as data (`error.toJSON()`, rebuilt with `InvoiceError.from`): a Convex function throws it as `ConvexError` data and the client's `books()` rethrows it; a Durable Object returns it in an `Outcome` and `booksFor` rethrows it. The Convex client checks arguments against core's shapes before calling the component, so malformed input is refused with a code and a path there too.
- **Every document fits every backend.** A state over `MAX_DOCUMENT_BYTES` (512 KiB of JSON) is refused with `too-large`, whichever backend runs it. That keeps a document, its settlements included, inside Convex's 1 MiB row and SQLite's 2 MB row, so a document one backend accepts, all accept.
- **Stored events carry a format.** Each event records `format` (`EVENT_FORMAT`, 1 today). `replay` rebuilds documents from a log and refuses a format newer than it reads, so an old reader never misreads new events. Listings are derived, so `rebuildListings` rewrites them from the documents, a page at a time, after an upgrade that changes them; on Convex it also lists a document written before listings existed, at its first event's position.

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
| Tax categories | UNCL5305 in the EU. PINT MY: SA, SE, HVG, LVG, TTX, E, O. | `CountryPack.taxCategories`, enforced at issue |
| Whether an issued document can be voided | MyInvois: within 72 hours of validation. EN 16931: never, issue a credit note. | `CountryPack.voiding`: `true`, `false` with a reason, or `"within"` hours after validation |
| Required fields and local rules | MSIC code, TIN formats, self-billing rules. | `CountryPack.rules`: `require`, `match` (a pattern) or `oneOf` at a path such as `data.buyer.ids[scheme=TIN].value`. None written in the bundled packs. |
| Wire format | Peppol BIS, PINT-MY, MyInvois UBL, CII, Factur-X. | codecs (not built) |

### Decided: a pack is data, and arithmetic is core's named vocabulary

A pack is JSON: policies, categories, named taxes, rules and voiding, checked against `shapes.CountryPack` when it is registered. That is what lets a pack cross a Convex argument, a Durable Object RPC call, a database row or a language boundary. A pack holding functions could do none of these.

So arithmetic a country needs is not code in its pack. It is a named value in the `Policy` shape (`taxRounding: "document" | "line"`, `pricesIncludeTax`, `cashIncrement`), implemented once in `compute`, held to the property suite and the golden outputs, and selected by a pack as data. A country that needs new arithmetic adds a value to that vocabulary in core, with a new policy id. sqlc makes the same trade: engines are vetted code behind a data protocol, and contributions extend the protocol, not the runtime.

The new values still have to be designed from their sources. The independent review named three cases, which I have not yet checked:

- **India.** The reviewer cites CGST s.170 for rounding the tax total to the whole rupee across categories. That would be a third tax-rounding point.
- **Brazil.** ICMS "por dentro" taxes a base that includes the tax itself: base = price ÷ (1 − rate).
- **US sales tax.** Stacked jurisdictions often round the combined rate once and then split it. Withholding taxes, which reduce the amount due but not BT-112, also have no slot today.

Each becomes a value in the vocabulary, not a hook: India a third `taxRounding` point, Brazil a `taxBase`, US stacking a combined-rate rounding, withholding a new total. None is added until it is designed from its source.

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

### One definition per shape

`core/src/schema/dsl.ts` is a small schema language (strings, decimals, dates, numbers, literals, lists, records, objects, unions) and `shapes.ts` defines every boundary shape in it, with the BT numbers in its comments. From those definitions:

- **TypeScript types** are inferred (`Infer<typeof shapes.DraftData>`). A test proved them identical to the hand-written types they replaced.
- **`parse(shape, value)`** checks untyped input and refuses with a code and a path: an unknown field, a number where a decimal string belongs (`invalid-amount`, "pass 10 as a string"), a bad date (`invalid-date`), a missing field (`missing-field`). `createBooks` parses every argument it is given.
- **JSON Schema** (`schema/invoice-primitives.schema.json`, `@invoice-primitives/core/schema.json`) for callers in other languages. A test validates every state, event, page and pack the core produces against it with Ajv, and checks that it refuses what `parse` refuses.
- **Convex validators** (`packages/convex/src/component/shapes.generated.ts`) for the component's tables, arguments and return values.

`pnpm gen` writes the generated files, and tests fail when one is stale.

## Evidence

Each item is reproducible from the repository (`pnpm -r test` from the root).

- **Backends.** The 29-scenario conformance suite passes on memory, on Convex (through the component, with `convex-test`) and on Cloudflare (inside `workerd`, through Durable Object RPC). Convex and Cloudflare add their own tests for tenants, the component boundary, and data written by earlier versions: a Durable Object whose tables predate listings and event formats migrates when it starts, and a Convex document without a listing is listed by `rebuildListings`.
- **Test vectors.** `vectors/calculation.json` (12 invoices across the bundled policies, line rounding, a reconciled inclusive price, cash rounding, per-unit tax, three-decimal currency, and two refusals) and `vectors/documents.json` (command sequences with the events or refusal each produces) are pinned by a test that replays them from their JSON alone. Another implementation can run the same files.
- **Official examples.** 19 CEN TC 434 UBL examples and 9 Peppol BIS 3 examples, fetched by `pnpm corpus` in `packages/core` (EUPL-1.2 and unlicensed, so not committed). Given each file's stated line amounts, all 28 match every stated total and tax subtotal. From quantity and price, 21 match; the other 7 state line amounts that are not quantity × price, which Peppol rule R120 forbids, and the test checks that independently.
- **Properties.** 2,000 random invoices per property across MYR, JPY, KWD and EUR, both rounding granularities, four modes each for amounts and tax, with lines returned in full. Results satisfy BR-CO-10..16, the per-category taxable amounts and the policy's tax rounding; every figure carries the currency's decimals; tax-inclusive invoices charge exactly the shelf price; allocation never gains or loses a unit; recomputation is byte-identical.
- **Mutations.** `node scripts/mutate.mjs` in `packages/core` plants 33 known bugs one at a time (tax a unit high, allocation dropping its residual, a sale and its return zeroing out, overpayment accepted, a refused issue keeping its number, a duplicate number issued, an oversized document accepted, a pack rule that never fails, `require` counting a blank, an unreadable rule path accepted, a passed void window, `parse` accepting unknown fields, numbers or padded decimals for amounts, a listing not rewritten, a rebuild that does nothing, a refused command keeping its events, the memory store sharing objects with callers, a retried credit with other values accepted, and others) and requires the suite to fail on each.
- **Golden outputs.** The output of every published policy is pinned in `test/golden`.
- **Independent reviews.** Four adversarial reviews found real defects. The two on the store-port redesign found, among others: a Convex schema that could not be deployed over existing events, a Cloudflare default list that read the whole tenant (measured: 72 rows for a 3-row page, under 20 after), Convex pages that could exceed a function's read budget, union refusals naming the wrong field, rule paths that silently matched nothing, `require` counting blanks, the memory store sharing objects with callers, and a rollback after a partial save that no test covered. Each is fixed and has a test or a planted bug. The earlier two found: a sale and its return zeroing out, a credit that could be reversed while its note stood, credit notes created around their invoice, retried payments refused, dates that crashed, and numbers unique only per series. Each is fixed and has a test.
- **A fresh-developer trial.** An agent that had never seen the code integrated it from the READMEs alone, into a Node script and a Cloudflare Worker with tests. Both worked. Its friction log drove the compiled build, credit notes taking short lines, the boundary checks, the error messages and the Cloudflare README.
- **Packed and installed.** `pnpm pack` tarballs installed into an empty project outside the repository; the quick start runs under plain `node`, and core's declarations typecheck in a consumer. After the redesign the consumer also imported `core/backend`, `core/packs/my`, `core/schema` and `core/schema.json`, issued an invoice under a pack passed as JSON, and ran `createBooks` on `memoryStore`.
- **Speed.** One run on an Apple M4 with Node 24: `compute` takes a median 0.8 ms for 1,000 lines and 8.9 ms for 10,000, about 0.9 µs per line. Nothing guards this number.

## Decisions

- **Own decimal type over decimal.js or Dinero.js.** The core needs about ten operations, and its public types should not belong to another library. The type is 150 lines on bigint, and no amount ever becomes a float.
- **Library first.** A self-hostable server can come later as a thin wrapper, as GOBL's API service wraps GOBL.
- **No runtime dependencies, no framework.** Plain functions and plain objects. An Effect or Zod wrapper can be an adapter package.
- **Own schema language over Zod or Valibot.** The shapes are plain JSON, so about 250 lines cover them. Owning it keeps the core dependency-free and lets one definition generate JSON Schema and Convex validators, which a general library would need adapters for.
- **Packs travel with each call, not in storage.** `createMemoryBooks({ packs })`, `new Invoicing(component, { packs })` and `booksFor(env.INVOICING, tenant, { packs })` send the app's packs with every command. The backend stays stateless about jurisdictions, and a pack update is a deploy of the app, with a new policy id when figures change.
- **Three entry points.** `@invoice-primitives/core` for applications, `@invoice-primitives/core/backend` for backend authors (`createBooks`, `Store`, the state machine), `@invoice-primitives/core/schema` for shapes and generators, and `@invoice-primitives/core/packs/<country>` for one country.
- **Erasable TypeScript in the repository, compiled JavaScript on npm.** Inside the workspace, packages point at their source and Node runs it directly. `publishConfig` switches the published entry points to `dist/` (JavaScript plus declarations), because Node refuses to strip types inside `node_modules`.
- **Apache-2.0.** It includes a patent grant, is acceptable to enterprises, and is used by Kill Bill, Polar and GOBL. AGPL suits a hosted product, not a library people embed.

## Known gaps

- `verify` cannot check tax per category under line rounding or `"extract"` pricing; a passing `verify` there means consistent, not EN 16931 arithmetic.
- No bundled pack writes `rules` yet; MyInvois's required fields (TIN, MSIC, classification codes) are not modelled.
- A document's settlements, deliveries and lines live inside its state, so `MAX_DOCUMENT_BYTES` bounds them: at about 160 bytes a typical line and 100 a settlement, roughly 3,000 lines or 5,000 settlements. A larger document is refused, not stored elsewhere.
- `CountryPack.voiding` can limit voiding to hours after a clearance authority validated the document, but nothing records validation yet, so `"within"` always allows it (MyInvois submission is not built).
- A Durable Object migrates its tables in its constructor. A document it cannot migrate (no events, unreadable state) stops the object starting, with an error naming the document; nothing in data written by earlier versions can cause it today.
- Inferred types are not `readonly` on object fields (`Policy`, `CountryPack`), where the hand-written ones were. Arrays still are.
- Every write in a tenant reads the log head, so a tenant's write rate is bounded (see "The tenant log is gapless"). A tenant issuing thousands of documents a second would need the log partitioned by series.
- The Japanese pack reads 切り捨て as truncation toward zero, and the Malaysian pack assumes half away from zero. Neither is sourced.

## Not built yet, in rough order

1. **Payments across invoices.** One receipt settling several invoices in one transaction, with a check that the allocations sum to the receipt.
2. **Richer numbering.** Fiscal years, branches and separate series per document type (self-billed), with the series chosen per document from a tenant's allowed list.
3. **Undoing a credit note, and refunds.** Today a credit is final and a credit larger than what is owed is refused.
4. A UBL codec for Peppol BIS 3 and PINT-MY, with the official Schematron in the test suite; then MyInvois (signing, submission, the 72-hour cancel window).
5. Tax currency totals (BT-6, BT-111), price-level discounts, withholding taxes, inclusive prices with several taxes per line.
6. A tax determination layer.

## How Cynco adopts it

Cynco stamps every document with `calcVersion`. The library becomes calc version 5: new documents compute through it, old ones keep v1 to v4 forever. Run v5 in shadow first, computing both on every new invoice and logging differences, then switch the stamp.
