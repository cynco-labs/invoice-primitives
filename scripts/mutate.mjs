// Plants known bugs one at a time and requires the test suite to fail on each.
// Usage: node scripts/mutate.mjs   (exits non-zero if any mutant survives)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const MUTANTS = [
    {
        name: "document-level tax one minor unit high",
        file: "src/compute.ts",
        from: `else if (spec.rate !== undefined) t = taxOf(taxable, dec(spec.rate));`,
        to: `else if (spec.rate !== undefined) t = taxOf(taxable, dec(spec.rate)).add(dec("0.01"));`,
    },
    {
        name: "allocation drops its residual",
        file: "src/allocate.ts",
        from: `if (residual === 0n) return parts;`,
        to: `return parts;`,
    },
    {
        name: "inclusive nets allocated by signed weight (a sale and its return zero out)",
        file: "src/compute.ts",
        from: `const nets = inclusive.map((x) => x.sub(extract(x)));
            const moved = allocate(g.taxable.sub(Decimal.sum(nets)), inclusive.map((x) => x.abs()), scale);
            members.forEach((line, k) => (line.net = nets[k]!.add(moved[k]!)));`,
        to: `const nets = allocate(g.taxable, inclusive, scale);
            members.forEach((line, k) => (line.net = nets[k]!));`,
    },
    {
        name: "stated BT-114 silently drops the reconciled residual",
        file: "src/compute.ts",
        from: `if (!residual.isZero()) {`,
        to: `if (false) {`,
    },
    {
        name: "issue freezes the caller's input",
        file: "src/lifecycle.ts",
        from: `const input = structuredClone(d.input);`,
        to: `const input = d.input;`,
    },
    {
        name: "half-even where half away from zero is required",
        file: "src/decimal.ts",
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
