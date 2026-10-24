// Plants known bugs one at a time and requires the test suite to fail on each.
// Usage: node scripts/mutate.mjs   (exits non-zero if any mutant survives)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const MUTANTS = [
    {
        name: "document-level tax one minor unit high",
        file: "src/calc/compute.ts",
        from: `else if (spec.rate !== undefined) t = taxOf(taxable, dec(spec.rate));`,
        to: `else if (spec.rate !== undefined) t = taxOf(taxable, dec(spec.rate)).add(dec("0.01"));`,
    },
    {
        name: "allocation drops its residual",
        file: "src/money/allocate.ts",
        from: `if (residual === 0n) return parts;`,
        to: `return parts;`,
    },
    {
        name: "inclusive nets allocated by signed weight (a sale and its return zero out)",
        file: "src/calc/compute.ts",
        from: `const nets = inclusive.map((x) => x.sub(extract(x)));
            const moved = allocate(g.taxable.sub(Decimal.sum(nets)), inclusive.map((x) => x.abs()), scale);
            members.forEach((line, k) => (line.net = nets[k]!.add(moved[k]!)));`,
        to: `const nets = allocate(g.taxable, inclusive, scale);
            members.forEach((line, k) => (line.net = nets[k]!));`,
    },
    {
        name: "stated BT-114 silently drops the reconciled residual",
        file: "src/calc/compute.ts",
        from: `if (!residual.isZero()) {`,
        to: `if (false) {`,
    },
    {
        name: "overpayment accepted",
        file: "src/document/execute.ts",
        from: `if (amount.cmp(outstanding) > 0) {`,
        to: `if (false) {`,
    },
    {
        name: "a refused issue keeps the number it drew",
        file: "src/memory.ts",
        from: `put(sequences, series, n);`,
        to: `sequences.set(series, n);`,
    },
    {
        name: "reversed settlements still count as paid",
        file: "src/document/balance.ts",
        from: `doc.settlements.filter((s) => !s.reversed && `,
        to: `doc.settlements.filter((s) => true && `,
    },
    {
        name: "a retried payment is applied twice",
        file: "src/document/execute.ts",
        from: `const existing = doc.settlements.find((x) => x.id === s.id);`,
        to: `const existing = undefined as Settlement | undefined;`,
    },
    {
        name: "a credit can be reversed while its note stands",
        file: "src/document/execute.ts",
        from: `if (s.kind === "credit") {`,
        to: `if (false) {`,
    },
    {
        name: "a credit note can be created around its invoice",
        file: "src/document/execute.ts",
        from: `if (command.data.kind === "credit-note") {`,
        to: `if (false) {`,
    },
    {
        name: "a retried payment is compared before its amount is normalised",
        file: "src/document/execute.ts",
        from: `canonical({ ...existing, reversed: undefined }) === canonical(settlement)`,
        to: `canonical({ ...existing, reversed: undefined }) === canonical(s)`,
    },
    {
        name: "a balance counts payments dated after it",
        file: "src/document/balance.ts",
        from: `(asOf === undefined || s.date <= asOf)`,
        to: `true`,
    },
    {
        name: "half-even where half away from zero is required",
        file: "src/money/decimal.ts",
        from: `return twice >= d ? away : q;`,
        to: `return twice > d || (twice === d && q % 2n !== 0n) ? away : q;`,
    },
    {
        name: "an issued document lists as open whatever was settled",
        file: "src/document/listing.ts",
        from: `(balance(state).status === "settled" ? "settled" : "open")`,
        to: `"open"`,
    },
    {
        name: "a document due today lists as overdue",
        file: "src/document/listing.ts",
        from: `listing.dueDate < c.value`,
        to: `listing.dueDate <= c.value`,
    },
    {
        name: "a credit note loses its invoice's customer",
        file: "src/document/credit.ts",
        from: `...(customer !== undefined && { customer }), currency`,
        to: `currency`,
    },
    {
        name: "a page's cursor repeats its last document",
        file: "src/memory.ts",
        from: `row.seq < filter.before`,
        to: `row.seq <= filter.before`,
    },
    {
        name: "a page at the scan cap ends the list",
        file: "src/document/listing.ts",
        from: `if (found.length === filter.limit || scanned === maxScan) return { rows: found, next: String(last) };`,
        to: `if (found.length === filter.limit) return { rows: found, next: String(last) };
        if (scanned === maxScan) return { rows: found };`,
    },
    {
        name: "a save keeps the listing a document had",
        file: "src/memory.ts",
        from: `put(listings, state.id, { ...listing,`,
        to: `if (expected === undefined) put(listings, state.id, { ...listing,`,
    },
    {
        name: "a number another document holds is issued again",
        file: "src/books.ts",
        from: `if (holder !== undefined && holder !== state.id)`,
        to: `if (false)`,
    },
    {
        name: "a document too large for some backends is accepted",
        file: "src/books.ts",
        from: `if (bytes > MAX_DOCUMENT_BYTES) {`,
        to: `if (false) {`,
    },
    {
        name: "replay reads events written in a newer format",
        file: "src/books.ts",
        from: `if (e.format > EVENT_FORMAT)`,
        to: `if (false)`,
    },
    {
        name: "a pack's rules never fail",
        file: "src/pack.ts",
        from: `return rules.filter((rule) => !holds(rule.check, document));`,
        to: `return [];`,
    },
    {
        name: "a void window that has passed still allows voiding",
        file: "src/pack.ts",
        from: `return hours <= voiding.hours ?`,
        to: `return true ?`,
    },
    {
        name: "parse accepts fields the shape does not have",
        file: "src/schema/dsl.ts",
        from: `if (value[key] !== undefined && !knows(node, key)) {`,
        to: `if (false) {`,
    },
    {
        name: "a decimal field accepts a number",
        file: "src/schema/dsl.ts",
        from: `if (node.format === "decimal" && typeof value === "number") {`,
        to: `if (false) {`,
    },
    {
        name: "a refused command keeps the events it appended",
        file: "src/memory.ts",
        from: `journal?.push(() => (log.length = length));`,
        to: ``,
    },
    {
        name: "the memory store hands out the objects it stores",
        file: "src/memory.ts",
        from: `return doc && copyJson(doc);`,
        to: `return doc;`,
    },
    {
        name: "rebuildListings rewrites nothing",
        file: "src/books.ts",
        from: `await Promise.all(docs.map((doc) => tx.relist(doc.id, listingOf(doc))));`,
        to: ``,
    },
    {
        name: "require counts a blank string as given",
        file: "src/pack.ts",
        from: `if (typeof v === "string") return v.trim() !== "";`,
        to: `if (typeof v === "string") return true;`,
    },
    {
        name: "a decimal may carry whitespace",
        file: "src/money/decimal.ts",
        from: `export const DECIMAL = /^([+-])?(\\d+)(?:\\.(\\d+))?$/;`,
        to: `export const DECIMAL = /^\\s*([+-])?(\\d+)(?:\\.(\\d+))?\\s*$/;`,
    },
    {
        name: "a credit retried with other values returns the first note",
        file: "src/document/credit.ts",
        from: `if (canonical(existingNote.data) !== canonical(creditNoteData(invoice, note.input, ctx))) {`,
        to: `if (false) {`,
    },
    {
        name: "a rule path that cannot be read is accepted",
        file: "src/pack.ts",
        from: `            steps(path, \`\${at}.rules[\${j}].check.\${field}\`);`,
        to: ``,
    },
];

let survived = 0;
for (const m of MUTANTS) {
    const original = readFileSync(m.file, "utf8");
    if (!original.includes(m.from)) throw new Error(`mutant "${m.name}" no longer applies to ${m.file}`);
    writeFileSync(m.file, original.replace(m.from, m.to));
    let killed = false;
    try {
        execFileSync("npx", ["vitest", "run", "--reporter=dot"], { stdio: "pipe" });
    } catch {
        killed = true;
    } finally {
        writeFileSync(m.file, original);
    }
    console.log(`${killed ? "killed  " : "SURVIVED"} ${m.name}`);
    if (!killed) survived++;
}
process.exit(survived ? 1 : 0);
