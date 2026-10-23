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
        from: `sequences = saved.sequences;`,
        to: ``,
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
