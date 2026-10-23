// Recomputes every corpus file and prints each figure that differs from what the file states.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compute, dec } from "../src/index.ts";
import { eu } from "../src/packs/eu.ts";
import { readUbl } from "../test/ubl.ts";

/**
 * "line": recompute from quantities and prices. "document": take each line's
 * stated net as given and recompute everything above it.
 */
export type Level = "line" | "document";

export function diffFile(path: string, level: Level): string[] {
    const { input: parsed, stated } = readUbl(readFileSync(path, "utf8"));
    const input =
        level === "line"
            ? parsed
            : {
                  ...parsed,
                  lines: parsed.lines.map((l, i) => ({ id: l.id, quantity: "1", price: stated.lines[i]!.net, taxes: l.taxes })),
              };
    const out = compute(input, eu.policies.en16931!);
    const diffs: string[] = [];
    const cmp = (label: string, want: string | undefined, got: { toString(): string } | undefined) => {
        if (want === undefined) return;
        if (!got || !dec(want).eq(dec(got.toString()))) diffs.push(`${label}: file ${want}, computed ${got}`);
    };
    stated.lines.forEach((l, i) => cmp(`line ${l.id} net`, l.net, out.lines[i]?.net));
    for (const s of stated.taxes) {
        const mine = out.taxes.find(
            (t) => t.category === s.category && (s.rate === undefined || (t.rate ?? dec("0")).eq(dec(s.rate))),
        );
        cmp(`tax ${s.category} ${s.rate ?? ""} taxable`, s.taxable, mine?.taxable);
        cmp(`tax ${s.category} ${s.rate ?? ""} amount`, s.tax, mine?.tax);
    }
    for (const [k, v] of Object.entries(stated.totals)) cmp(k, v, out.totals[k as keyof typeof out.totals]);
    return diffs;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const dir = new URL("../corpus/", import.meta.url);
    for (const name of readdirSync(dir).sort()) {
        for (const level of ["line", "document"] as const) {
            try {
                const diffs = diffFile(fileURLToPath(new URL(name, dir)), level);
                console.log(`${diffs.length ? "DIFF" : "ok  "} ${level.padEnd(8)} ${name}${diffs.map((d) => `\n       ${d}`).join("")}`);
            } catch (e) {
                console.log(`ERR  ${level.padEnd(8)} ${name}: ${(e as Error).message}`);
            }
        }
    }
}
